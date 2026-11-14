package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type mcpAdapterResult struct {
	Error  json.RawMessage `json:"error"`
	Result struct {
		IsError    bool            `json:"isError"`
		Structured json.RawMessage `json:"structuredContent"`
		Meta       struct {
			Status     int      `json:"status"`
			Challenges []string `json:"mcp/www_authenticate"`
		} `json:"_meta"`
	} `json:"result"`
}

func mcpAdapterCall(t *testing.T, s *Server, name string, arguments any) mcpAdapterResult {
	t.Helper()
	body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": name, "arguments": arguments}})
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, s.mcpResource(), strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer synthetic-parent")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("SDK tool %s HTTP%d: %s", name, w.Code, w.Body.String())
	}
	var result mcpAdapterResult
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.Error) != 0 {
		t.Fatalf("SDK tool %s failed: %s", name, w.Body.String())
	}
	return result
}

func TestMCPFavoriteSDKPersistsOnlyTheAuthenticatedAccount(t *testing.T) {
	s, store, control := mcpAuthTestServer(t)
	control.identity["scope"] = mcpReadScope + " " + mcpBookmarkWriteScope
	store.bookmarks["456"] = map[string]bool{"AM-1": true}
	for _, favorite := range []bool{true, true, false, false} {
		result := mcpAdapterCall(t, s, "set_favorite", map[string]any{"company_id": "AM-1", "favorite": favorite})
		var output mcpFavoriteOutput
		if result.Result.IsError || json.Unmarshal(result.Result.Structured, &output) != nil || output.CompanyID != "AM-1" || output.Favorite != favorite || output.URL != s.config.UIOrigin+"/?company=AM-1" {
			t.Fatal("favorite result was not authoritative")
		}
		if store.bookmarks["123"]["AM-1"] != favorite || !store.bookmarks["456"]["AM-1"] {
			t.Fatal("favorite changed another account or lost idempotency")
		}
	}
	if len(store.sessions) != 0 {
		t.Fatal("MCP adapter invented a browser session")
	}
	result := mcpAdapterCall(t, s, "set_favorite", map[string]any{"company_id": "PM-99", "favorite": true})
	if !result.Result.IsError || result.Result.Meta.Status != 404 || store.bookmarks["123"]["PM-99"] {
		t.Fatal("unknown company was persisted")
	}
	store.errorBookmark = errors.New("synthetic unavailable storage")
	result = mcpAdapterCall(t, s, "set_favorite", map[string]any{"company_id": "AM-1", "favorite": true})
	if !result.Result.IsError || result.Result.Meta.Status != 503 || store.bookmarks["123"]["AM-1"] {
		t.Fatal("failed favorite save fabricated success")
	}
}

func TestMCPReadScopeCannotWriteOrExchange(t *testing.T) {
	s, store, control := mcpAuthTestServer(t)
	for _, call := range []struct {
		name  string
		args  map[string]any
		scope string
	}{
		{"set_favorite", map[string]any{"company_id": "AM-1", "favorite": true}, mcpBookmarkWriteScope},
		{"set_home_task_completed", map[string]any{"task_id": "overall-survey", "completed": true}, mcpTaskWriteScope},
	} {
		result := mcpAdapterCall(t, s, call.name, call.args)
		if !result.Result.IsError || result.Result.Meta.Status != 403 {
			t.Fatal("read-only grant reached mutation")
		}
		if len(result.Result.Meta.Challenges) != 1 || !strings.Contains(result.Result.Meta.Challenges[0], `scope="`+mcpReadScope+" "+call.scope+`"`) || !strings.Contains(result.Result.Meta.Challenges[0], `error="insufficient_scope"`) {
			t.Fatal("OAuth upgrade challenge omitted the mandatory read scope")
		}
	}
	if len(store.bookmarks) != 0 || len(control.calls) != 2 {
		t.Fatal("scope denial mutated storage or exchanged a token")
	}
	for _, call := range control.calls {
		if call.path != "/oauth/introspect" {
			t.Fatal("denied write contacted downstream service")
		}
	}
}

type mcpAdapterBridge struct {
	exchanges, requests int
	status              int
	payload             string
	transportFailure    bool
	completed           bool
}

