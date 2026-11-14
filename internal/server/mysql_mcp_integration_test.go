package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// This fixture uses the production SQLStore and the actual MCP HTTP transport.
// Only the external authorization server and Taskly service are boundaries.
type mysqlMCPFixture struct {
	*mysqlAPIFixture
	auth                                *httptest.Server
	mu                                  sync.Mutex
	revoked                             bool
	introspectionStatus, exchangeStatus int
	introspectionBody, exchangeBody     string
	exchanges                           int
}

func newMySQLMCPFixture(t *testing.T) *mysqlMCPFixture {
	t.Helper()
	f := &mysqlMCPFixture{mysqlAPIFixture: newMySQLAPIFixture(t)}
	f.api.Close() // The browser fixture's API is never requested by these tests.
	f.auth = httptest.NewServer(http.HandlerFunc(f.serveAuth))
	t.Cleanup(f.auth.Close)
	f.api = httptest.NewUnstartedServer(nil)
	f.cfg.APIOrigin = "http://" + f.api.Listener.Addr().String()
	f.cfg.AuthIssuer = f.auth.URL
	f.cfg.MCPEnabled = true
	f.cfg.MCPBackendSecret = strings.Repeat("x", 32)
	var err error
	f.app, err = New(f.cfg, SQLStore{DB: f.db}, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.api.Config.Handler = f.app.Handler()
	f.api.Start()
	t.Cleanup(f.api.Close)
	for subject, number := range map[string]int{"123": 7, "456": 8} {
		if err := (SQLStore{DB: f.db}).SetPreference(context.Background(), subject, number); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.db.Exec("UPDATE guidance_dataset SET payload=? WHERE id=1", strings.ReplaceAll(mysqlCoverageDataset, `"industries":[]`, `"industries":["Software"]`)); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *mysqlMCPFixture) serveAuth(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	client, secret, ok := r.BasicAuth()
	if r.Method != "POST" || !ok || client != mcpBackendClientID || secret != strings.Repeat("x", 32) || r.ParseForm() != nil {
		w.WriteHeader(401)
		return
	}
	token := r.Form.Get("token")
	if r.URL.Path == "/oauth/token" {
		token = r.Form.Get("subject_token")
	}
	subject, scope := "123", "guidance:read guidance:bookmarks:write guidance:tasks:write"
	if token == "synthetic-mcp-other" {
		subject = "456"
	}
	if token == "synthetic-mcp-read" {
		scope = "guidance:read"
	}
	if token != "synthetic-mcp-parent" && token != "synthetic-mcp-other" && token != "synthetic-mcp-read" {
		json.NewEncoder(w).Encode(map[string]any{"active": false})
		return
	}
	switch r.URL.Path {
	case "/oauth/introspect":
		if r.Form.Get("token_type_hint") != "access_token" {
			w.WriteHeader(400)
			return
		}
		if f.introspectionStatus != 0 {
			w.WriteHeader(f.introspectionStatus)
			io.WriteString(w, f.introspectionBody)
			return
		}
		if f.introspectionBody != "" {
			io.WriteString(w, f.introspectionBody)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"active": !f.revoked, "sub": subject, "scope": scope, "client_id": mcpPublicClientID, "iss": f.auth.URL, "aud": f.cfg.APIOrigin + "/mcp", "exp": time.Now().Add(15 * time.Minute).Unix(), "token_type": "Bearer"})
	case "/oauth/token":
		if r.Form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:token-exchange" || r.Form.Get("subject_token_type") != exchangedAccessType || r.Form.Get("requested_token_type") != exchangedAccessType || r.Form.Get("resource") != f.taskly.URL+"/integrations/nnct-guidance/tasks" || (r.Form.Get("scope") != "guidance:tasks:read" && r.Form.Get("scope") != "guidance:tasks:write") || f.revoked {
			w.WriteHeader(400)
			return
		}
		f.exchanges++
		if f.exchangeStatus != 0 {
			w.WriteHeader(f.exchangeStatus)
			io.WriteString(w, f.exchangeBody)
			return
		}
		if f.exchangeBody != "" {
			io.WriteString(w, f.exchangeBody)
			return
		}
		delegated := "synthetic-delegated-" + subject + "-" + r.Form.Get("scope")
		// Parent MCP tokens deliberately never enter Taskly's accepted-token map.
		f.mysqlAPIFixture.mu.Lock()
		f.accesses[delegated] = subject
		f.mysqlAPIFixture.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"access_token": delegated, "token_type": "Bearer", "expires_in": 60, "issued_token_type": exchangedAccessType, "scope": r.Form.Get("scope")})
	default:
		w.WriteHeader(404)
	}
}

