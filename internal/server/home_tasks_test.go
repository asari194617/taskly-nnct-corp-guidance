package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func homeFixture(t *testing.T) (*Server, *fakeStore, *http.Cookie, map[string]tasklyHomeTask) {
	t.Helper()
	s, f := testServer(t)
	s.config.TasklyAPIOrigin = "https://tasks-api.example.test"
	s.config.TasklyEventID = "synthetic-event"
	f.dataset = json.RawMessage(`{
		"event":{"task_actions":{
			"visit_survey":{"url":"https://forms.example.test/visit","due_at":"2030-05-15T00:00:00+09:00"},
			"overall_survey":{"url":"https://forms.example.test/overall"},
			"sheet_submission":{"document_id":"guide","page":3}}},
		"companies":[{"id":"AM-1","name":"Synthetic company"}],
		"schedule":[{"term":1},{"term":2},{"term":null}],
		"assignments":[{"department":"電子制御工学科","grade":4,"number":7,"visits":[{"term":1,"company_id":"AM-1"}]}],
		"documents":[{"id":"guide","mime_type":"application/pdf"}]
	}`)
	f.preferences["user-1"] = 7
	completed, enabled := false, false
	canonical := map[string]tasklyHomeTask{}
	for index, key := range []string{"assigned-visit-1", "visit-survey-1", "visit-survey-2", "overall-survey", "sheet-submission"} {
		canonical[key] = tasklyHomeTask{Key: key, TaskID: uint64(index + 1), Completed: &completed, CompletionDisabled: &enabled, TasklyURL: fmt.Sprintf("https://tasks.example.test/?task=%d", index+1)}
	}
	cookie := authenticated(t, s, f)
	s.client.Transport = homeBridge(t, s, canonical)
	return s, f, cookie, canonical
}

func homeBridge(t *testing.T, s *Server, canonical map[string]tasklyHomeTask) roundTripFunc {
	t.Helper()
	return func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "tasks-api.example.test" {
			return healthyIdentity(r)
		}
		if r.Header.Get("Authorization") != "Bearer upstream-access" || r.Header.Get("X-Guidance-Event-ID") != s.config.TasklyEventID || r.Header.Get("Cookie") != "" || r.URL.RawQuery != "" {
			t.Error("bridge leaked browser state or did not bind the current identity/event")
		}
		var payload any
		if r.Method == http.MethodGet {
			var tasks []tasklyHomeTask
			for _, task := range canonical {
				tasks = append(tasks, task)
			}
			payload = map[string]any{"event_id": s.config.TasklyEventID, "tasks": tasks}
		} else {
			key := strings.TrimPrefix(r.URL.Path, "/integrations/nnct-guidance/tasks/")
			var change struct {
				Completed         bool   `json:"completed"`
				LinkAssignedVisit bool   `json:"link_assigned_visit"`
				AssignmentScope   string `json:"assignment_scope"`
			}
			if json.NewDecoder(r.Body).Decode(&change) != nil {
				t.Error("invalid taskly update body")
			}
			task := canonical[key]
			previous := *task.Completed
			var related []tasklyHomeTask
			if change.LinkAssignedVisit {
				targetKey := "assigned-visit-" + strings.TrimPrefix(key, "visit-survey-")
				reverse := strings.HasPrefix(key, "assigned-visit-")
				if reverse {
					targetKey = "visit-survey-" + strings.TrimPrefix(key, "assigned-visit-")
				}
				target, exists := canonical[targetKey]
				if (!strings.HasPrefix(key, "visit-survey-") && !reverse) || (reverse && change.Completed) || !sessionHashPattern.MatchString(change.AssignmentScope) || !exists {
					t.Error("invalid server-derived pair")
					return identityResponse(400, `{}`), nil
				}
				if change.Completed && (*task.CompletionDisabled || *target.CompletionDisabled) {
					return identityResponse(409, `{}`), nil
				}
				if reverse {
					if task.AutoCompletedBy == targetKey && task.AutoAssignmentScope == change.AssignmentScope {
						value := false
						target.Completed = &value
					}
				} else if change.Completed && !previous && !*target.Completed {
					value := true
					target.Completed = &value
					target.AutoCompletedBy = key
					target.AutoAssignmentScope = change.AssignmentScope
				} else if !change.Completed && target.AutoCompletedBy == key && target.AutoAssignmentScope == change.AssignmentScope {
					value := false
					target.Completed = &value
					target.AutoCompletedBy = ""
					target.AutoAssignmentScope = ""
				} else if target.AutoCompletedBy == key && target.AutoAssignmentScope != change.AssignmentScope {
					target.AutoCompletedBy = ""
					target.AutoAssignmentScope = ""
				}
				canonical[targetKey] = target
				related = []tasklyHomeTask{target}
			}
			task.Completed = &change.Completed
			task.AutoCompletedBy = ""
			task.AutoAssignmentScope = ""
			canonical[key] = task
			payload = struct {
				tasklyHomeTask
				RelatedTasks []tasklyHomeTask `json:"related_tasks,omitempty"`
			}{tasklyHomeTask: task, RelatedTasks: related}
		}
		body, _ := json.Marshal(payload)
		return identityResponse(200, string(body)), nil
	}
}