func mcpAdapterHomeFixture(t *testing.T) (*Server, *fakeStore, *mcpAdapterBridge) {
	t.Helper()
	s, store, control := mcpAuthTestServer(t)
	control.identity["scope"] = mcpReadScope + " " + mcpTaskWriteScope
	store.dataset = json.RawMessage(`{"event":{"task_actions":{"visit_survey":{"url":"https://forms.example.test/visit"},"overall_survey":{"url":"https://forms.example.test/overall"},"sheet_submission":{"document_id":"guide","page":3}}},"companies":[],"schedule":[{"term":1}],"assignments":[],"documents":[{"id":"guide","mime_type":"application/pdf"}]}`)
	authTransport := s.client.Transport
	bridge := &mcpAdapterBridge{}
	s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "auth.example.test" && r.URL.Path == "/oauth/introspect" {
			return authTransport.RoundTrip(r)
		}
		if r.Header.Get("Cookie") != "" {
			t.Error("adapter leaked a browser cookie")
		}
		if r.URL.Host == "auth.example.test" && r.URL.Path == "/oauth/token" {
			bridge.exchanges++
			id, secret, ok := r.BasicAuth()
			if !ok || id != mcpBackendClientID || secret != s.config.MCPBackendSecret {
				t.Error("exchange did not use dedicated service credential")
			}
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			scope := r.Form.Get("scope")
			if r.Form.Get("subject_token") != "synthetic-parent" || r.Form.Get("resource") != s.mcpTasklyResource() || (scope != "guidance:tasks:read" && scope != mcpTaskWriteScope) {
				t.Error("exchange escaped its subject/audience/method scope")
			}
			payload, _ := json.Marshal(mcpExchangeEnvelope(scope))
			return identityResponse(200, string(payload)), nil
		}
		if r.URL.Host != "tasks.example.test" || !strings.HasPrefix(r.URL.Path, "/integrations/nnct-guidance/tasks") {
			t.Fatalf("unexpected adapter endpoint %s", r.URL.Path)
		}
		bridge.requests++
		if r.Header.Get("Authorization") != "Bearer synthetic-delegated" || r.Header.Get("X-Guidance-Event-ID") != s.config.TasklyEventID {
			t.Error("Taskly received parent token or unbound event")
		}
		if bridge.transportFailure {
			return nil, errors.New("synthetic Taskly connection failure")
		}
		if bridge.status != 0 {
			return identityResponse(bridge.status, `{"error":"private upstream detail"}`), nil
		}
		if bridge.payload != "" {
			return identityResponse(200, bridge.payload), nil
		}
		completed, disabled := bridge.completed, false
		task := func(key string, id uint64) tasklyHomeTask {
			return tasklyHomeTask{Key: key, TaskID: id, Completed: &completed, CompletionDisabled: &disabled, TasklyURL: "https://tasks.example.test/"}
		}
		var output any
		if r.Method == http.MethodGet {
			output = map[string]any{"event_id": s.config.TasklyEventID, "tasks": []tasklyHomeTask{task("visit-survey-1", 1), task("overall-survey", 2), task("sheet-submission", 3)}}
		} else {
			if r.Method != http.MethodPut || r.URL.Path != "/integrations/nnct-guidance/tasks/overall-survey" {
				t.Fatal("write escaped the selected canonical task")
			}
			var change struct {
				Completed bool `json:"completed"`
			}
			if err := json.NewDecoder(r.Body).Decode(&change); err != nil {
				t.Fatal(err)
			}
			bridge.completed = change.Completed
			completed = change.Completed
			output = task("overall-survey", 2)
		}
		payload, _ := json.Marshal(output)
		return identityResponse(200, string(payload)), nil
	})
	return s, store, bridge
}

func TestMCPHomeSDKUsesExchangedCredentialAndCanonicalReadWrite(t *testing.T) {
	s, store, bridge := mcpAdapterHomeFixture(t)
	read := mcpAdapterCall(t, s, "get_home_tasks", map[string]any{})
	var home mcpHomeOutput
	if read.Result.IsError || json.Unmarshal(read.Result.Structured, &home) != nil || len(home.Tasks) != 3 || home.EventID != s.config.TasklyEventID || home.RosterConfigured {
		t.Fatal("canonical home snapshot missing")
	}
	for _, completed := range []bool{true, false} {
		changed := mcpAdapterCall(t, s, "set_home_task_completed", map[string]any{"task_id": "overall-survey", "completed": completed})
		var updated mcpHomeUpdate
		if changed.Result.IsError || json.Unmarshal(changed.Result.Structured, &updated) != nil || updated.ID != "overall-survey" || updated.Completed != completed || bridge.completed != completed {
			t.Fatal("SDK completion did not reflect canonical Taskly state")
		}
	}
	if bridge.exchanges != 3 || bridge.requests != 3 || len(store.sessions) != 0 {
		t.Fatal("MCP reused a browser credential or skipped per-call exchange")
	}
}

