package server

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

type mysqlHomePayload struct {
	EventID          string     `json:"event_id"`
	RosterConfigured bool       `json:"roster_configured"`
	Tasks            []HomeTask `json:"tasks"`
}

type mysqlHomeUpdate struct {
	HomeTask
	RelatedTasks []HomeTask `json:"related_tasks"`
}

func decodeMySQLHome(t *testing.T, body []byte) mysqlHomePayload {
	t.Helper()
	var result mysqlHomePayload
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatalf("invalid home response: %v", err)
	}
	return result
}

func mysqlHomeTask(t *testing.T, tasks []HomeTask, key string) HomeTask {
	t.Helper()
	for _, task := range tasks {
		if task.ID == key {
			return task
		}
	}
	t.Fatalf("expected home task %s missing", key)
	return HomeTask{}
}

func mysqlHomeWrite(t *testing.T, f *mysqlAPIFixture, client *http.Client, key string, completed bool) mysqlHomeUpdate {
	t.Helper()
	body := `{"completed":false}`
	if completed {
		body = `{"completed":true}`
	}
	response := f.send(t, client, "PUT", "/api/home/tasks/"+key, body, 200)
	var result mysqlHomeUpdate
	if err := json.Unmarshal(response, &result); err != nil {
		t.Fatalf("invalid update response: %v", err)
	}
	if result.ID != key || result.Completed != completed {
		t.Fatalf("primary completion did not match request: %s", response)
	}
	if strings.Contains(string(response), "assignment_scope") {
		t.Fatal("private assignment scope exposed to browser")
	}
	return result
}

func TestMySQLHomePersonalizationAndCanonicalPairFlow(t *testing.T) {
	f := newMySQLAPIFixture(t)
	alice := f.login(t, "alice")
	bob := f.login(t, "bob")
	initial := decodeMySQLHome(t, f.send(t, alice, "GET", "/api/home", "", 200))
	if initial.RosterConfigured || len(initial.Tasks) != 4 || initial.EventID != "synthetic-event" {
		t.Fatal("first login home should remain unconfigured")
	}
	f.send(t, alice, "PUT", "/api/preferences", `{"roster_number":7}`, 200)
	var number int
	if err := f.db.QueryRowContext(context.Background(), "SELECT roster_number FROM guidance_preferences WHERE user_sub=?", "alice").Scan(&number); err != nil || number != 7 {
		t.Fatalf("real SQL preference missing: %v", err)
	}
	configured := decodeMySQLHome(t, f.send(t, alice, "GET", "/api/home?user_sub=bob", "", 200))
	if !configured.RosterConfigured || len(configured.Tasks) != 5 || mysqlHomeTask(t, configured.Tasks, "assigned-visit-1").CompanyID != "AM-1" {
		t.Fatal("home did not join the authenticated SQL preference")
	}
	completed := mysqlHomeWrite(t, f, alice, "visit-survey-1", true)
	if len(completed.RelatedTasks) != 1 || !completed.RelatedTasks[0].Completed || completed.RelatedTasks[0].ID != "assigned-visit-1" || completed.RelatedTasks[0].AutoCompletedBy != "visit-survey-1" {
		t.Fatal("paired canonical result missing")
	}
	reread := decodeMySQLHome(t, f.send(t, alice, "GET", "/api/home", "", 200))
	if mysqlHomeTask(t, reread.Tasks, "assigned-visit-1").AutoCompletedBy != "visit-survey-1" {
		t.Fatal("automatic ownership did not survive a separate SQL-authenticated read")
	}
	f.send(t, bob, "PUT", "/api/preferences", `{"roster_number":8}`, 200)
	other := decodeMySQLHome(t, f.send(t, bob, "GET", "/api/home", "", 200))
	if mysqlHomeTask(t, other.Tasks, "assigned-visit-1").CompanyID != "AM-2" || mysqlHomeTask(t, other.Tasks, "visit-survey-1").Completed {
		t.Fatal("another account inherited Alice's assignment or progress")
	}
	undone := mysqlHomeWrite(t, f, alice, "assigned-visit-1", false)
	if len(undone.RelatedTasks) != 1 || undone.RelatedTasks[0].ID != "visit-survey-1" || undone.RelatedTasks[0].Completed {
		t.Fatal("reverse automatic undo did not return the survey")
	}
	mysqlHomeWrite(t, f, bob, "visit-survey-1", true)
	mysqlHomeWrite(t, f, alice, "visit-survey-1", true)
	mysqlHomeWrite(t, f, alice, "visit-survey-1", false)
	other = decodeMySQLHome(t, f.send(t, bob, "GET", "/api/home", "", 200))
	if !mysqlHomeTask(t, other.Tasks, "assigned-visit-1").Completed || !mysqlHomeTask(t, other.Tasks, "visit-survey-1").Completed {
		t.Fatal("Alice's undo changed Bob's canonical state")
	}
	// An unassigned term and the remaining actions remain ordinary single tasks.
	unassigned := mysqlHomeWrite(t, f, alice, "visit-survey-2", true)
	if len(unassigned.RelatedTasks) != 0 {
		t.Fatal("unassigned survey was incorrectly paired")
	}
	for _, key := range []string{"overall-survey", "sheet-submission"} {
		updated := mysqlHomeWrite(t, f, alice, key, true)
		if len(updated.RelatedTasks) != 0 {
			t.Fatal("independent action acquired an unrelated partner")
		}
	}
}

