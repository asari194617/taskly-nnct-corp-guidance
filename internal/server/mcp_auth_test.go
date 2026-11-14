package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
)

type mcpAuthRecorded struct {
	path   string
	form   url.Values
	cookie string
}
type mcpAuthControl struct {
	mu       sync.Mutex
	identity map[string]any
	status   int
	payload  string
	calls    []mcpAuthRecorded
}

func mcpAuthTestServer(t *testing.T) (*Server, *fakeStore, *mcpAuthControl) {
	t.Helper()
	s, store := testServer(t)
	s.config.MCPEnabled = true
	s.config.MCPBackendSecret = strings.Repeat("s", 32)
	s.config.TasklyAPIOrigin = "https://tasks.example.test"
	s.config.TasklyEventID = "synthetic-event"
	control := &mcpAuthControl{identity: map[string]any{"active": true, "sub": "123", "client_id": mcpPublicClientID, "iss": s.config.AuthIssuer, "aud": s.mcpResource(), "exp": time.Now().Add(time.Hour).Unix(), "scope": mcpReadScope, "token_type": "Bearer"}}
	s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		control.mu.Lock()
		defer control.mu.Unlock()
		id, secret, ok := r.BasicAuth()
		if !ok || id != mcpBackendClientID || secret != s.config.MCPBackendSecret || r.Method != "POST" || r.URL.Host != "auth.example.test" {
			t.Error("verification did not use dedicated auth-server Basic credentials")
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		control.calls = append(control.calls, mcpAuthRecorded{r.URL.Path, r.Form, r.Header.Get("Cookie")})
		status := control.status
		if status == 0 {
			status = 200
		}
		payload := control.payload
		if payload == "" {
			body, _ := json.Marshal(control.identity)
			payload = string(body)
		}
		return identityResponse(status, payload), nil
	})
	return s, store, control
}

func TestMCPIntrospectionRequiresEveryIdentityBoundary(t *testing.T) {
	for _, test := range []struct {
		name, key string
		value     any
	}{
		{"inactive", "active", false}, {"other client", "client_id", "nnct-corp-guidance-2026"}, {"wrong issuer", "iss", "https://other.example.test"}, {"web audience", "aud", "taskly-api"}, {"expired", "exp", int64(1)}, {"invalid subject", "sub", "user-123"}, {"zero subject", "sub", "0"}, {"signed subject", "sub", "+123"}, {"unknown scope", "scope", "guidance:read taskly:login"}, {"write without read", "scope", mcpTaskWriteScope}, {"no scope", "scope", ""}, {"wrong token type", "token_type", "Basic"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _, control := mcpAuthTestServer(t)
			control.identity[test.key] = test.value
			info, problem := s.verifyMCP(context.Background(), "synthetic-parent")
			if info != nil || problem == nil || problem.status != 401 {
				t.Fatalf("invalid boundary accepted: %s", test.name)
			}
		})
	}
	s, _, control := mcpAuthTestServer(t)
	control.identity["scope"] = strings.Join([]string{mcpReadScope, mcpBookmarkWriteScope, mcpTaskWriteScope}, " ")
	info, problem := s.verifyMCP(context.Background(), "synthetic-parent")
	if problem != nil || info.UserID != "123" || len(info.Scopes) != 3 || info.Expiration.Before(time.Now()) {
		t.Fatal("valid scoped principal not preserved")
	}
	if len(control.calls) != 1 || control.calls[0].form.Get("token") != "synthetic-parent" || control.calls[0].form.Get("token_type_hint") != "access_token" || control.calls[0].cookie != "" {
		t.Fatal("introspection request contract violated")
	}
	control.identity["active"] = false
	if _, problem := s.verifyMCP(context.Background(), "synthetic-parent"); problem == nil || problem.status != 401 || len(control.calls) != 2 {
		t.Fatal("revoked token reused cached identity")
	}
}

func TestMCPIntrospectionDistinguishesServiceOutage(t *testing.T) {
	for _, test := range []struct {
		status  int
		payload string
	}{{503, "unavailable"}, {401, "invalid backend client"}, {302, "redirect"}, {200, "invalid-json"}, {200, strings.Repeat("x", 16385)}, {200, `{"active":true,"aud":["https://api.example.test/mcp"]}`}} {
		s, _, control := mcpAuthTestServer(t)
		control.status = test.status
		control.payload = test.payload
		if _, problem := s.verifyMCP(context.Background(), "synthetic-parent"); problem == nil || problem.status != 503 {
			t.Fatal("identity outage was treated as an authorization grant or revocation")
		}
	}
	s, _, _ := mcpAuthTestServer(t)
	s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("synthetic transport outage") })
	if _, problem := s.verifyMCP(context.Background(), "synthetic-parent"); problem == nil || problem.status != 503 {
		t.Fatal("transport outage did not fail closed")
	}
}

