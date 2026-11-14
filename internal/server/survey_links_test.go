package server

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestHomeSurveyUsesOneServerDerivedAtomicPair(t *testing.T) {
	s, f, cookie, canonical := homeFixture(t)
	upstream := s.client.Transport
	calls := 0
	s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "tasks-api.example.test" && r.Method == http.MethodPut {
			calls++
			payload, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(strings.NewReader(string(payload)))
			var change map[string]any
			if err := json.Unmarshal(payload, &change); err != nil || len(change) != 3 || change["link_assigned_visit"] != true || !sessionHashPattern.MatchString(change["assignment_scope"].(string)) {
				t.Fatalf("unexpected server pair body %s %v", payload, err)
			}
			if strings.Contains(string(payload), "AM-1") || strings.Contains(string(payload), "user-1") || strings.Contains(string(payload), "example.test") {
				t.Fatal("raw assignment/user/form leaked into bridge body")
			}
		}
		return upstream.RoundTrip(r)
	})
	write := func(completed bool) (HomeTask, []HomeTask) {
		t.Helper()
		body := `{"completed":false}`
		if completed {
			body = `{"completed":true}`
		}
		response := homeRequest(s, "PUT", "/api/home/tasks/visit-survey-1", cookie, body)
		requireStatus(t, response, 200)
		var updated struct {
			HomeTask
			RelatedTasks []HomeTask `json:"related_tasks"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &updated); err != nil || len(updated.RelatedTasks) != 1 {
			t.Fatalf("response=%s err=%v", response.Body.String(), err)
		}
		if strings.Contains(response.Body.String(), "assignment_scope") {
			t.Fatal("private assignment scope exposed to browser")
		}
		return updated.HomeTask, updated.RelatedTasks
	}
	survey, related := write(true)
	if !survey.Completed || !related[0].Completed || related[0].AutoCompletedBy != "visit-survey-1" {
		t.Fatalf("pair not reflected: %#v %#v", survey, related)
	}
	if calls != 1 {
		t.Fatalf("non-atomic bridge calls=%d", calls)
	}
	response := homeRequest(s, "GET", "/api/home", cookie, "")
	requireStatus(t, response, 200)
	if !strings.Contains(response.Body.String(), `"auto_completed_by":"visit-survey-1"`) || strings.Contains(response.Body.String(), "auto_assignment_scope") {
		t.Fatal("scoped automatic ownership missing or raw scope exposed")
	}
	_, related = write(false)
	if related[0].Completed || related[0].AutoCompletedBy != "" {
		t.Fatal("automatic undo not reflected")
	}
	// Existing manual marks are never claimed by the survey path.
	value := true
	target := canonical["assigned-visit-1"]
	target.Completed = &value
	canonical["assigned-visit-1"] = target
	write(true)
	_, related = write(false)
	if !related[0].Completed || related[0].AutoCompletedBy != "" {
		t.Fatal("preexisting manual visit removed")
	}
	// A roster change changes the private scope even for the same term/company.
	value = false
	target = canonical["assigned-visit-1"]
	target.Completed = &value
	canonical["assigned-visit-1"] = target
	write(true)
	var data map[string]any
	if err := json.Unmarshal(f.dataset, &data); err != nil {
		t.Fatal(err)
	}
	assignment := data["assignments"].([]any)[0].(map[string]any)
	assignment["number"] = float64(8)
	f.dataset, _ = json.Marshal(data)
	f.preferences["user-1"] = 8
	response = homeRequest(s, "GET", "/api/home", cookie, "")
	requireStatus(t, response, 200)
	if strings.Contains(response.Body.String(), "auto_completed_by") {
		t.Fatal("old roster automatic ownership reused")
	}
	_, related = write(false)
	if !related[0].Completed || related[0].AutoCompletedBy != "" {
		t.Fatal("changed roster visit was removed")
	}
}

func TestHomeSurveyManualVisitTouchAndRetry(t *testing.T) {
	s, _, cookie, canonical := homeFixture(t)
	put := func(key string, completed bool) {
		t.Helper()
		body := `{"completed":false}`
		if completed {
			body = `{"completed":true}`
		}
		requireStatus(t, homeRequest(s, "PUT", "/api/home/tasks/"+key, cookie, body), 200)
	}
	put("visit-survey-1", true)
	put("assigned-visit-1", true)
	put("visit-survey-1", false)
	if !*canonical["assigned-visit-1"].Completed || canonical["assigned-visit-1"].AutoCompletedBy != "" {
		t.Fatal("manual recheck ownership lost")
	}
	put("assigned-visit-1", false)
	put("visit-survey-1", true)
	// A native Taskly undo changes only the visit flag and retires ownership.
	// Guidance's own automatic visit undo intentionally clears both endpoints.
	value := false
	target := canonical["assigned-visit-1"]
	target.Completed = &value
	target.AutoCompletedBy = ""
	target.AutoAssignmentScope = ""
	canonical["assigned-visit-1"] = target
	put("visit-survey-1", true)
	if *canonical["assigned-visit-1"].Completed {
		t.Fatal("survey true retry restored manually undone visit")
	}
}

func TestHomeSurveyRejectsIncompleteOrWrongPairResponse(t *testing.T) {
	for _, mode := range []string{"missing", "empty", "extra", "wrong-key", "same-task-id", "bad-origin", "scope-only", "wrong-source"} {
		t.Run(mode, func(t *testing.T) {
			s, _, cookie, canonical := homeFixture(t)
			upstream := s.client.Transport
			s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host != "tasks-api.example.test" || r.Method != http.MethodPut {
					return upstream.RoundTrip(r)
				}
				source := canonical["visit-survey-1"]
				value := true
				source.Completed = &value
				target := canonical["assigned-visit-1"]
				var related []tasklyHomeTask
				switch mode {
				case "missing":
					return identityResponse(200, mustJSON(source)), nil
				case "empty":
					related = []tasklyHomeTask{}
				case "extra":
					related = []tasklyHomeTask{target, target}
				case "wrong-key":
					target.Key = "assigned-visit-2"
					related = []tasklyHomeTask{target}
				case "same-task-id":
					target.TaskID = source.TaskID
					related = []tasklyHomeTask{target}
				case "bad-origin":
					target.TasklyURL = "javascript:alert(1)"
					related = []tasklyHomeTask{target}
				case "scope-only":
					target.AutoAssignmentScope = strings.Repeat("a", 64)
					related = []tasklyHomeTask{target}
				case "wrong-source":
					target.AutoCompletedBy = "visit-survey-2"
					target.AutoAssignmentScope = strings.Repeat("a", 64)
					target.Completed = &value
					related = []tasklyHomeTask{target}
				}
				return identityResponse(200, mustJSON(struct {
					tasklyHomeTask
					Related []tasklyHomeTask `json:"related_tasks"`
				}{source, related})), nil
			})
			requireStatus(t, homeRequest(s, "PUT", "/api/home/tasks/visit-survey-1", cookie, `{"completed":true}`), 503)
		})
	}
}

func mustJSON(value any) string { data, _ := json.Marshal(value); return string(data) }

func TestUnassignedSurveyDoesNotRequestOrAcceptPartner(t *testing.T) {
	s, _, cookie, canonical := homeFixture(t)
	upstream := s.client.Transport
	s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "tasks-api.example.test" && r.Method == http.MethodPut {
			body, _ := io.ReadAll(r.Body)
			r.Body = io.NopCloser(strings.NewReader(string(body)))
			if strings.Contains(string(body), "link_assigned") || strings.Contains(string(body), "assignment_scope") {
				t.Fatal("unassigned survey unexpectedly linked")
			}
		}
		return upstream.RoundTrip(r)
	})
	response := homeRequest(s, "PUT", "/api/home/tasks/visit-survey-2", cookie, `{"completed":true}`)
	requireStatus(t, response, 200)
	if strings.Contains(response.Body.String(), "related_tasks") {
		t.Fatal("unassigned survey emitted partner")
	}
	s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "tasks-api.example.test" {
			return upstream.RoundTrip(r)
		}
		source := canonical["visit-survey-2"]
		return identityResponse(200, mustJSON(struct {
			tasklyHomeTask
			Related []tasklyHomeTask `json:"related_tasks"`
		}{source, []tasklyHomeTask{canonical["assigned-visit-1"]}})), nil
	})
	requireStatus(t, homeRequest(s, "PUT", "/api/home/tasks/visit-survey-2", cookie, `{"completed":true}`), 503)
}

func TestHomeReverseVisitUndoUsesCanonicalOwnershipAndRelatedSurvey(t *testing.T) {
	for _, mode := range []string{"automatic", "manual", "scope mismatch"} {
		t.Run(mode, func(t *testing.T) {
			s, _, cookie, canonical := homeFixture(t)
			requireStatus(t, homeRequest(s, "PUT", "/api/home/tasks/visit-survey-1", cookie, `{"completed":true}`), 200)
			target := canonical["assigned-visit-1"]
			if mode == "manual" {
				target.AutoCompletedBy = ""
				target.AutoAssignmentScope = ""
				canonical["assigned-visit-1"] = target
			}
			if mode == "scope mismatch" {
				target.AutoAssignmentScope = strings.Repeat("f", 64)
				canonical["assigned-visit-1"] = target
			}
			response := homeRequest(s, "PUT", "/api/home/tasks/assigned-visit-1", cookie, `{"completed":false}`)
			requireStatus(t, response, 200)
			var result struct {
				HomeTask
				Related []HomeTask `json:"related_tasks"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || len(result.Related) != 1 || result.Related[0].ID != "visit-survey-1" || result.Completed {
				t.Fatalf("reverse=%s err=%v", response.Body.String(), err)
			}
			if result.Related[0].Completed != (mode != "automatic") {
				t.Fatalf("wrong retained survey: %s", response.Body.String())
			}
		})
	}
}