func TestMySQLHomeManualOwnershipAndRosterScope(t *testing.T) {
	f := newMySQLAPIFixture(t)
	alice := f.login(t, "alice")
	f.send(t, alice, "PUT", "/api/preferences", `{"roster_number":7}`, 200)
	// Seed a pre-existing external/manual visit; the survey never owns it.
	f.nativeTask("alice", "assigned-visit-1", true)
	mysqlHomeWrite(t, f, alice, "visit-survey-1", true)
	result := mysqlHomeWrite(t, f, alice, "visit-survey-1", false)
	if len(result.RelatedTasks) != 1 || !result.RelatedTasks[0].Completed || result.RelatedTasks[0].AutoCompletedBy != "" {
		t.Fatal("pre-existing manual visit was removed or claimed")
	}
	f.nativeTask("alice", "assigned-visit-1", false)
	mysqlHomeWrite(t, f, alice, "visit-survey-1", true)
	// Explicit manual reconfirmation of the source retires the automatic link.
	f.nativeTask("alice", "visit-survey-1", true)
	result = mysqlHomeWrite(t, f, alice, "assigned-visit-1", false)
	if len(result.RelatedTasks) != 1 || !result.RelatedTasks[0].Completed {
		t.Fatal("manual source reconfirmation was erased")
	}
	f.nativeTask("alice", "visit-survey-1", false)
	mysqlHomeWrite(t, f, alice, "visit-survey-1", true)
	f.nativeTask("alice", "assigned-visit-1", false)
	retry := mysqlHomeWrite(t, f, alice, "visit-survey-1", true)
	if len(retry.RelatedTasks) != 1 || retry.RelatedTasks[0].Completed {
		t.Fatal("idempotent true recreated a manually undone visit")
	}
	// The persisted roster choice changes the scope even though the logical
	// task key is shared. A stale automatic link must not clear the new survey.
	f.nativeTask("alice", "visit-survey-1", false)
	mysqlHomeWrite(t, f, alice, "visit-survey-1", true)
	f.send(t, alice, "PUT", "/api/preferences", `{"roster_number":8}`, 200)
	changed := decodeMySQLHome(t, f.send(t, alice, "GET", "/api/home", "", 200))
	visit := mysqlHomeTask(t, changed.Tasks, "assigned-visit-1")
	if visit.CompanyID != "AM-2" || visit.AutoCompletedBy != "" || !visit.Completed {
		t.Fatal("new roster incorrectly inherited scoped ownership")
	}
	result = mysqlHomeWrite(t, f, alice, "assigned-visit-1", false)
	if len(result.RelatedTasks) != 1 || !result.RelatedTasks[0].Completed {
		t.Fatal("scope-mismatched reverse undo removed the survey")
	}
}