func mcpAuthorizeRequest(s *Server, authorization, origin, cookie, host string, next http.Handler) *httptest.ResponseRecorder {
	req := httptest.NewRequest("POST", s.mcpResource(), strings.NewReader(`{}`))
	if authorization != "" {
		req.Header.Set("Authorization", authorization)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if host != "" {
		req.Host = host
	}
	response := httptest.NewRecorder()
	s.mcpAuthorize(next).ServeHTTP(response, req)
	return response
}

func TestMCPBearerChainIsSeparateFromBrowserCookies(t *testing.T) {
	for _, test := range []struct {
		name, authorization, origin, cookie, host string
		status                                    int
	}{
		{name: "missing", status: 401}, {name: "raw token", authorization: "synthetic-parent", status: 401}, {name: "other scheme", authorization: "Basic test", status: 401}, {name: "multiple fields", authorization: "Bearer one two", status: 401}, {name: "too long", authorization: "Bearer " + strings.Repeat("x", 4097), status: 401}, {name: "cookie only", cookie: "guidance_session=synthetic", status: 401}, {name: "mixed credentials", authorization: "Bearer synthetic-parent", cookie: "guidance_session=synthetic", status: 401}, {name: "different Origin", authorization: "Bearer synthetic-parent", origin: "https://chatgpt.example.test", status: 403}, {name: "browser UI Origin", authorization: "Bearer synthetic-parent", origin: "https://ui.example.test", status: 403}, {name: "untrusted Host", authorization: "Bearer synthetic-parent", host: "attacker.example.test", status: 403},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _, control := mcpAuthTestServer(t)
			called := false
			w := mcpAuthorizeRequest(s, test.authorization, test.origin, test.cookie, test.host, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
			if w.Code != test.status || called || len(control.calls) != 0 {
				t.Fatalf("pre-auth boundary status%d downstream%v", w.Code, called)
			}
			if test.status == 401 && !strings.Contains(w.Header().Get("WWW-Authenticate"), s.mcpMetadataURL()) {
				t.Fatal("missing OAuth resource challenge")
			}
		})
	}
	s, _, control := mcpAuthTestServer(t)
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		info := auth.TokenInfoFromContext(r.Context())
		if info == nil || info.UserID != "123" {
			t.Error("SDK principal not attached")
		}
		w.WriteHeader(204)
	})
	for _, origin := range []string{"", s.config.APIOrigin} {
		w := mcpAuthorizeRequest(s, "Bearer synthetic-parent", origin, "", "", next)
		if w.Code != 204 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("valid server-to-server call%d", w.Code)
		}
	}
	control.identity["active"] = false
	w := mcpAuthorizeRequest(s, "Bearer synthetic-parent", "", "", "", next)
	if w.Code != 401 || !strings.Contains(w.Header().Get("WWW-Authenticate"), `error="invalid_token"`) {
		t.Fatal("revocation did not reach transport authentication")
	}
	control.status = 503
	control.payload = "synthetic private failure detail"
	w = mcpAuthorizeRequest(s, "Bearer synthetic-parent", "", "", "", next)
	if w.Code != 503 || strings.Contains(w.Body.String(), "private failure") {
		t.Fatal("auth outage leaked provider response or granted access")
	}
}

func TestMCPLimitsAnonymousWorkAndRequestBodies(t *testing.T) {
	s, _, control := mcpAuthTestServer(t)
	s.mcpLimit = newFlowLimiter(0.000001, 1)
	noOp := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) })
	mcpAuthorizeRequest(s, "", "", "", "", noOp)
	limited := mcpAuthorizeRequest(s, "", "", "", "", noOp)
	if limited.Code != 429 || limited.Header().Get("Retry-After") == "" || len(control.calls) != 0 {
		t.Fatal("unauthenticated work was not bounded before introspection")
	}
	s, _, _ = mcpAuthTestServer(t)
	req := httptest.NewRequest("POST", s.mcpResource(), strings.NewReader(strings.Repeat("x", (64<<10)+1)))
	req.Header.Set("Authorization", "Bearer synthetic-parent")
	w := httptest.NewRecorder()
	s.mcpAuthorize(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.ReadAll(r.Body); err == nil {
			t.Error("oversized MCP body accepted")
		}
		w.WriteHeader(413)
	})).ServeHTTP(w, req)
	if w.Code != 413 {
		t.Fatalf("large body status%d", w.Code)
	}
}