func homeRequest(s *Server, method, path string, cookie *http.Cookie, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, s.config.APIOrigin+path, strings.NewReader(body))
	r.Header.Set("Origin", s.config.UIOrigin)
	r.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

func TestHomeTasksReadAndWriteTasklyCanonicalState(t *testing.T) {
	s, f, cookie, canonical := homeFixture(t)
	read := func() []HomeTask {
		t.Helper()
		response := homeRequest(s, "GET", "/api/home?user_sub=another-user", cookie, "")
		requireStatus(t, response, 200)
		if response.Header().Get("Cache-Control") != "no-store" || strings.Contains(response.Body.String(), "upstream-access") {
			t.Fatal("private home response cached or leaked its upstream credential")
		}
		var payload struct {
			EventID    string     `json:"event_id"`
			Configured bool       `json:"roster_configured"`
			Tasks      []HomeTask `json:"tasks"`
		}
		if json.Unmarshal(response.Body.Bytes(), &payload) != nil || payload.EventID != s.config.TasklyEventID || !payload.Configured || len(payload.Tasks) != 5 {
			t.Fatalf("invalid personalized home response: %s", response.Body.String())
		}
		return payload.Tasks
	}
	tasks := read()
	if tasks[0].CompanyID != "AM-1" || tasks[0].Title != "Synthetic companyを見学" || tasks[1].URL != "https://forms.example.test/visit" || tasks[1].DueAt == "" || tasks[4].DocumentID != "guide" || tasks[4].Page != 3 || tasks[4].DueAt != "" {
		t.Fatal("runtime source metadata was not joined to the user's tasks")
	}
	response := homeRequest(s, "PUT", "/api/home/tasks/assigned-visit-1", cookie, `{"completed":true}`)
	requireStatus(t, response, 200)
	var updated HomeTask
	if json.Unmarshal(response.Body.Bytes(), &updated) != nil || !updated.Completed || !*canonical["assigned-visit-1"].Completed {
		t.Fatal("completion did not write the canonical Taskly task")
	}
	if !read()[0].Completed {
		t.Fatal("saved canonical completion was not returned")
	}
	// A change made directly in Taskly is visible without a local sync flag.
	reset := false
	task := canonical["assigned-visit-1"]
	task.Completed = &reset
	canonical["assigned-visit-1"] = task
	if read()[0].Completed {
		t.Fatal("Taskly's change was hidden by local duplicated progress")
	}
	delete(f.preferences, "user-1")
	response = homeRequest(s, "GET", "/api/home", cookie, "")
	requireStatus(t, response, 200)
	if strings.Contains(response.Body.String(), "assigned_visit") || !strings.Contains(response.Body.String(), `"roster_configured":false`) {
		t.Fatal("unconfigured identity received an invented assignment")
	}
	requireStatus(t, homeRequest(s, "PUT", "/api/home/tasks/assigned-visit-1", cookie, `{"completed":true}`), 404)
}

func TestHomeForwardsTheFreshlyRotatedSessionCredential(t *testing.T) {
	s, f, _, canonical := homeFixture(t)
	cookie := expiringSession(t, s, f)
	var rotations atomic.Int32
	identity := refreshingIdentity(t, &rotations)
	s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "tasks-api.example.test" {
			return identity(r)
		}
		if r.Header.Get("Authorization") != "Bearer renewed-access" {
			t.Fatal("bridge used a stale pre-refresh credential")
		}
		var tasks []tasklyHomeTask
		for _, task := range canonical {
			tasks = append(tasks, task)
		}
		body, _ := json.Marshal(map[string]any{"event_id": s.config.TasklyEventID, "tasks": tasks})
		return identityResponse(200, string(body)), nil
	})
	response := homeRequest(s, "GET", "/api/home", cookie, "")
	requireStatus(t, response, 200)
	if rotations.Load() != 1 || strings.Contains(response.Body.String(), "renewed-access") || strings.Contains(response.Body.String(), "renewed-refresh") {
		t.Fatal("session credential refresh was missing or exposed to the browser")
	}
}