func TestMySQLHomeStrictPublicUpdatesAndUnavailableDefinitions(t *testing.T) {
	f := newMySQLAPIFixture(t)
	alice := f.login(t, "alice")
	f.send(t, alice, "PUT", "/api/preferences", `{"roster_number":7}`, 200)
	for _, body := range []string{`{}`, `null`, `{"completed":null}`, `{"completed":"true"}`, `{"completed":true,"user_sub":"bob"}`, `{"completed":true,"assignment_scope":"injected"}`, `{"completed":true} {}`, strings.Repeat(" ", 1025)} {
		f.send(t, alice, "PUT", "/api/home/tasks/overall-survey", body, 400)
	}
	f.send(t, alice, "PUT", "/api/home/tasks/assigned-visit-99", `{"completed":true}`, 404)
	var original []byte
	if err := f.db.QueryRowContext(context.Background(), "SELECT payload FROM guidance_dataset WHERE id=1").Scan(&original); err != nil {
		t.Fatal(err)
	}
	change := func(t *testing.T, modify func(map[string]any)) {
		t.Helper()
		var data map[string]any
		if err := json.Unmarshal(original, &data); err != nil {
			t.Fatal(err)
		}
		modify(data)
		raw, err := json.Marshal(data)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.ExecContext(context.Background(), "UPDATE guidance_dataset SET payload=? WHERE id=1", raw); err != nil {
			t.Fatal(err)
		}
		f.send(t, alice, "GET", "/api/home", "", 503)
	}
	t.Run("missing actions", func(t *testing.T) {
		change(t, func(data map[string]any) { data["event"].(map[string]any)["task_actions"] = map[string]any{} })
	})
	t.Run("wrong top-level JSON shape", func(t *testing.T) {
		if _, err := f.db.ExecContext(context.Background(), "UPDATE guidance_dataset SET payload='[]' WHERE id=1"); err != nil {
			t.Fatal(err)
		}
		f.send(t, alice, "GET", "/api/home", "", 503)
	})
	t.Run("invalid action URL", func(t *testing.T) {
		change(t, func(data map[string]any) {
			actions := data["event"].(map[string]any)["task_actions"].(map[string]any)
			actions["visit_survey"].(map[string]any)["url"] = "javascript:alert(1)"
		})
	})
	t.Run("empty schedule", func(t *testing.T) { change(t, func(data map[string]any) { data["schedule"] = []any{} }) })
	t.Run("duplicate term", func(t *testing.T) {
		change(t, func(data map[string]any) {
			data["schedule"] = []any{map[string]any{"term": 1}, map[string]any{"term": 1}}
		})
	})
	t.Run("invalid term", func(t *testing.T) {
		change(t, func(data map[string]any) { data["schedule"] = []any{map[string]any{"term": 100}} })
	})
	t.Run("oversized schedule", func(t *testing.T) {
		change(t, func(data map[string]any) {
			var schedule []any
			for term := 1; term <= 31; term++ {
				schedule = append(schedule, map[string]any{"term": term})
			}
			data["schedule"] = schedule
		})
	})
	for _, mode := range []string{"missing company", "duplicate assignment term", "unknown assigned term"} {
		t.Run(mode, func(t *testing.T) {
			change(t, func(data map[string]any) {
				assignment := data["assignments"].([]any)[0].(map[string]any)
				visits := assignment["visits"].([]any)
				visit := visits[0].(map[string]any)
				switch mode {
				case "missing company":
					visit["company_id"] = "missing"
				case "duplicate assignment term":
					assignment["visits"] = append(visits, visits[0])
				case "unknown assigned term":
					visit["term"] = 99
				}
			})
		})
	}
	if _, err := f.db.ExecContext(context.Background(), "UPDATE guidance_dataset SET payload=? WHERE id=1", original); err != nil {
		t.Fatal(err)
	}
	// A real SQL lookup failure must not fabricate an unconfigured home.
	if _, err := f.db.ExecContext(context.Background(), "RENAME TABLE guidance_preferences TO guidance_preferences_coverage_held"); err != nil {
		t.Fatal(err)
	}
	renamed := true
	defer func() {
		if renamed {
			_, _ = f.db.ExecContext(context.Background(), "RENAME TABLE guidance_preferences_coverage_held TO guidance_preferences")
		}
	}()
	f.send(t, alice, "GET", "/api/home", "", 503)
	if _, err := f.db.ExecContext(context.Background(), "RENAME TABLE guidance_preferences_coverage_held TO guidance_preferences"); err != nil {
		t.Fatal(err)
	}
	renamed = false
	if _, err := f.db.ExecContext(context.Background(), "DELETE FROM guidance_dataset WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	f.send(t, alice, "GET", "/api/home", "", 503)
	f.send(t, alice, "PUT", "/api/home/tasks/overall-survey", `{"completed":true}`, 503)
}

func mysqlHomeWireTask(key string, id uint64, completed bool) map[string]any {
	return map[string]any{"key": key, "task_id": id, "completed": completed, "completion_disabled": false, "taskly_url": "https://taskly.example.test/"}
}
func mysqlHomeWireJSON(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}
func mysqlHomeWireList() []map[string]any {
	return []map[string]any{mysqlHomeWireTask("assigned-visit-1", 1, false), mysqlHomeWireTask("visit-survey-1", 2, false), mysqlHomeWireTask("visit-survey-2", 3, false), mysqlHomeWireTask("overall-survey", 4, false), mysqlHomeWireTask("sheet-submission", 5, false)}
}

func TestMySQLHomeRejectsMalformedTasklySnapshots(t *testing.T) {
	f := newMySQLAPIFixture(t)
	alice := f.login(t, "alice")
	f.send(t, alice, "PUT", "/api/preferences", `{"roster_number":7}`, 200)
	for _, mode := range []string{"invalid JSON", "wrong event", "too many", "duplicate", "missing required", "blank key", "long key", "zero ID", "missing completed", "missing disabled", "unsafe URL", "scope only", "wrong source", "malformed scope", "oversized body"} {
		t.Run(mode, func(t *testing.T) {
			tasks := mysqlHomeWireList()
			event := "synthetic-event"
			raw := ""
			switch mode {
			case "invalid JSON":
				raw = "{"
			case "wrong event":
				event = "another-event"
			case "too many":
				for len(tasks) < 65 {
					tasks = append(tasks, mysqlHomeWireTask("unused", 999, false))
				}
			case "duplicate":
				tasks = append(tasks, tasks[0])
			case "missing required":
				tasks = tasks[1:]
			case "blank key":
				tasks[0]["key"] = ""
			case "long key":
				tasks[0]["key"] = strings.Repeat("x", 129)
			case "zero ID":
				tasks[0]["task_id"] = 0
			case "missing completed":
				delete(tasks[0], "completed")
			case "missing disabled":
				delete(tasks[0], "completion_disabled")
			case "unsafe URL":
				tasks[0]["taskly_url"] = "http://remote.example.test/"
			case "scope only":
				tasks[0]["auto_assignment_scope"] = strings.Repeat("a", 64)
			case "wrong source":
				tasks[0]["completed"] = true
				tasks[0]["auto_completed_by"] = "visit-survey-2"
				tasks[0]["auto_assignment_scope"] = strings.Repeat("a", 64)
			case "malformed scope":
				tasks[0]["completed"] = true
				tasks[0]["auto_completed_by"] = "visit-survey-1"
				tasks[0]["auto_assignment_scope"] = "invalid"
			case "oversized body":
				raw = strings.Repeat(" ", (1<<20)+1)
			}
			if raw == "" {
				raw = mysqlHomeWireJSON(t, map[string]any{"event_id": event, "tasks": tasks})
			}
			f.mu.Lock()
			f.tasklyPayload = raw
			f.mu.Unlock()
			f.send(t, alice, "GET", "/api/home", "", 503)
		})
	}
	f.mu.Lock()
	f.tasklyPayload = ""
	f.mu.Unlock()
	f.send(t, alice, "GET", "/api/home", "", 200)
}

func TestMySQLHomeRejectsMalformedPairAcknowledgements(t *testing.T) {
	f := newMySQLAPIFixture(t)
	alice := f.login(t, "alice")
	f.send(t, alice, "PUT", "/api/preferences", `{"roster_number":7}`, 200)
	for _, mode := range []string{"wrong primary key", "wrong primary completed", "missing partner", "empty partner", "duplicate partner", "wrong partner", "same task ID", "invalid partner", "invalid source"} {
		t.Run(mode, func(t *testing.T) {
			source := mysqlHomeWireTask("visit-survey-1", 2, true)
			target := mysqlHomeWireTask("assigned-visit-1", 1, true)
			source["related_tasks"] = []any{target}
			switch mode {
			case "wrong primary key":
				source["key"] = "overall-survey"
			case "wrong primary completed":
				source["completed"] = false
			case "missing partner":
				delete(source, "related_tasks")
			case "empty partner":
				source["related_tasks"] = []any{}
			case "duplicate partner":
				source["related_tasks"] = []any{target, target}
			case "wrong partner":
				target["key"] = "assigned-visit-2"
			case "same task ID":
				target["task_id"] = 2
			case "invalid partner":
				delete(target, "completed")
			case "invalid source":
				delete(source, "task_id")
			}
			f.mu.Lock()
			f.tasklyPayload = mysqlHomeWireJSON(t, source)
			f.mu.Unlock()
			f.send(t, alice, "PUT", "/api/home/tasks/visit-survey-1", `{"completed":true}`, 503)
		})
	}
	// Independent tasks must not accept an unsolicited partner either.
	source := mysqlHomeWireTask("overall-survey", 4, true)
	source["related_tasks"] = []any{mysqlHomeWireTask("assigned-visit-1", 1, false)}
	f.mu.Lock()
	f.tasklyPayload = mysqlHomeWireJSON(t, source)
	f.mu.Unlock()
	f.send(t, alice, "PUT", "/api/home/tasks/overall-survey", `{"completed":true}`, 503)
}

func TestMySQLHomeTasklyFailuresPreserveSQLSession(t *testing.T) {
	for _, status := range []int{403, 409, 429, 500} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			f := newMySQLAPIFixture(t)
			alice := f.login(t, "alice")
			f.send(t, alice, "PUT", "/api/preferences", `{"roster_number":7}`, 200)
			f.mu.Lock()
			f.tasklyStatus = status
			f.mu.Unlock()
			expected := status
			if status == 500 {
				expected = 503
			}
			f.send(t, alice, "GET", "/api/home", "", expected)
			f.send(t, alice, "PUT", "/api/home/tasks/visit-survey-1", `{"completed":true}`, expected)
			var count int
			if err := f.db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM guidance_sessions").Scan(&count); err != nil || count != 1 {
				t.Fatalf("upstream error erased SQL session: count%d %v", count, err)
			}
		})
	}
	t.Run("unauthorized bridge clears only local session", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		alice := f.login(t, "alice")
		f.mu.Lock()
		f.tasklyStatus = 401
		f.mu.Unlock()
		f.send(t, alice, "GET", "/api/home", "", 401)
		var count int
		if err := f.db.QueryRowContext(context.Background(), "SELECT COUNT(*) FROM guidance_sessions").Scan(&count); err != nil || count != 0 {
			t.Fatalf("local session not invalidated: count%d %v", count, err)
		}
	})
	t.Run("redirect never forwards credentials", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		alice := f.login(t, "alice")
		f.mu.Lock()
		f.tasklyRedirect = "https://unreachable.example.test/"
		f.mu.Unlock()
		f.send(t, alice, "GET", "/api/home", "", 503)
	})
	t.Run("transport failure", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		alice := f.login(t, "alice")
		f.taskly.Close()
		f.send(t, alice, "GET", "/api/home", "", 503)
	})
}

