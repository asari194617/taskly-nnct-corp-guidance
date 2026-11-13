package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	guidancedata "github.com/asari194617/taskly-nnct-corp-guidance/internal/guidance"
)

var tasklyEventPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

type HomeTask struct {
	ID                 string `json:"id"`
	Kind               string `json:"kind"`
	Title              string `json:"title"`
	Completed          bool   `json:"completed"`
	CompletionDisabled bool   `json:"completion_disabled"`
	TasklyURL          string `json:"taskly_url"`
	CompanyID          string `json:"company_id,omitempty"`
	Term               int    `json:"term,omitempty"`
	URL                string `json:"url,omitempty"`
	DocumentID         string `json:"document_id,omitempty"`
	Page               int    `json:"page,omitempty"`
	DueAt              string `json:"due_at,omitempty"`
}

type homeDataset struct {
	Event struct {
		TaskActions map[string]guidancedata.TaskAction `json:"task_actions"`
	} `json:"event"`
	Companies []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"companies"`
	Schedule []struct {
		Term int `json:"term"`
	} `json:"schedule"`
	Assignments []struct {
		Department string `json:"department"`
		Grade      int    `json:"grade"`
		Number     int    `json:"number"`
		Visits     []struct {
			Term      int    `json:"term"`
			CompanyID string `json:"company_id"`
		} `json:"visits"`
	} `json:"assignments"`
	Documents []struct {
		ID       string `json:"id"`
		MIMEType string `json:"mime_type"`
	} `json:"documents"`
}

func safeTasklyURL(raw string) bool {
	if guidancedata.IsHTTPSURL(raw) {
		return true
	}
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "http" && parsed.User == nil && parsed.Host != "" && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1")
}

func (s *Server) homeTaskDefinitions(ctx context.Context, user User) ([]HomeTask, bool, error) {
	payload, err := s.store.Dataset(ctx)
	if err != nil {
		return nil, false, err
	}
	var data homeDataset
	if json.Unmarshal(payload, &data) != nil {
		return nil, false, errors.New("invalid home dataset")
	}
	visit, overall, sheet := data.Event.TaskActions["visit_survey"], data.Event.TaskActions["overall_survey"], data.Event.TaskActions["sheet_submission"]
	documents := make(map[string]string, len(data.Documents))
	for _, document := range data.Documents {
		documents[document.ID] = document.MIMEType
	}
	for _, kind := range []string{"visit_survey", "overall_survey", "sheet_submission"} {
		if _, exists := data.Event.TaskActions[kind]; !exists {
			return nil, false, errors.New("home actions unavailable")
		}
	}
	if err := guidancedata.ValidateTaskActions(data.Event.TaskActions, documents); err != nil {
		return nil, false, err
	}
	preferences, ok := s.store.(PreferencesStore)
	if !ok {
		return nil, false, errors.New("home preferences unavailable")
	}
	number, err := preferences.Preference(ctx, user.Sub)
	if err != nil {
		return nil, false, err
	}
	companies := make(map[string]string, len(data.Companies))
	for _, company := range data.Companies {
		companies[company.ID] = company.Name
	}
	terms := make(map[int]bool)
	for _, slot := range data.Schedule {
		if slot.Term == 0 {
			continue
		}
		if slot.Term < 1 || slot.Term > 99 || terms[slot.Term] {
			return nil, false, errors.New("invalid home schedule")
		}
		terms[slot.Term] = true
	}
	if len(terms) == 0 || len(terms) > 30 {
		return nil, false, errors.New("home schedule unavailable")
	}
	assigned := make(map[int]string)
	rosterConfigured := false
	if number != nil {
		for _, assignment := range data.Assignments {
			if assignment.Department != defaultDepartment || assignment.Grade != defaultGrade || assignment.Number != *number {
				continue
			}
			rosterConfigured = true
			for _, visit := range assignment.Visits {
				if !terms[visit.Term] || assigned[visit.Term] != "" || companies[visit.CompanyID] == "" {
					return nil, false, errors.New("invalid home assignment")
				}
				assigned[visit.Term] = visit.CompanyID
			}
			break
		}
	}
	ordered := make([]int, 0, len(terms))
	for term := range terms {
		ordered = append(ordered, term)
	}
	sort.Ints(ordered)
	tasks := make([]HomeTask, 0, len(terms)+len(assigned)+2)
	for _, term := range ordered {
		if company := assigned[term]; company != "" {
			tasks = append(tasks, HomeTask{ID: fmt.Sprintf("assigned-visit-%d", term), Kind: "assigned_visit", Title: companies[company] + "を見学", CompanyID: company, Term: term})
		}
	}
	for _, term := range ordered {
		tasks = append(tasks, HomeTask{ID: fmt.Sprintf("visit-survey-%d", term), Kind: "visit_survey", Title: fmt.Sprintf("見学アンケートに回答（ターム%d）", term), CompanyID: assigned[term], Term: term, URL: visit.URL, DueAt: visit.DueAt})
	}
	tasks = append(tasks,
		HomeTask{ID: "overall-survey", Kind: "overall_survey", Title: "全体アンケートに回答", URL: overall.URL, DueAt: overall.DueAt},
		HomeTask{ID: "sheet-submission", Kind: "sheet_submission", Title: "見学シートを提出", DocumentID: sheet.DocumentID, Page: sheet.Page, DueAt: sheet.DueAt},
	)
	return tasks, rosterConfigured, nil
}

type tasklyHomeTask struct {
	Key                string `json:"key"`
	TaskID             uint64 `json:"task_id"`
	Completed          *bool  `json:"completed"`
	CompletionDisabled *bool  `json:"completion_disabled"`
	TasklyURL          string `json:"taskly_url"`
}

func (task tasklyHomeTask) valid() bool {
	return task.Key != "" && len(task.Key) <= 128 && task.TaskID > 0 && task.Completed != nil && task.CompletionDisabled != nil && safeTasklyURL(task.TasklyURL)
}

func joinHomeTask(definition HomeTask, canonical tasklyHomeTask) HomeTask {
	definition.Completed = *canonical.Completed
	definition.CompletionDisabled = *canonical.CompletionDisabled
	definition.TasklyURL = canonical.TasklyURL
	return definition
}

type homeBridgeFailure struct {
	status int
	code   string
}

func (e *homeBridgeFailure) Error() string { return e.code }

func (s *Server) tasklyRequest(r *http.Request, method, key string, completed *bool, output any) *homeBridgeFailure {
	if s.config.TasklyAPIOrigin == "" || s.config.TasklyEventID == "" {
		return &homeBridgeFailure{503, "taskly_unavailable"}
	}
	token, _ := r.Context().Value(authenticatedAccessTokenKey{}).(string)
	if token == "" {
		return &homeBridgeFailure{401, "authentication_required"}
	}
	endpoint := s.config.TasklyAPIOrigin + "/integrations/nnct-guidance/tasks"
	if key != "" {
		endpoint += "/" + url.PathEscape(key)
	}
	var body io.Reader
	if completed != nil {
		body = strings.NewReader(fmt.Sprintf(`{"completed":%t}`, *completed))
	}
	request, err := http.NewRequestWithContext(r.Context(), method, endpoint, body)
	if err != nil {
		return &homeBridgeFailure{503, "taskly_unavailable"}
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-Guidance-Event-ID", s.config.TasklyEventID)
	request.Header.Set("Accept", "application/json")
	if completed != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	// The bridge receives only the validated OAuth credential, never browser
	// cookies. Redirects cannot forward it elsewhere; a slow bridge stays scoped
	// to this home widget rather than holding the API request open indefinitely.
	client := &http.Client{
		Transport:     s.client.Transport,
		Timeout:       5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	response, err := client.Do(request)
	if err != nil {
		return &homeBridgeFailure{503, "taskly_unavailable"}
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		switch response.StatusCode {
		case 401:
			return &homeBridgeFailure{401, "authentication_required"}
		case 403:
			return &homeBridgeFailure{403, "taskly_forbidden"}
		case 409:
			return &homeBridgeFailure{409, "completion_disabled"}
		case 429:
			return &homeBridgeFailure{429, "taskly_rate_limited"}
		default:
			return &homeBridgeFailure{503, "taskly_unavailable"}
		}
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	if err != nil || len(payload) > 1<<20 || json.Unmarshal(bytes.TrimSpace(payload), output) != nil {
		return &homeBridgeFailure{503, "taskly_unavailable"}
	}
	return nil
}

func (s *Server) homeFailure(w http.ResponseWriter, r *http.Request, problem *homeBridgeFailure) {
	if problem.status == 401 {
		if cookie, err := r.Cookie(s.sessionCookieName()); err == nil {
			_ = s.store.DeleteSession(r.Context(), digest(cookie.Value))
		}
		s.clearCookie(w, s.sessionCookieName())
	}
	if problem.status == 429 {
		w.Header().Set("Retry-After", "60")
	}
	failure(w, problem.status, problem.code)
}

func (s *Server) home(w http.ResponseWriter, r *http.Request, user User) {
	if !s.homeAllowed(w, user.Sub, false) {
		return
	}
	definitions, configured, err := s.homeTaskDefinitions(r.Context(), user)
	if err != nil {
		failure(w, 503, "home_tasks_unavailable")
		return
	}
	var response struct {
		EventID string           `json:"event_id"`
		Tasks   []tasklyHomeTask `json:"tasks"`
	}
	if problem := s.tasklyRequest(r, http.MethodGet, "", nil, &response); problem != nil {
		s.homeFailure(w, r, problem)
		return
	}
	if response.EventID != s.config.TasklyEventID || len(response.Tasks) > 64 {
		failure(w, 503, "taskly_unavailable")
		return
	}
	canonical := make(map[string]tasklyHomeTask, len(response.Tasks))
	for _, task := range response.Tasks {
		if !task.valid() || canonical[task.Key].Key != "" {
			failure(w, 503, "taskly_unavailable")
			return
		}
		canonical[task.Key] = task
	}
	for index, definition := range definitions {
		task, ok := canonical[definition.ID]
		if !ok {
			failure(w, 503, "taskly_unavailable")
			return
		}
		definitions[index] = joinHomeTask(definition, task)
	}
	respond(w, 200, map[string]any{"event_id": response.EventID, "roster_configured": configured, "tasks": definitions})
}

func (s *Server) setHomeTask(w http.ResponseWriter, r *http.Request, user User) {
	if !s.homeAllowed(w, user.Sub, true) {
		return
	}
	var input struct {
		Completed *bool `json:"completed"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF || input.Completed == nil {
		failure(w, 400, "invalid_task_update")
		return
	}
	definitions, _, err := s.homeTaskDefinitions(r.Context(), user)
	if err != nil {
		failure(w, 503, "home_tasks_unavailable")
		return
	}
	key := r.PathValue("key")
	var definition *HomeTask
	for index := range definitions {
		if definitions[index].ID == key {
			definition = &definitions[index]
			break
		}
	}
	if definition == nil {
		failure(w, 404, "home_task_not_found")
		return
	}
	var updated tasklyHomeTask
	if problem := s.tasklyRequest(r, http.MethodPut, key, input.Completed, &updated); problem != nil {
		s.homeFailure(w, r, problem)
		return
	}
	if !updated.valid() || updated.Key != key || *updated.Completed != *input.Completed {
		failure(w, 503, "taskly_unavailable")
		return
	}
	respond(w, 200, joinHomeTask(*definition, updated))
}