func mcpExchangeEnvelope(scope string) map[string]any {
	return map[string]any{"access_token": "synthetic-delegated", "token_type": "Bearer", "expires_in": 60, "issued_token_type": exchangedAccessType, "scope": scope}
}

func TestMCPExchangeIsNarrowAndNeverForwardsBrowserCredentials(t *testing.T) {
	for _, write := range []bool{false, true} {
		s, _, control := mcpAuthTestServer(t)
		scope := "guidance:tasks:read"
		if write {
			scope = mcpTaskWriteScope
		}
		encoded, _ := json.Marshal(mcpExchangeEnvelope(scope))
		control.payload = string(encoded)
		token, problem := s.exchangeMCP(context.Background(), "synthetic-parent", write)
		if problem != nil || token != "synthetic-delegated" {
			t.Fatal("valid delegation rejected")
		}
		if len(control.calls) != 1 {
			t.Fatal("exchange request count incorrect")
		}
		call := control.calls[0]
		expected := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:token-exchange"}, "subject_token": {"synthetic-parent"}, "subject_token_type": {exchangedAccessType}, "requested_token_type": {exchangedAccessType}, "resource": {s.mcpTasklyResource()}, "scope": {scope}}
		if call.path != "/oauth/token" || call.form.Encode() != expected.Encode() || call.cookie != "" {
			t.Fatal("delegation was not bound to its exact audience, grant and method scope")
		}
	}
}

func TestMCPExchangeRejectsEscalatedOrMalformedResponses(t *testing.T) {
	for _, test := range []struct {
		name, key string
		value     any
	}{
		{"missing access", "access_token", ""}, {"oversized access", "access_token", strings.Repeat("x", 4097)}, {"wrong type", "token_type", "Basic"}, {"expired", "expires_in", 0}, {"too long", "expires_in", 61}, {"string expiry", "expires_in", "60"}, {"wrong issued type", "issued_token_type", "urn:other"}, {"combined scope", "scope", "guidance:tasks:read guidance:tasks:write"}, {"write escalation", "scope", mcpTaskWriteScope}, {"refresh credential", "refresh_token", "synthetic-never-return"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _, control := mcpAuthTestServer(t)
			value := mcpExchangeEnvelope("guidance:tasks:read")
			value[test.key] = test.value
			body, _ := json.Marshal(value)
			control.payload = string(body)
			if token, problem := s.exchangeMCP(context.Background(), "synthetic-parent", false); token != "" || problem == nil || problem.status != 503 {
				t.Fatal("invalid delegation response accepted")
			}
		})
	}
	for _, test := range []struct{ status, want int }{{400, 401}, {401, 401}, {403, 401}, {503, 503}, {302, 503}} {
		s, _, control := mcpAuthTestServer(t)
		control.status = test.status
		control.payload = `{}`
		if token, problem := s.exchangeMCP(context.Background(), "synthetic-parent", false); token != "" || problem == nil || problem.status != test.want {
			t.Fatalf("upstream%d mapped incorrectly", test.status)
		}
	}
	s, _, control := mcpAuthTestServer(t)
	control.payload = "not-json"
	if _, problem := s.exchangeMCP(context.Background(), "synthetic-parent", false); problem == nil || problem.status != 503 {
		t.Fatal("malformed delegation accepted")
	}
	s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("synthetic exchange outage") })
	if _, problem := s.exchangeMCP(context.Background(), "synthetic-parent", false); problem == nil || problem.status != 503 {
		t.Fatal("exchange transport outage did not fail closed")
	}
}

type mcpErrorBody struct{}

func (mcpErrorBody) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func (mcpErrorBody) Close() error             { return nil }
func TestMCPPostRejectsUnreadableResponsesAndInvalidEndpoint(t *testing.T) {
	s, _, _ := mcpAuthTestServer(t)
	s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: mcpErrorBody{}, Header: http.Header{}}, nil
	})
	if _, _, err := s.mcpPost(context.Background(), "/oauth/introspect", url.Values{}); err == nil {
		t.Fatal("unreadable identity response accepted")
	}
	s.config.AuthIssuer = ":invalid"
	if _, _, err := s.mcpPost(context.Background(), "/oauth/introspect", url.Values{}); err == nil {
		t.Fatal("invalid identity endpoint accepted")
	}
}