func TestMySQLHomeReadAndWriteRateLimits(t *testing.T) {
	f := newMySQLAPIFixture(t)
	alice := f.login(t, "alice")
	f.send(t, alice, "PUT", "/api/preferences", `{"roster_number":7}`, 200)
	for index := 0; index < 120; index++ {
		f.send(t, alice, "GET", "/api/home", "", 200)
	}
	f.send(t, alice, "GET", "/api/home", "", 429)
	for index := 0; index < 60; index++ {
		f.send(t, alice, "PUT", "/api/home/tasks/overall-survey", `{"completed":true}`, 200)
	}
	f.send(t, alice, "PUT", "/api/home/tasks/overall-survey", `{"completed":false}`, 429)
	f.mu.Lock()
	task := f.tasks["alice"]["overall-survey"]
	completed := task.Completed != nil && *task.Completed
	f.mu.Unlock()
	if !completed {
		t.Fatal("rate-limited request mutated the external canonical task")
	}
}

func TestMySQLHomeStalePersistedRosterDoesNotInventAnAssignment(t *testing.T) {
	f := newMySQLAPIFixture(t)
	alice := f.login(t, "alice")
	f.send(t, alice, "PUT", "/api/preferences", `{"roster_number":7}`, 200)
	// An imported catalog may no longer contain a previously saved valid number.
	// Keep that real SQL preference and require a neutral, unconfigured home.
	if _, err := f.db.ExecContext(context.Background(), "UPDATE guidance_preferences SET roster_number=99 WHERE user_sub=?", "alice"); err != nil {
		t.Fatal(err)
	}
	result := decodeMySQLHome(t, f.send(t, alice, "GET", "/api/home", "", 200))
	if result.RosterConfigured || len(result.Tasks) != 4 || mysqlHomeTask(t, result.Tasks, "visit-survey-1").CompanyID != "" {
		t.Fatal("stale roster fabricated an assigned company")
	}
	f.send(t, alice, "PUT", "/api/home/tasks/assigned-visit-1", `{"completed":true}`, 404)
	updated := mysqlHomeWrite(t, f, alice, "visit-survey-1", true)
	if len(updated.RelatedTasks) != 0 {
		t.Fatal("stale roster survey acquired an assigned partner")
	}
}
