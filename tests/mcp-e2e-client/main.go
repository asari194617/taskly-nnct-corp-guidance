package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-sql-driver/mysql"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	authOrigin     = "http://127.0.0.1:34567"
	uiOrigin       = "http://127.0.0.1:34568"
	tasklyOrigin   = "http://127.0.0.1:34574"
	guidanceOrigin = "http://127.0.0.1:34571"
	callback       = "http://127.0.0.1:34569/callback"
	backendID      = "nnct-guidance-mcp-backend"
	publicID       = "nnct-guidance-chatgpt"
	mainID         = "taskly-e2e"
	secret         = "synthetic-mcp-backend-only-not-production-123456"
	mainSecret     = "synthetic-main-client-only-not-production-123456"
	password       = "Synthetic-password-only-123!"
	fullScope      = "guidance:read guidance:bookmarks:write guidance:tasks:write"
)

var reports = []map[string]any{}

func check(ok bool, label string) {
	if !ok {
		panic(label)
	}
}
func pass(label string) {
	reports = append(reports, map[string]any{"name": label, "passed": true})
	fmt.Println("PASS " + label)
}
func must(err error, label string) {
	if err != nil {
		panic(label + ": " + err.Error())
	}
}

// These are fixed disposable names; callers cannot supply an application DSN.
func db(name string) *sql.DB {
	if name != "" && name != "taskly_auth_mcp_test" && name != "guidance_mcp_e2e" && name != "taskly_guidance_e2e" {
		panic("non-test database rejected")
	}
	host, port := os.Getenv("MCP_E2E_MYSQL_HOST"), os.Getenv("MCP_E2E_MYSQL_PORT")
	if host != "127.0.0.1" || strings.EqualFold(strings.TrimSpace(os.Getenv("NODE_ENV")), "production") {
		panic("only disposable loopback MySQL is allowed")
	}
	n, err := strconv.Atoi(port)
	must(err, "MySQL port")
	check(n > 0 && n <= 65535, "MySQL port range")
	cfg := mysql.NewConfig()
	cfg.User = os.Getenv("MCP_E2E_MYSQL_USER")
	cfg.Passwd = os.Getenv("MCP_E2E_MYSQL_PASSWORD")
	check(cfg.User != "" && cfg.Passwd != "", "synthetic database credentials required")
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(host, port)
	cfg.DBName = name
	cfg.ParseTime = true
	cfg.Loc = time.UTC
	cfg.MultiStatements = true
	cfg.Params = map[string]string{"time_zone": "'+00:00'"}
	d, e := sql.Open("mysql", cfg.FormatDSN())
	must(e, "open isolated database")
	return d
}