func TestMCPHomeSDKPreservesErrorsAndNeverFabricatesCompletion(t *testing.T) {
	for _, write := range []bool{false, true} {
		for _, failure := range []struct {
			name         string
			status, want int
			payload      string
			transport    bool
		}{
			{"revoked", 401, 401, "", false}, {"forbidden", 403, 403, "", false}, {"disabled", 409, 409, "", false}, {"unavailable", 503, 503, "", false}, {"malformed", 0, 503, "not-json", false}, {"transport", 0, 503, "", true},
		} {
			t.Run(failure.name+map[bool]string{true: "-write", false: "-read"}[write], func(t *testing.T) {
				s, _, bridge := mcpAdapterHomeFixture(t)
				bridge.status, bridge.payload, bridge.transportFailure = failure.status, failure.payload, failure.transport
				name, args := "get_home_tasks", map[string]any{}
				if write {
					name = "set_home_task_completed"
					args = map[string]any{"task_id": "overall-survey", "completed": true}
				}
				result := mcpAdapterCall(t, s, name, args)
				if !result.Result.IsError || result.Result.Meta.Status != failure.want || len(result.Result.Structured) != 0 || bridge.completed {
					t.Fatal("upstream failure fabricated canonical state")
				}
				if failure.want == 401 {
					scope := mcpReadScope
					if write {
						scope += " " + mcpTaskWriteScope
					}
					if len(result.Result.Meta.Challenges) != 1 || !strings.Contains(result.Result.Meta.Challenges[0], `scope="`+scope+`"`) {
						t.Fatal("OAuth reauthorization challenge cannot produce a valid parent grant")
					}
				}
			})
		}
	}
	for _, write := range []bool{false, true} {
		s, store, bridge := mcpAdapterHomeFixture(t)
		store.errorDataset = errors.New("synthetic dataset unavailable")
		name, args := "get_home_tasks", map[string]any{}
		if write {
			name = "set_home_task_completed"
			args = map[string]any{"task_id": "overall-survey", "completed": true}
		}
		result := mcpAdapterCall(t, s, name, args)
		if !result.Result.IsError || result.Result.Meta.Status != 503 || bridge.requests != 0 {
			t.Fatal("invalid local definitions reached canonical bridge")
		}
	}
}

func TestMCPHomeSDKStopsBeforeTasklyWhenDelegationIsDenied(t *testing.T) {
	for _, write := range []bool{false, true} {
		s, _, bridge := mcpAdapterHomeFixture(t)
		base := s.client.Transport
		s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if r.URL.Host == "auth.example.test" && r.URL.Path == "/oauth/token" {
				return identityResponse(403, `{"error":"invalid_scope"}`), nil
			}
			return base.RoundTrip(r)
		})
		name, args := "get_home_tasks", map[string]any{}
		if write {
			name = "set_home_task_completed"
			args = map[string]any{"task_id": "overall-survey", "completed": true}
		}
		result := mcpAdapterCall(t, s, name, args)
		if !result.Result.IsError || result.Result.Meta.Status != 401 || bridge.requests != 0 || bridge.completed {
			t.Fatal("denied delegation reached canonical Taskly state")
		}
	}
}

func TestMCPResponseAdapterBoundsAndFailureDecoding(t *testing.T) {
	w := &mcpResponse{header: make(http.Header)}
	w.Header().Set("X-Test", "synthetic")
	if n, err := w.Write([]byte("ok")); n != 2 || err != nil || w.status != 200 || w.Header().Get("X-Test") != "synthetic" {
		t.Fatal("implicit success writer lost data")
	}
	w.WriteHeader(503)
	if w.status != 200 {
		t.Fatal("second status overwrote first response")
	}
	if n, err := w.Write(make([]byte, 1<<20)); n != 0 || !errors.Is(err, io.ErrShortBuffer) || w.body.String() != "ok" {
		t.Fatal("oversized response was partially retained")
	}
	s, _, _ := mcpAuthTestServer(t)
	payload, problem := s.mcpInvoke(context.Background(), User{Sub: "123"}, http.MethodGet, "", "", nil, "", func(http.ResponseWriter, *http.Request, User) {})
	if len(payload) != 0 || problem != nil {
		t.Fatal("empty successful handler was rejected")
	}
	_, problem = s.mcpInvoke(context.Background(), User{Sub: "123"}, http.MethodGet, "", "", nil, "", func(w http.ResponseWriter, _ *http.Request, _ User) {
		w.WriteHeader(503)
		_, _ = w.Write([]byte("not-json"))
	})
	if problem == nil || problem.status != 503 || problem.code != "service_unavailable" {
		t.Fatal("malformed handler failure did not fail closed")
	}
	if problem := mcpDecode([]byte("not-json"), &mcpHomeOutput{}); problem == nil || problem.status != 503 {
		t.Fatal("malformed successful DTO accepted")
	}
}