type mysqlMCPTransport struct{ token string }

func (rt mysqlMCPTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.Header = r.Header.Clone()
	clone.Header.Set("Authorization", "Bearer "+rt.token)
	return http.DefaultTransport.RoundTrip(clone)
}
func (f *mysqlMCPFixture) connect(t *testing.T, token string) *mcp.ClientSession {
	t.Helper()
	client := mcp.NewClient(&mcp.Implementation{Name: "synthetic-mysql-integration", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, err := client.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: f.api.URL + "/mcp", HTTPClient: &http.Client{Transport: mysqlMCPTransport{token: token}, Timeout: 10 * time.Second}, MaxRetries: -1, DisableStandaloneSSE: true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { session.Close() })
	return session
}
func mysqlMCPCall(t *testing.T, session *mcp.ClientSession, name string, args map[string]any, output any) *mcp.CallToolResult {
	t.Helper()
	if args == nil {
		args = map[string]any{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s transport: %v", name, err)
	}
	if output != nil {
		if result.IsError {
			t.Fatalf("%s failed: %v", name, result.Content)
		}
		payload, err := json.Marshal(result.StructuredContent)
		if err != nil {
			t.Fatal(err)
		}
		if err = json.Unmarshal(payload, output); err != nil {
			t.Fatalf("%s output: %v", name, err)
		}
		for _, forbidden := range []string{"synthetic-mcp-", "synthetic-delegated-", "synthetic.pdf", "X-Amz-", "assignment_scope", "user_sub"} {
			if strings.Contains(string(payload), forbidden) {
				t.Fatalf("%s exposed private implementation data", name)
			}
		}
	}
	return result
}
func mysqlMCPError(t *testing.T, result *mcp.CallToolResult, status int) {
	t.Helper()
	if !result.IsError || fmt.Sprint(result.Meta["status"]) != fmt.Sprint(status) {
		t.Fatalf("expected tool error %d, got %+v", status, result)
	}
	if result.StructuredContent != nil {
		t.Fatal("failed tool fabricated structured success")
	}
}

func TestMySQLMCPCatalogAndBookmarks(t *testing.T) {
	f := newMySQLMCPFixture(t)
	alice := f.connect(t, "synthetic-mcp-parent")
	bob := f.connect(t, "synthetic-mcp-other")
	tools, err := alice.ListTools(context.Background(), nil)
	if err != nil || len(tools.Tools) != 8 {
		t.Fatalf("8 real HTTP tools expected: %v", err)
	}
	for _, tool := range tools.Tools {
		if tool.Meta["securitySchemes"] == nil || tool.InputSchema == nil || tool.OutputSchema == nil {
			t.Fatalf("missing tool contract %s", tool.Name)
		}
	}
	var profile mcpProfileOutput
	mysqlMCPCall(t, alice, "get_profile", nil, &profile)
	if profile.ID != "123" {
		t.Fatal("wrong verified identity")
	}
	var search mcpSearchOutput
	mysqlMCPCall(t, alice, "search_companies", map[string]any{"limit": 1}, &search)
	if search.Total != 2 || len(search.Companies) != 1 || search.NextOffset == nil || *search.NextOffset != 1 {
		t.Fatal("SQL catalog pagination mismatch")
	}
	search = mcpSearchOutput{}
	mysqlMCPCall(t, alice, "search_companies", map[string]any{"offset": 1, "limit": 1}, &search)
	if len(search.Companies) != 1 || search.Companies[0].ID != "AM-2" || search.NextOffset != nil {
		t.Fatal("second SQL catalog page mismatch")
	}
	for _, args := range []map[string]any{{"query": "Beta"}, {"session": "AM"}, {"session": "PM"}, {"industries": []string{"Software"}}, {"industries": []string{"missing"}}, {"offset": 5000}} {
		mysqlMCPCall(t, alice, "search_companies", args, &search)
	}
	var favorite mcpFavoriteOutput
	for i := 0; i < 2; i++ {
		mysqlMCPCall(t, alice, "set_favorite", map[string]any{"company_id": "AM-1", "favorite": true}, &favorite)
	}
	ids, err := (SQLStore{DB: f.db}).Bookmarks(context.Background(), "123")
	if err != nil || len(ids) != 1 || ids[0] != "AM-1" {
		t.Fatal("idempotent bookmark did not persist")
	}
	var company mcpCompanyOutput
	mysqlMCPCall(t, alice, "get_company", map[string]any{"company_id": "AM-1"}, &company)
	if !company.Company.Favorite || !strings.HasSuffix(company.Company.URL, "/?company=AM-1") || !strings.Contains(company.Company.MapURL, "focus=AM-1") {
		t.Fatal("bookmark/deep link mismatch")
	}
	mysqlMCPCall(t, bob, "get_company", map[string]any{"company_id": "AM-1"}, &company)
	if company.Company.Favorite {
		t.Fatal("cross-account bookmark exposure")
	}
	mysqlMCPCall(t, alice, "search_companies", map[string]any{"favorites_only": true}, &search)
	if search.Total != 1 {
		t.Fatal("own favorites filter mismatch")
	}
	mysqlMCPCall(t, bob, "search_companies", map[string]any{"favorites_only": true}, &search)
	if search.Total != 0 {
		t.Fatal("favorites filter crossed accounts")
	}
	for _, entry := range []struct {
		session *mcp.ClientSession
		company string
	}{{alice, "AM-1"}, {bob, "AM-2"}} {
		var guidance mcpMyGuidanceOutput
		mysqlMCPCall(t, entry.session, "get_my_guidance", nil, &guidance)
		if !guidance.RosterConfigured || len(guidance.Visits) != 1 || guidance.Visits[0].CompanyID != entry.company {
			t.Fatal("roster assignment crossed accounts")
		}
	}
	var docs mcpDocumentsOutput
	mysqlMCPCall(t, alice, "list_documents", nil, &docs)
	if len(docs.Documents) != 1 || docs.Documents[0].URL != f.cfg.UIOrigin+"/documents/" {
		t.Fatal("documents must use stable UI links")
	}
	mysqlMCPCall(t, alice, "set_favorite", map[string]any{"company_id": "AM-1", "favorite": false}, &favorite)
	ids, err = (SQLStore{DB: f.db}).Bookmarks(context.Background(), "123")
	if err != nil || len(ids) != 0 {
		t.Fatal("bookmark removal did not persist")
	}
	mysqlMCPError(t, mysqlMCPCall(t, alice, "get_company", map[string]any{"company_id": "missing"}, nil), 404)
	mysqlMCPError(t, mysqlMCPCall(t, alice, "set_favorite", map[string]any{"company_id": "missing", "favorite": true}, nil), 404)
	// A client cannot select another subject or inject arbitrary document URLs.
	invalid, err := alice.CallTool(context.Background(), &mcp.CallToolParams{Name: "set_favorite", Arguments: map[string]any{"company_id": "AM-1", "favorite": true, "user_sub": "456"}})
	if err != nil || !invalid.IsError {
		t.Fatal("unknown identity argument accepted")
	}
	ids, _ = (SQLStore{DB: f.db}).Bookmarks(context.Background(), "456")
	if len(ids) != 0 {
		t.Fatal("invalid input modified another account")
	}
}

func TestMySQLMCPHomeCanonicalPairs(t *testing.T) {
	f := newMySQLMCPFixture(t)
	alice := f.connect(t, "synthetic-mcp-parent")
	bob := f.connect(t, "synthetic-mcp-other")
	var home mcpHomeOutput
	mysqlMCPCall(t, alice, "get_home_tasks", nil, &home)
	if !home.RosterConfigured || len(home.Tasks) != 5 || home.EventID != "synthetic-event" {
		t.Fatal("canonical home shape mismatch")
	}
	set := func(session *mcp.ClientSession, key string, completed bool) mcpHomeUpdate {
		var out mcpHomeUpdate
		mysqlMCPCall(t, session, "set_home_task_completed", map[string]any{"task_id": key, "completed": completed}, &out)
		return out
	}
	paired := set(alice, "visit-survey-1", true)
	if !paired.Completed || len(paired.RelatedTasks) != 1 || !paired.RelatedTasks[0].Completed || paired.RelatedTasks[0].AutoCompletedBy != "visit-survey-1" {
		t.Fatal("forward pair lost authoritative metadata")
	}
	paired = set(alice, "assigned-visit-1", false)
	if paired.Completed || len(paired.RelatedTasks) != 1 || paired.RelatedTasks[0].Completed {
		t.Fatal("reverse owned pair did not undo both")
	}
	f.nativeTask("123", "assigned-visit-1", true)
	set(alice, "visit-survey-1", true)
	paired = set(alice, "visit-survey-1", false)
	if len(paired.RelatedTasks) != 1 || !paired.RelatedTasks[0].Completed || paired.RelatedTasks[0].AutoCompletedBy != "" {
		t.Fatal("preexisting manual mark lost")
	}
	f.nativeTask("123", "assigned-visit-1", false)
	set(alice, "visit-survey-1", true)
	f.nativeTask("123", "visit-survey-1", true)
	paired = set(alice, "assigned-visit-1", false)
	if len(paired.RelatedTasks) != 1 || !paired.RelatedTasks[0].Completed {
		t.Fatal("native manual source reconfirm was undone")
	}
	set(alice, "visit-survey-1", false)
	set(alice, "visit-survey-1", true)
	if err := (SQLStore{DB: f.db}).SetPreference(context.Background(), "123", 8); err != nil {
		t.Fatal(err)
	}
	paired = set(alice, "assigned-visit-1", false)
	if len(paired.RelatedTasks) != 1 || !paired.RelatedTasks[0].Completed {
		t.Fatal("old roster scope undid new roster survey")
	}
	mysqlMCPCall(t, bob, "get_home_tasks", nil, &home)
	for _, task := range home.Tasks {
		if task.Completed {
			t.Fatal("canonical completion crossed accounts")
		}
	}
	f.mysqlAPIFixture.mu.Lock()
	for _, parent := range []string{"synthetic-mcp-parent", "synthetic-mcp-other"} {
		if f.accesses[parent] != "" {
			t.Fatal("MCP parent token was passed to Taskly")
		}
	}
	f.mysqlAPIFixture.mu.Unlock()
	mysqlMCPError(t, mysqlMCPCall(t, alice, "set_home_task_completed", map[string]any{"task_id": "not-configured", "completed": true}, nil), 404)
	if _, err := f.db.Exec("DELETE FROM guidance_preferences WHERE user_sub='456'"); err != nil {
		t.Fatal(err)
	}
	mysqlMCPCall(t, bob, "get_my_guidance", nil, new(mcpMyGuidanceOutput))
	mysqlMCPCall(t, bob, "get_home_tasks", nil, &home)
	if home.RosterConfigured {
		t.Fatal("missing SQL roster was fabricated")
	}
}

func TestMySQLMCPScopeAndLiveAuthorization(t *testing.T) {
	f := newMySQLMCPFixture(t)
	read := f.connect(t, "synthetic-mcp-read")
	for _, call := range []struct {
		name string
		args map[string]any
	}{{"set_favorite", map[string]any{"company_id": "AM-1", "favorite": true}}, {"set_home_task_completed", map[string]any{"task_id": "overall-survey", "completed": true}}} {
		result := mysqlMCPCall(t, read, call.name, call.args, nil)
		mysqlMCPError(t, result, 403)
		if result.Meta["mcp/www_authenticate"] == nil {
			t.Fatal("missing scope escalation challenge")
		}
	}
	ids, err := (SQLStore{DB: f.db}).Bookmarks(context.Background(), "123")
	if err != nil || len(ids) != 0 {
		t.Fatal("read scope mutated SQL bookmarks")
	}
	f.mu.Lock()
	exchanges := f.exchanges
	f.mu.Unlock()
	if exchanges != 0 {
		t.Fatal("insufficient scope attempted downstream exchange")
	}
	alice := f.connect(t, "synthetic-mcp-parent")
	f.mu.Lock()
	f.revoked = true
	f.mu.Unlock()
	if _, err := alice.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_profile", Arguments: map[string]any{}}); err == nil {
		t.Fatal("revoked token survived connected session")
	}
	for _, headers := range []map[string]string{{"Cookie": "guidance_session=not-an-MCP-token"}, {"Cookie": "guidance_session=not-an-MCP-token", "Authorization": "Bearer synthetic-mcp-parent"}} {
		req, _ := http.NewRequest("POST", f.api.URL+"/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/list"}`))
		for key, value := range headers {
			req.Header.Set(key, value)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 401 || resp.Header.Get("WWW-Authenticate") == "" || resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("cookie authorized MCP or challenge missing")
		}
	}
}

func TestMySQLMCPDependencyFailures(t *testing.T) {
	f := newMySQLMCPFixture(t)
	alice := f.connect(t, "synthetic-mcp-parent")
	for _, status := range []int{400, 401, 403, 503} {
		f.mu.Lock()
		f.exchangeStatus = status
		f.mu.Unlock()
		want := 503
		if status < 500 {
			want = 401
		}
		result := mysqlMCPCall(t, alice, "get_home_tasks", nil, nil)
		mysqlMCPError(t, result, want)
		if want == 401 && result.Meta["mcp/www_authenticate"] == nil {
			t.Fatal("exchange denial missing reauthorization challenge")
		}
	}
	f.mu.Lock()
	f.exchangeStatus = 0
	f.exchangeBody = `{"access_token":"invalid","token_type":"Bearer","expires_in":3600}`
	f.mu.Unlock()
	mysqlMCPError(t, mysqlMCPCall(t, alice, "get_home_tasks", nil, nil), 503)
	f.mu.Lock()
	f.exchangeBody = ""
	f.mu.Unlock()
	for _, status := range []int{401, 403, 409, 503} {
		f.mysqlAPIFixture.mu.Lock()
		f.tasklyStatus = status
		f.mysqlAPIFixture.mu.Unlock()
		mysqlMCPError(t, mysqlMCPCall(t, alice, "get_home_tasks", nil, nil), status)
	}
	f.mysqlAPIFixture.mu.Lock()
	f.tasklyStatus = 0
	f.tasklyPayload = `{"event_id":"wrong","tasks":[]}`
	f.mysqlAPIFixture.mu.Unlock()
	mysqlMCPError(t, mysqlMCPCall(t, alice, "get_home_tasks", nil, nil), 503)
	f.mysqlAPIFixture.mu.Lock()
	f.tasklyPayload = ""
	f.mysqlAPIFixture.mu.Unlock()
	for _, entry := range []struct {
		table, tool string
		args        map[string]any
	}{{"guidance_bookmarks", "search_companies", nil}, {"guidance_bookmarks", "set_favorite", map[string]any{"company_id": "AM-1", "favorite": true}}, {"guidance_preferences", "get_my_guidance", nil}, {"guidance_dataset", "list_documents", nil}} {
		t.Run(entry.table+"_"+entry.tool, func(t *testing.T) {
			if _, err := f.db.Exec("RENAME TABLE " + entry.table + " TO " + entry.table + "_mcp_unavailable"); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if _, err := f.db.Exec("RENAME TABLE " + entry.table + "_mcp_unavailable TO " + entry.table); err != nil {
					t.Error(err)
				}
			}()
			mysqlMCPError(t, mysqlMCPCall(t, alice, entry.tool, entry.args, nil), 503)
		})
	}
	if _, err := f.db.Exec("UPDATE guidance_dataset SET payload=? WHERE id=1", `{"event":{"title":"Broken"},"companies":[{"id":"AM-1"}],"documents":[]}`); err != nil {
		t.Fatal(err)
	}
	mysqlMCPError(t, mysqlMCPCall(t, alice, "search_companies", nil, nil), 503)
	f.mu.Lock()
	f.introspectionStatus = 503
	f.mu.Unlock()
	if _, err := alice.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_profile", Arguments: map[string]any{}}); err == nil {
		t.Fatal("provider outage fabricated an identity")
	}
}