func TestMCPConfigurationIsOptInAndUsesSeparateSecret(t *testing.T) {
	c := validConfig()
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.MCPEnabled = true
	if err := c.Validate(); err == nil {
		t.Fatal("MCP enabled without dedicated credentials")
	}
	c.MCPBackendSecret = strings.Repeat("s", 32)
	if err := c.Validate(); err == nil {
		t.Fatal("MCP enabled without Taskly bridge")
	}
	c.TasklyAPIOrigin = "https://tasks.example.test"
	c.TasklyEventID = "synthetic-event"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.MCPBackendSecret += " "
	if err := c.Validate(); err == nil {
		t.Fatal("ambiguous dedicated secret accepted")
	}
	for key, value := range map[string]string{"DOCUMENT_STORAGE": "r2", "SESSION_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString(make([]byte, 32)), "UI_ORIGIN": "https://ui.example.test", "API_ORIGIN": "https://api.example.test", "AUTH_ISSUER": "https://auth.example.test", "AUTH_CLIENT_ID": "legacy-browser-client", "TASKLY_API_ORIGIN": "https://tasks.example.test", "TASKLY_GUIDANCE_EVENT_ID": "synthetic-event", "R2_ENDPOINT": "https://objects.example.test", "R2_BUCKET": "synthetic-documents", "R2_ACCESS_KEY_ID": "synthetic-access", "R2_SECRET_ACCESS_KEY": "synthetic-secret", "MCP_BACKEND_SECRET": strings.Repeat("s", 32), "MCP_ENABLED": "1"} {
		t.Setenv(key, value)
	}
	cfg, err := ConfigFromEnv()
	if err != nil || !cfg.MCPEnabled || cfg.ClientID != "legacy-browser-client" {
		t.Fatal("dedicated MCP configuration changed browser identity")
	}
	t.Setenv("MCP_ENABLED", "true")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("unsupported MCP switch accepted")
	}
	t.Setenv("MCP_ENABLED", "0")
	t.Setenv("MCP_BACKEND_SECRET", "")
	if cfg, err := ConfigFromEnv(); err != nil || cfg.MCPEnabled {
		t.Fatal("disabled MCP affected legacy deployment")
	}
}