func TestHomeMutationRejectsUntrustedInputsBeforeWritingTaskly(t *testing.T) {
	s, _, cookie, _ := homeFixture(t)
	for _, body := range []string{`{}`, `{"completed":null}`, `{"completed":"yes"}`, `{"completed":true,"user_sub":"other"}`, `{"completed":true} {}`, strings.Repeat("a", 1025)} {
		requireStatus(t, homeRequest(s, "PUT", "/api/home/tasks/overall-survey", cookie, body), 400)
	}
	requireStatus(t, homeRequest(s, "PUT", "/api/home/tasks/assigned-visit-99", cookie, `{"completed":true}`), 404)
	requireStatus(t, homeRequest(s, "PUT", "/api/home/tasks/overall-survey", nil, `{"completed":true}`), 401)
	requireStatus(t, request(s, "PUT", "/api/home/tasks/overall-survey", cookie, "https://evil.example.test"), 403)
	requireStatus(t, homeRequest(s, "GET", "/api/home", nil, ""), 401)
}

func TestHomeUnavailableBridgeNeverFabricatesCompletion(t *testing.T) {
	for _, mode := range []string{"network", "unauthenticated", "forbidden", "disabled", "rate", "offline", "redirect", "invalid json", "trailing json", "large", "wrong event", "missing task", "missing flag", "duplicate key", "unsafe url", "zero id"} {
		t.Run(mode, func(t *testing.T) {
			s, f, cookie, canonical := homeFixture(t)
			base := homeBridge(t, s, canonical)
			s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "tasks-api.example.test" {
					return healthyIdentity(r)
				}
				switch mode {
				case "network":
					return nil, errors.New("synthetic offline")
				case "unauthenticated":
					return identityResponse(401, `{}`), nil
				case "forbidden":
					return identityResponse(403, `{}`), nil
				case "disabled":
					return identityResponse(409, `{}`), nil
				case "rate":
					return identityResponse(429, `{}`), nil
				case "offline":
					return identityResponse(500, `{}`), nil
				case "redirect":
					response := identityResponse(302, `{}`)
					response.Header.Set("Location", "https://other.example.test/private")
					return response, nil
				case "invalid json":
					return identityResponse(200, `{`), nil
				case "trailing json":
					return identityResponse(200, `{} {}`), nil
				case "large":
					return identityResponse(200, strings.Repeat(" ", (1<<20)+1)), nil
				}
				response, _ := base(r)
				var payload map[string]any
				_ = json.NewDecoder(response.Body).Decode(&payload)
				tasks := payload["tasks"].([]any)
				switch mode {
				case "wrong event":
					payload["event_id"] = "another-event"
				case "missing task":
					payload["tasks"] = []any{}
				case "missing flag":
					delete(tasks[0].(map[string]any), "completed")
				case "duplicate key":
					payload["tasks"] = append(tasks, tasks[0])
				case "unsafe url":
					tasks[0].(map[string]any)["taskly_url"] = "javascript:alert(1)"
				case "zero id":
					tasks[0].(map[string]any)["task_id"] = 0
				}
				body, _ := json.Marshal(payload)
				return identityResponse(200, string(body)), nil
			})
			expected := map[string]int{"unauthenticated": 401, "forbidden": 403, "disabled": 409, "rate": 429}[mode]
			if expected == 0 {
				expected = 503
			}
			response := homeRequest(s, "GET", "/api/home", cookie, "")
			requireStatus(t, response, expected)
			if strings.Contains(response.Body.String(), `"completed"`) || strings.Contains(response.Body.String(), `"tasks"`) {
				t.Fatal("an unavailable canonical service was presented as unchecked tasks")
			}
			if mode == "unauthenticated" && len(f.sessions) != 0 {
				t.Fatal("revoked identity's local session retained")
			}
			if mode == "rate" && response.Header().Get("Retry-After") != "60" {
				t.Fatal("rate limit lacked bounded retry guidance")
			}
		})
	}
}