type homeRequestWindow struct {
	start  time.Time
	reads  int
	writes int
}

type homeRequestBudget struct {
	mu    sync.Mutex
	users map[string]homeRequestWindow
}

func (budget *homeRequestBudget) allow(subject string, write bool, now time.Time) bool {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	if budget.users == nil {
		budget.users = make(map[string]homeRequestWindow)
	}
	if len(budget.users) >= 2048 {
		for key, window := range budget.users {
			if now.Sub(window.start) >= time.Minute {
				delete(budget.users, key)
			}
		}
	}
	window, exists := budget.users[subject]
	if !exists && len(budget.users) >= 2048 {
		return false
	}
	if now.Sub(window.start) >= time.Minute {
		window = homeRequestWindow{start: now}
	}
	if write {
		if window.writes >= 60 {
			return false
		}
		window.writes++
	} else {
		if window.reads >= 120 {
			return false
		}
		window.reads++
	}
	budget.users[subject] = window
	return true
}

func (s *Server) homeAllowed(w http.ResponseWriter, subject string, write bool) bool {
	if s.homeBudget.allow(subject, write, time.Now()) {
		return true
	}
	w.Header().Set("Retry-After", strconv.Itoa(60))
	failure(w, 429, "taskly_rate_limited")
	return false
}