func TestMCPMetadataAndOldBrowserRoutesKeepTheirBoundaries(t *testing.T) {
	s, store, control := mcpAuthTestServer(t)
	for _, path := range []string{"/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"} {
		w := request(s, "GET", path, nil, "")
		requireStatus(t, w, 200)
		var metadata struct {
			Resource string   `json:"resource"`
			Issuers  []string `json:"authorization_servers"`
			Scopes   []string `json:"scopes_supported"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &metadata); err != nil || metadata.Resource != s.mcpResource() || len(metadata.Issuers) != 1 || metadata.Issuers[0] != s.config.AuthIssuer || len(metadata.Scopes) != 3 {
			t.Fatal("protected resource metadata not bound to configured service")
		}
		if strings.Contains(w.Body.String(), s.config.MCPBackendSecret) || len(control.calls) != 0 {
			t.Fatal("public metadata leaked credentials or required identity lookup")
		}
	}
	req := httptest.NewRequest("POST", s.config.APIOrigin+"/api/bookmarks/AM-1", nil)
	req.Header.Set("Authorization", "Bearer synthetic-parent")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	requireStatus(t, w, 403)
	// A valid bearer never becomes a browser session, even with the UI Origin.
	req = httptest.NewRequest("GET", s.config.APIOrigin+"/api/me", nil)
	req.Header.Set("Origin", s.config.UIOrigin)
	req.Header.Set("Authorization", "Bearer synthetic-parent")
	w = httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	requireStatus(t, w, 401)
	cookie := authenticated(t, s, store)
	w = request(s, "POST", "/mcp", cookie, "")
	requireStatus(t, w, 401)
	s.config.MCPEnabled = false
	w = request(s, "GET", "/.well-known/oauth-protected-resource", nil, "")
	requireStatus(t, w, 404)
}

func TestMCPRejectsDuplicateAuthorizationHeaders(t *testing.T) {
	s, _, control := mcpAuthTestServer(t)
	req := httptest.NewRequest("POST", s.mcpResource(), strings.NewReader(`{}`))
	req.Header.Add("Authorization", "Bearer synthetic-parent")
	req.Header.Add("Authorization", "Bearer different-parent")
	w := httptest.NewRecorder()
	called := false
	s.mcpAuthorize(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true })).ServeHTTP(w, req)
	if w.Code != 401 || called || len(control.calls) != 0 {
		t.Fatal("ambiguous authorization headers were accepted")
	}
}

func TestMCPStatelessInitializeAndAuthenticatedToolDiscovery(t *testing.T) {
	s, _, control := mcpAuthTestServer(t)
	handler := s.Handler()
	invoke := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("POST", s.mcpResource(), strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer synthetic-parent")
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("MCP-Protocol-Version", "2025-11-25")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatalf("MCP discovery status%d: %s", w.Code, w.Body.String())
		}
		if !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") || w.Header().Get("Mcp-Session-Id") != "" {
			t.Fatal("transport did not remain stateless JSON")
		}
		return w
	}
	initialized := invoke(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"synthetic-auth-test","version":"1"}}}`)
	var init struct {
		Result struct {
			ServerInfo struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
		} `json:"result"`
	}
	if err := json.Unmarshal(initialized.Body.Bytes(), &init); err != nil || init.Result.ServerInfo.Name == "" {
		t.Fatal("official SDK initialize result missing")
	}
	listed := invoke(`{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}`)
	var response struct {
		Result struct {
			Tools []struct {
				Name        string                     `json:"name"`
				Meta        map[string]json.RawMessage `json:"_meta"`
				Annotations struct {
					ReadOnly   bool `json:"readOnlyHint"`
					OpenWorld  bool `json:"openWorldHint"`
					Idempotent bool `json:"idempotentHint"`
				} `json:"annotations"`
			} `json:"tools"`
		} `json:"result"`
	}
	if err := json.Unmarshal(listed.Body.Bytes(), &response); err != nil || len(response.Result.Tools) != 8 {
		t.Fatalf("expected eight discovered tools: %v", err)
	}
	found := map[string]bool{}
	for _, tool := range response.Result.Tools {
		found[tool.Name] = true
		var schemes []struct {
			Type   string   `json:"type"`
			Scopes []string `json:"scopes"`
		}
		if err := json.Unmarshal(tool.Meta["securitySchemes"], &schemes); err != nil || len(schemes) != 1 || schemes[0].Type != "oauth2" {
			t.Fatalf("tool %s missing explicit OAuth policy", tool.Name)
		}
		if tool.Annotations.OpenWorld {
			t.Fatalf("bounded catalog tool %s advertised open-world access", tool.Name)
		}
		if tool.Name == "set_favorite" || tool.Name == "set_home_task_completed" {
			if tool.Annotations.ReadOnly || !tool.Annotations.Idempotent {
				t.Fatalf("write tool %s safety hints wrong", tool.Name)
			}
		} else if !tool.Annotations.ReadOnly {
			t.Fatalf("read tool %s advertised as mutation", tool.Name)
		}
		if tool.Name == "get_profile" && string(tool.Meta["openai/profile"]) != "true" {
			t.Fatal("profile discovery metadata missing")
		}
	}
	for _, name := range []string{"get_profile", "search_companies", "get_company", "get_my_guidance", "list_documents", "set_favorite", "get_home_tasks", "set_home_task_completed"} {
		if !found[name] {
			t.Fatalf("missing discovered tool %s", name)
		}
	}
	if len(control.calls) != 2 {
		t.Fatal("transport requests did not independently verify token liveness")
	}
}

func TestMCPProfileReturnsOnlyIntrospectedSubjectWithoutUserinfo(t *testing.T) {
	s, _, control := mcpAuthTestServer(t)
	introspect := s.client.Transport
	s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/oauth/introspect" {
			t.Errorf("profile made an unexpected upstream request: %s", r.URL.Path)
			return nil, errors.New("profile must not request userinfo")
		}
		return introspect.RoundTrip(r)
	})
	req := httptest.NewRequest("POST", s.mcpResource(), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_profile","arguments":{}}}`))
	req.Header.Set("Authorization", "Bearer synthetic-parent")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("profile transport status%d: %s", w.Code, w.Body.String())
	}
	var response struct {
		Error  json.RawMessage `json:"error"`
		Result struct {
			IsError           bool           `json:"isError"`
			StructuredContent map[string]any `json:"structuredContent"`
			Content           []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || len(response.Error) != 0 || response.Result.IsError {
		t.Fatalf("profile tool failed: %s", w.Body.String())
	}
	profile := response.Result.StructuredContent
	if len(profile) != 1 || profile["id"] != "123" {
		t.Fatalf("profile must contain only the introspected subject: %v", profile)
	}
	for _, content := range response.Result.Content {
		if content.Type != "text" {
			t.Fatal("profile unexpectedly returned non-text account data")
		}
		var mirrored map[string]any
		if err := json.Unmarshal([]byte(content.Text), &mirrored); err != nil || len(mirrored) != 1 || mirrored["id"] != "123" {
			t.Fatal("profile text exposed fields beyond the subject ID")
		}
	}
	if len(control.calls) != 1 || control.calls[0].path != "/oauth/introspect" {
		t.Fatal("profile must verify token liveness once and never call userinfo")
	}
}