func TestHomeSourceValidationAndDependencyFailures(t *testing.T) {
	for _, mode := range []string{"missing metadata", "unsafe action", "invalid due", "missing sheet", "bad page", "duplicate term", "no terms", "bad assignment", "dataset unavailable", "invalid dataset", "preferences unavailable", "unset bridge"} {
		t.Run(mode, func(t *testing.T) {
			s, f, cookie, _ := homeFixture(t)
			var payload map[string]any
			_ = json.Unmarshal(f.dataset, &payload)
			actions := payload["event"].(map[string]any)["task_actions"].(map[string]any)
			switch mode {
			case "missing metadata":
				delete(payload["event"].(map[string]any), "task_actions")
			case "unsafe action":
				actions["visit_survey"].(map[string]any)["url"] = "javascript:alert(1)"
			case "invalid due":
				actions["overall_survey"].(map[string]any)["due_at"] = "tomorrow"
			case "missing sheet":
				payload["documents"] = []any{}
			case "bad page":
				actions["sheet_submission"].(map[string]any)["page"] = 0
			case "duplicate term":
				payload["schedule"] = []any{map[string]any{"term": 1}, map[string]any{"term": 1}}
			case "no terms":
				payload["schedule"] = []any{}
			case "bad assignment":
				payload["companies"] = []any{}
			case "dataset unavailable":
				f.errorDataset = errors.New("offline")
			case "preferences unavailable":
				f.errorPreference = errors.New("offline")
			case "unset bridge":
				s.config.TasklyAPIOrigin = ""
			}
			f.dataset, _ = json.Marshal(payload)
			if mode == "invalid dataset" {
				f.dataset = []byte(`{`)
			}
			requireStatus(t, homeRequest(s, "GET", "/api/home", cookie, ""), 503)
		})
	}
}

func TestHomeWriteRequiresMatchingAuthoritativeResponse(t *testing.T) {
	for _, mode := range []string{"wrong key", "wrong state", "invalid flag", "disabled", "metadata"} {
		t.Run(mode, func(t *testing.T) {
			s, f, cookie, canonical := homeFixture(t)
			base := homeBridge(t, s, canonical)
			s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "tasks-api.example.test" {
					return healthyIdentity(r)
				}
				if mode == "disabled" {
					return identityResponse(409, `{}`), nil
				}
				response, _ := base(r)
				var result tasklyHomeTask
				_ = json.NewDecoder(response.Body).Decode(&result)
				switch mode {
				case "wrong key":
					result.Key = "another-task"
				case "wrong state":
					value := false
					result.Completed = &value
				case "invalid flag":
					result.Completed = nil
				}
				body, _ := json.Marshal(result)
				return identityResponse(200, string(body)), nil
			})
			if mode == "metadata" {
				f.errorDataset = errors.New("offline")
			}
			expected := 503
			if mode == "disabled" {
				expected = 409
			}
			requireStatus(t, homeRequest(s, "PUT", "/api/home/tasks/overall-survey", cookie, `{"completed":true}`), expected)
		})
	}
}

func TestHomeRequestBudgetBoundsAndResetsByIdentity(t *testing.T) {
	var budget homeRequestBudget
	now := time.Now()
	for range 120 {
		if !budget.allow("alice", false, now) {
			t.Fatal("read budget prematurely exhausted")
		}
	}
	if budget.allow("alice", false, now) || !budget.allow("bob", false, now) {
		t.Fatal("read limits not isolated by identity")
	}
	for range 60 {
		if !budget.allow("alice", true, now) {
			t.Fatal("write budget prematurely exhausted")
		}
	}
	if budget.allow("alice", true, now) || !budget.allow("alice", true, now.Add(time.Minute)) {
		t.Fatal("write limit did not expire")
	}
	for i := 0; i < 2048; i++ {
		budget.allow(fmt.Sprint(i), false, now)
	}
	if budget.allow("overflow", false, now) || !budget.allow("overflow", false, now.Add(2*time.Minute)) {
		t.Fatal("budget storage not bounded or expired entries not reclaimed")
	}
	s, _, cookie, _ := homeFixture(t)
	for range 120 {
		s.homeBudget.allow("user-1", false, now)
	}
	response := homeRequest(s, "GET", "/api/home", cookie, "")
	requireStatus(t, response, 429)
	if response.Header().Get("Retry-After") != "60" {
		t.Fatal("missing retry window")
	}
}

func TestHomeTokenContextCannotBeSuppliedByUntrustedHeaders(t *testing.T) {
	s, _, _, _ := homeFixture(t)
	r := httptest.NewRequest("GET", s.config.APIOrigin+"/api/home", nil)
	r.Header.Set("Authorization", "Bearer forged")
	var output any
	if failure := s.tasklyRequest(r, http.MethodGet, "", nil, &output); failure == nil || failure.status != 401 {
		t.Fatal("request header bypassed authenticated session")
	}
	if !safeTasklyURL("http://127.0.0.1:3000/?task=1") || safeTasklyURL("http://remote.example.test/") {
		t.Fatal("unsafe task link scheme accepted")
	}
	if _, _, failure := s.sessionIdentityWithToken(context.Background(), "missing"); failure == nil {
		t.Fatal("missing session had credentials")
	}
}