func ddl(d *sql.DB, path string) {
	b, e := os.ReadFile(path)
	must(e, "read schema")
	_, e = d.Exec(string(b))
	must(e, "apply schema")
}
func seed() {
	d := db("")
	defer d.Close()
	for _, n := range []string{"taskly_auth_mcp_test", "guidance_mcp_e2e", "taskly_guidance_e2e"} {
		_, e := d.Exec("CREATE DATABASE IF NOT EXISTS " + n + " CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci")
		must(e, "create dedicated database")
		var tables int
		must(d.QueryRow("SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=?", n).Scan(&tables), "verify disposable database")
		check(tables == 0, "refusing nonempty test database; prepare a fresh disposable service")
	}
	a := db("taskly_auth_mcp_test")
	defer a.Close()
	ddl(a, os.Getenv("MCP_E2E_AUTH_DIR")+"/schema.sql")
	// Fixed bcrypt hash of the fake fixture password above; no production credentials.
	hash := "$2y$10$87xmr7kG.GyQJXx5xVkol.Xdu8qAeotLIPTVZ.LkB8NbSYV7DOPPa"
	var e error
	for _, id := range []int{1001, 1002, 1013} {
		_, e = a.Exec("INSERT INTO users(id,email,display_name,hashed_password,email_code_allowed,is_registered,is_agreed_policies) VALUES(?,?,?,?,false,true,true)", id, fmt.Sprintf("mcp-%d@synthetic.example.test", id), "Synthetic MCP account", hash)
		must(e, "seed synthetic auth account")
	}
	g := db("guidance_mcp_e2e")
	defer g.Close()
	ddl(g, os.Getenv("MCP_E2E_GUIDANCE_DIR")+"/schema.sql")
	dataset := `{"event":{"title":"Synthetic MCP cross-service event","task_actions":{"visit_survey":{"url":"https://forms.example.test/visit"},"overall_survey":{"url":"https://forms.example.test/overall"},"sheet_submission":{"document_id":"guide","page":25}}},"companies":[{"id":"AM-1","name":"Synthetic Alpha","session":"AM","booth":1,"industries":["Software"]},{"id":"AM-2","name":"Synthetic Beta","session":"AM","booth":2,"industries":["Software"]}],"schedule":[{"term":1},{"term":2}],"assignments":[{"department":"電子制御工学科","grade":4,"number":7,"visits":[{"term":1,"company_id":"AM-1"}]},{"department":"電子制御工学科","grade":4,"number":8,"visits":[{"term":1,"company_id":"AM-2"}]}],"documents":[{"id":"guide","title":"Synthetic guide","mime_type":"application/pdf"}],"notices":[]}`
	_, e = g.Exec("INSERT INTO guidance_dataset(id,payload) VALUES(1,?)", dataset)
	must(e, "seed synthetic catalog")
	_, e = g.Exec("INSERT INTO guidance_documents(id,file_name,mime_type,title) VALUES('guide','synthetic.pdf','application/pdf','Synthetic guide')")
	must(e, "seed document metadata")
	for id, n := range map[string]int{"1001": 7, "1002": 8, "1013": 7} {
		_, e = g.Exec("INSERT INTO guidance_preferences(user_sub,roster_number) VALUES(?,?)", id, n)
		must(e, "seed roster preference")
	}
}
func random() string {
	b := make([]byte, 32)
	_, e := rand.Read(b)
	must(e, "random")
	return base64.RawURLEncoding.EncodeToString(b)
}
func client() *http.Client {
	j, e := cookiejar.New(nil)
	must(e, "cookie jar")
	return &http.Client{Jar: j, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func request(c *http.Client, method, endpoint string, body any, h map[string]string) (int, map[string]any, http.Header) {
	var reader io.Reader
	if body != nil {
		switch v := body.(type) {
		case url.Values:
			reader = strings.NewReader(v.Encode())
			if h == nil {
				h = map[string]string{}
			}
			h["Content-Type"] = "application/x-www-form-urlencoded"
		default:
			b, e := json.Marshal(body)
			must(e, "encode request")
			reader = strings.NewReader(string(b))
			if h == nil {
				h = map[string]string{}
			}
			h["Content-Type"] = "application/json"
		}
	}
	r, e := http.NewRequest(method, endpoint, reader)
	must(e, "request")
	for k, v := range h {
		r.Header.Set(k, v)
	}
	res, e := c.Do(r)
	must(e, "HTTP "+method+" "+strings.Split(endpoint, "?")[0])
	defer res.Body.Close()
	b, e := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	must(e, "response read")
	out := map[string]any{}
	_ = json.Unmarshal(b, &out)
	return res.StatusCode, out, res.Header
}
func basic(id, s string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(id+":"+s))
}
func uiHeaders() map[string]string { return map[string]string{"Origin": uiOrigin, "X-Auth-UI": "1"} }
func form(v url.Values) (int, map[string]any) {
	s, b, _ := request(client(), "POST", authOrigin+"/oauth/token", v, nil)
	return s, b
}

type tokens struct{ access, refresh string }

func login(id int, scope string) tokens {
	c := client()
	verifier, state := random(), random()
	h := sha256.Sum256([]byte(verifier))
	q := url.Values{"client_id": {publicID}, "redirect_uri": {callback}, "response_type": {"code"}, "code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(h[:])}, "state": {state}, "scope": {scope}, "resource": {guidanceOrigin + "/mcp"}}
	status, _, headers := request(c, "GET", authOrigin+"/oauth/authorize?"+q.Encode(), nil, nil)
	check(status == 302 && strings.HasPrefix(headers.Get("Location"), uiOrigin+"/login?"), "unauthenticated authorization must require login")
	u, e := url.Parse(headers.Get("Location"))
	must(e, "login redirect")
	rid := u.Query().Get("request_id")
	check(rid != "", "request id")
	status, _, _ = request(c, "POST", authOrigin+"/auth/login", map[string]any{"email": fmt.Sprintf("mcp-%d@synthetic.example.test", id), "password": password}, uiHeaders())
	check(status == 200, "real password login")
	status, _, headers = request(c, "GET", authOrigin+"/oauth/authorize?request_id="+url.QueryEscape(rid), nil, nil)
	check(status == 302 && strings.HasPrefix(headers.Get("Location"), uiOrigin+"/consent?"), "explicit consent required")
	status, consent, _ := request(c, "GET", authOrigin+"/oauth/consent?request_id="+url.QueryEscape(rid), nil, uiHeaders())
	check(status == 200 && consent["resource"] == guidanceOrigin+"/mcp", "consent bound to guidance resource")
	body := map[string]any{"request_id": rid, "csrf_token": consent["csrf_token"], "approve": true}
	status, approval, _ := request(c, "POST", authOrigin+"/oauth/consent", body, uiHeaders())
	check(status == 200, "explicit consent approval")
	status, _, _ = request(c, "POST", authOrigin+"/oauth/consent", body, uiHeaders())
	check(status == 400, "one-time consent replay rejected")
	redirect, e := url.Parse(approval["redirect_uri"].(string))
	must(e, "consent callback")
	check(redirect.Scheme+"://"+redirect.Host+redirect.Path == callback && redirect.Query().Get("state") == state && redirect.Query().Get("iss") == authOrigin, "callback issuer/state/client binding")
	exchange := url.Values{"client_id": {publicID}, "grant_type": {"authorization_code"}, "code": {redirect.Query().Get("code")}, "code_verifier": {verifier}, "redirect_uri": {callback}, "resource": {tasklyOrigin + "/integrations/nnct-guidance/tasks"}}
	status, _ = form(exchange)
	check(status == 400, "code wrong resource rejected")
	exchange.Set("resource", guidanceOrigin+"/mcp")
	exchange.Set("code_verifier", random())
	status, _ = form(exchange)
	check(status == 400, "wrong PKCE rejected")
	exchange.Set("code_verifier", verifier)
	status, out := form(exchange)
	check(status == 200, "real resource/PKCE code exchange")
	status, _ = form(exchange)
	check(status == 400, "one-time code replay rejected")
	access, _ := out["access_token"].(string)
	refresh, _ := out["refresh_token"].(string)
	check(access != "" && refresh != "", "parent tokens issued")
	return tokens{access, refresh}
}

type bearerTransport struct{ token string }

func (t bearerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header = r.Header.Clone()
	r.Header.Set("Authorization", "Bearer "+t.token)
	return http.DefaultTransport.RoundTrip(r)
}
func connect(token string) *mcp.ClientSession {
	c := mcp.NewClient(&mcp.Implementation{Name: "real-three-repo-e2e", Version: "1"}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s, e := c.Connect(ctx, &mcp.StreamableClientTransport{Endpoint: guidanceOrigin + "/mcp", HTTPClient: &http.Client{Transport: bearerTransport{token}, Timeout: 10 * time.Second}, MaxRetries: -1, DisableStandaloneSSE: true}, nil)
	must(e, "official SDK initialize")
	return s
}
func call(s *mcp.ClientSession, name string, args map[string]any, expected int) map[string]any {
	if args == nil {
		args = map[string]any{}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	r, e := s.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	must(e, name+" transport")
	if expected != 0 {
		check(r.IsError && fmt.Sprint(r.Meta["status"]) == fmt.Sprint(expected), name+" must reject with expected status")
		return nil
	}
	check(!r.IsError, name+" tool success")
	b, e := json.Marshal(r.StructuredContent)
	must(e, "tool result")
	for _, forbidden := range []string{"access_token", "refresh_token", "X-Amz-", "assignment_scope", "user_sub"} {
		check(!strings.Contains(string(b), forbidden), "tool must not disclose private token/provenance")
	}
	out := map[string]any{}
	must(json.Unmarshal(b, &out), "tool output")
	return out
}
func inspect(token string, service bool) map[string]any {
	id, s := mainID, mainSecret
	if service {
		id, s = backendID, secret
	}
	status, out, _ := request(client(), "POST", authOrigin+"/oauth/introspect", url.Values{"token": {token}}, map[string]string{"Authorization": basic(id, s)})
	check(status == 200, "real introspection")
	return out
}
func delegate(parent, scope string) (int, map[string]any) {
	s, b, _ := request(client(), "POST", authOrigin+"/oauth/token", url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:token-exchange"}, "subject_token_type": {"urn:ietf:params:oauth:token-type:access_token"}, "requested_token_type": {"urn:ietf:params:oauth:token-type:access_token"}, "subject_token": {parent}, "resource": {tasklyOrigin + "/integrations/nnct-guidance/tasks"}, "scope": {scope}}, map[string]string{"Authorization": basic(backendID, secret)})
	return s, b
}
func count(user, task int) int {
	d := db("taskly_guidance_e2e")
	defer d.Close()
	var n int
	must(d.QueryRow("SELECT COUNT(*) FROM tasks_users_completions WHERE user_id=? AND task_id=?", user, task).Scan(&n), "canonical completion count")
	return n
}
func run() {
	anonStatus, _, headers := request(client(), "POST", guidanceOrigin+"/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}}, nil)
	check(anonStatus == 401 && strings.Contains(headers.Get("WWW-Authenticate"), "resource_metadata"), "anonymous MCP challenge")
	pass("anonymous MCP returns OAuth metadata challenge")
	a := login(1001, fullScope)
	pass("real password login, explicit one-time consent, PKCE and resource-bound code redemption")
	alice := connect(a.access)
	defer alice.Close()
	tools, e := alice.ListTools(context.Background(), nil)
	must(e, "official SDK list tools")
	check(len(tools.Tools) == 8, "eight tools")
	pass("official Go SDK initializes and lists eight actual HTTP tools")
	profile := call(alice, "get_profile", nil, 0)
	check(profile["id"] == "1001", "profile uses parent verified identity without userinfo")
	pass("get_profile resolves actual AS parent subject")
	search := call(alice, "search_companies", map[string]any{"query": "Alpha", "limit": 1}, 0)
	check(search["total"] == float64(1), "search SQL result")
	company := call(alice, "get_company", map[string]any{"company_id": "AM-1"}, 0)["company"].(map[string]any)
	check(strings.Contains(company["map_url"].(string), "focus=AM-1"), "map stable link")
	pass("search and company details use real Guidance SQL catalog")
	my := call(alice, "get_my_guidance", nil, 0)
	visits := my["visits"].([]any)
	check(my["roster_configured"] == true && len(visits) == 1 && visits[0].(map[string]any)["company_id"] == "AM-1", "own assigned company")
	docs := call(alice, "list_documents", nil, 0)["documents"].([]any)
	check(len(docs) == 1 && docs[0].(map[string]any)["url"] == uiOrigin+"/documents/", "document stable UI URL only")
	pass("own guidance assignment and fixed document web links")
	call(alice, "set_favorite", map[string]any{"company_id": "AM-1", "favorite": true}, 0)
	call(alice, "set_favorite", map[string]any{"company_id": "AM-1", "favorite": true}, 0)
	g := db("guidance_mcp_e2e")
	defer g.Close()
	var n int
	must(g.QueryRow("SELECT COUNT(*) FROM guidance_bookmarks WHERE user_sub='1001' AND company_id='AM-1'").Scan(&n), "favorite SQL")
	check(n == 1, "favorite idempotent persisted")
	b := login(1002, fullScope)
	bob := connect(b.access)
	defer bob.Close()
	check(call(bob, "search_companies", map[string]any{"favorites_only": true}, 0)["total"] == float64(0), "other user favorites isolated")
	check(call(bob, "get_my_guidance", nil, 0)["visits"].([]any)[0].(map[string]any)["company_id"] == "AM-2", "other roster isolation")
	pass("favorite idempotence persists in SQL and account/roster data stays isolated")
	home := call(alice, "get_home_tasks", nil, 0)
	check(home["event_id"] == "synthetic-guidance-2030" && len(home["tasks"].([]any)) == 5, "actual Taskly-backed home task shape")
	pass("get_home_tasks exchanges an actual child token and reads canonical Taskly tasks")
	pair := call(alice, "set_home_task_completed", map[string]any{"task_id": "visit-survey-1", "completed": true}, 0)
	related := pair["related_tasks"].([]any)
	check(pair["completed"] == true && len(related) == 1 && related[0].(map[string]any)["completed"] == true && count(1001, 5001) == 1 && count(1001, 5009) == 1 && count(1002, 5001) == 0, "atomic canonical pair persisted")
	pass("survey write creates both canonical completions atomically without another user change")
	pair = call(alice, "set_home_task_completed", map[string]any{"task_id": "visit-survey-1", "completed": false}, 0)
	check(pair["completed"] == false && pair["related_tasks"].([]any)[0].(map[string]any)["completed"] == false && count(1001, 5001) == 0 && count(1001, 5009) == 0, "forward survey undo removes canonical pair")
	pair = call(alice, "set_home_task_completed", map[string]any{"task_id": "visit-survey-1", "completed": true}, 0)
	check(pair["completed"] == true && count(1001, 5001) == 1 && count(1001, 5009) == 1, "pair is recreated before reverse undo")
	pair = call(alice, "set_home_task_completed", map[string]any{"task_id": "assigned-visit-1", "completed": false}, 0)
	check(pair["completed"] == false && pair["related_tasks"].([]any)[0].(map[string]any)["completed"] == false && count(1001, 5001) == 0 && count(1001, 5009) == 0, "reverse paired undo")
	pass("owned survey or visit undo removes both canonical completions")
	read := login(1001, "guidance:read")
	readSession := connect(read.access)
	defer readSession.Close()
	call(readSession, "get_home_tasks", nil, 0)
	call(readSession, "set_favorite", map[string]any{"company_id": "AM-2", "favorite": true}, 403)
	call(readSession, "set_home_task_completed", map[string]any{"task_id": "overall-survey", "completed": true}, 403)
	status, _ := delegate(read.access, "guidance:tasks:write")
	check(status == 400 && count(1001, 5017) == 0, "read consent cannot exchange for write")
	pass("read-only OAuth consent can read but cannot write or widen child scope")
	denied := login(1013, fullScope)
	deniedSession := connect(denied.access)
	defer deniedSession.Close()
	call(deniedSession, "get_home_tasks", nil, 403)
	call(deniedSession, "set_home_task_completed", map[string]any{"task_id": "overall-survey", "completed": true}, 403)
	check(count(1013, 5017) == 0, "Taskly permission denied user no write")
	pass("Taskly canonical permission denial survives full OAuth write scope")
	status, child := delegate(a.access, "guidance:tasks:read")
	check(status == 200 && child["refresh_token"] == nil && child["expires_in"].(float64) > 0 && child["expires_in"].(float64) <= 60, "child short-lived no refresh")
	childToken := child["access_token"].(string)
	claims := inspect(childToken, false)
	actor := claims["act"].(map[string]any)
	check(claims["active"] == true && claims["sub"] == "1001" && claims["aud"] == tasklyOrigin+"/integrations/nnct-guidance/tasks" && claims["original_client_id"] == publicID && claims["original_resource"] == guidanceOrigin+"/mcp" && actor["sub"] == backendID, "actual delegated claims binding")
	check(inspect(a.access, false)["active"] == false && inspect(childToken, true)["active"] == false, "introspection client separation")
	pass("real token exchange preserves subject/actor/audience and enforces <=60s with no refresh")
	status, _, _ = request(client(), "POST", guidanceOrigin+"/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}}, map[string]string{"Authorization": "Bearer " + childToken})
	check(status == 401, "child wrong resource denied on MCP")
	status, _, _ = request(client(), "GET", tasklyOrigin+"/integrations/nnct-guidance/tasks", nil, map[string]string{"Authorization": "Bearer " + a.access, "X-Guidance-Event-ID": "synthetic-guidance-2030"})
	check(status == 401, "parent cannot enter downstream Taskly")
	pass("wrong-resource child and parent-as-downstream substitution are rejected")
	refresh := url.Values{"client_id": {publicID}, "grant_type": {"refresh_token"}, "refresh_token": {a.refresh}, "resource": {guidanceOrigin + "/mcp"}}
	status, rotated := form(refresh)
	check(status == 200 && rotated["refresh_token"] != a.refresh, "real refresh rotation")
	fresh := connect(rotated["access_token"].(string))
	defer fresh.Close()
	check(call(fresh, "get_profile", nil, 0)["id"] == "1001", "refresh preserves identity")
	pass("actual refresh rotation preserves resource and verified profile")
	check(inspect(childToken, false)["active"] == true, "existing child must be active immediately before parent revocation")
	status, _, _ = request(client(), "POST", authOrigin+"/oauth/revoke", url.Values{"client_id": {publicID}, "token": {a.access}}, nil)
	check(status == 200 && inspect(childToken, false)["active"] == false, "parent revoke immediate child invalidation")
	status, _ = delegate(a.access, "guidance:tasks:read")
	check(status == 400, "revoked parent cannot mint child")
	status, _, _ = request(client(), "POST", guidanceOrigin+"/mcp", map[string]any{"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": map[string]any{}}, map[string]string{"Authorization": "Bearer " + a.access})
	check(status == 401, "revoked parent cannot access MCP")
	pass("revoking parent immediately rejects existing child, new delegation and MCP access")
	check(inspect(rotated["access_token"].(string), true)["active"] == true, "rotated access must be active immediately before refresh replay")
	status, _ = form(refresh)
	check(status == 400 && inspect(rotated["access_token"].(string), true)["active"] == false, "refresh replay invalidates family")
	pass("refresh-token replay invalidates the actual token family")
	var sessions int
	must(g.QueryRow("SELECT COUNT(*) FROM guidance_sessions").Scan(&sessions), "web sessions count")
	check(sessions == 0, "MCP must not borrow a guidance web session")
	pass("entire MCP flow uses parent/child OAuth with zero Guidance browser sessions")
}
func main() {
	defer func() {
		if p := recover(); p != nil {
			fmt.Fprintln(os.Stderr, "FAIL", p)
			os.Exit(1)
		}
	}()
	if len(os.Args) > 1 && os.Args[1] == "seed" {
		seed()
		return
	}
	run()
	out := map[string]any{"passed": len(reports), "cases": reports, "mocked_business_responses": false, "real_password_login": true, "official_sdk": "github.com/modelcontextprotocol/go-sdk/mcp v1.8.0", "native_browser_test": false}
	b, _ := json.MarshalIndent(out, "", "  ")
	check(len(reports) == 18, "all eighteen scenarios must execute")
	must(os.WriteFile(filepath.Join(os.Getenv("MCP_E2E_ARTIFACT_DIR"), "report.json"), b, 0600), "write report")
	fmt.Printf("ALL %d cases passed\n", len(reports))
}
