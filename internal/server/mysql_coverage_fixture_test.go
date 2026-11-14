package server

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
)

const mysqlCoverageDataset = `{"event":{"title":"Synthetic SQL integration event","task_actions":{"visit_survey":{"url":"https://forms.example.test/visit","due_at":"2030-05-15T00:00:00+09:00"},"overall_survey":{"url":"https://forms.example.test/overall"},"sheet_submission":{"document_id":"guide","page":3}}},"companies":[{"id":"AM-1","name":"Synthetic Alpha","session":"AM","booth":1,"industries":[]},{"id":"AM-2","name":"Synthetic Beta","session":"AM","booth":2,"industries":[]}],"schedule":[{"term":1},{"term":2}],"assignments":[{"department":"電子制御工学科","grade":4,"number":7,"visits":[{"term":1,"company_id":"AM-1"}]},{"department":"電子制御工学科","grade":4,"number":8,"visits":[{"term":1,"company_id":"AM-2"}]}],"documents":[{"id":"guide","mime_type":"application/pdf"}],"notices":[]}`

type mysqlAPIFixture struct {
	db                                                                           *sql.DB
	app                                                                          *Server
	cfg                                                                          Config
	api, issuer, taskly, objects                                                 *httptest.Server
	mu                                                                           sync.Mutex
	loginSub                                                                     string
	serial                                                                       int
	codes                                                                        map[string]struct{ subject, challenge string }
	accesses, refreshes                                                          map[string]string
	tasks                                                                        map[string]map[string]tasklyHomeTask
	userinfoStatus, refreshStatus, tokenStatus, tasklyStatus                     int
	userinfoPayload, refreshPayload, tokenPayload, tasklyPayload, tasklyRedirect string
}

func newMySQLAPIFixture(t *testing.T) *mysqlAPIFixture {
	t.Helper()
	dsn := os.Getenv("MYSQL_TEST_DSN")
	if dsn == "" {
		t.Skip("MYSQL_TEST_DSN unset; requires disposable MySQL")
	}
	connection, err := mysql.ParseDSN(dsn)
	if err != nil || (!strings.HasSuffix(connection.DBName, "_test") && !strings.HasSuffix(connection.DBName, "_e2e")) {
		t.Fatal("integration fixture requires a disposable _test or _e2e database")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal("cannot open disposable integration database")
	}
	t.Cleanup(func() { db.Close() })
	db.SetMaxOpenConns(8)
	ddl, err := os.ReadFile("../../schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range strings.Split(string(ddl), ";") {
		if strings.TrimSpace(statement) != "" {
			if _, err := db.Exec(statement); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, table := range []string{"guidance_preferences", "guidance_bookmarks", "guidance_sessions", "guidance_oauth_flows", "guidance_documents", "guidance_dataset"} {
		if _, err := db.Exec("DELETE FROM " + table); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("INSERT INTO guidance_dataset(id,payload) VALUES(1,?)", mysqlCoverageDataset); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO guidance_documents(id,file_name,mime_type,title) VALUES ('guide','synthetic.pdf','application/pdf','Synthetic guide')"); err != nil {
		t.Fatal(err)
	}
	f := &mysqlAPIFixture{db: db, codes: map[string]struct{ subject, challenge string }{}, accesses: map[string]string{}, refreshes: map[string]string{}, tasks: map[string]map[string]tasklyHomeTask{}}
	f.issuer = httptest.NewServer(http.HandlerFunc(f.serveIssuer))
	t.Cleanup(f.issuer.Close)
	f.taskly = httptest.NewServer(http.HandlerFunc(f.serveTaskly))
	t.Cleanup(f.taskly.Close)
	f.objects = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/pdf")
		w.Header().Set("Cache-Control", "no-store")
		http.ServeContent(w, r, "synthetic.pdf", time.Time{}, strings.NewReader("%PDF-1.4 synthetic fixture document"))
	}))
	t.Cleanup(f.objects.Close)
	f.api = httptest.NewUnstartedServer(nil)
	f.cfg = Config{UIOrigin: "http://127.0.0.1:3000", APIOrigin: "http://" + f.api.Listener.Addr().String(), AuthIssuer: f.issuer.URL, ClientID: "synthetic-coverage-client", EncryptionKey: make([]byte, 32), R2Endpoint: f.objects.URL, R2Bucket: "synthetic-documents", R2AccessKeyID: "synthetic-access", R2SecretKey: "synthetic-secret", TasklyAPIOrigin: f.taskly.URL, TasklyEventID: "synthetic-event"}
	f.app, err = New(f.cfg, SQLStore{DB: db}, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.api.Config.Handler = f.app.Handler()
	f.api.Start()
	t.Cleanup(f.api.Close)
	return f
}

func (f *mysqlAPIFixture) issue(subject string) oauthTokens {
	f.serial++
	access := fmt.Sprintf("synthetic-access-%d", f.serial)
	refresh := fmt.Sprintf("synthetic-refresh-%d", f.serial)
	f.accesses[access] = subject
	f.refreshes[refresh] = subject
	return oauthTokens{AccessToken: access, RefreshToken: refresh, TokenType: "Bearer", ExpiresIn: 900}
}

func (f *mysqlAPIFixture) serveIssuer(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/oauth/authorize":
		q := r.URL.Query()
		code := "synthetic-code-" + q.Get("state")
		f.codes[code] = struct{ subject, challenge string }{f.loginSub, q.Get("code_challenge")}
		callback := q.Get("redirect_uri") + "?code=" + url.QueryEscape(code) + "&state=" + url.QueryEscape(q.Get("state")) + "&iss=" + url.QueryEscape(f.issuer.URL)
		http.Redirect(w, r, callback, 302)
	case "/oauth/token":
		r.ParseForm()
		if r.Form.Get("client_id") != f.cfg.ClientID || r.Header.Get("Authorization") != "" {
			w.WriteHeader(401)
			return
		}
		if r.Form.Get("grant_type") == "refresh_token" {
			if f.refreshStatus != 0 {
				w.WriteHeader(f.refreshStatus)
				io.WriteString(w, f.refreshPayload)
				return
			}
			if f.refreshPayload != "" {
				io.WriteString(w, f.refreshPayload)
				return
			}
			token := r.Form.Get("refresh_token")
			subject := f.refreshes[token]
			if subject == "" {
				w.WriteHeader(400)
				return
			}
			delete(f.refreshes, token)
			json.NewEncoder(w).Encode(f.issue(subject))
			return
		}
		if f.tokenStatus != 0 {
			w.WriteHeader(f.tokenStatus)
			io.WriteString(w, f.tokenPayload)
			return
		}
		if f.tokenPayload != "" {
			io.WriteString(w, f.tokenPayload)
			return
		}
		code := r.Form.Get("code")
		flow, ok := f.codes[code]
		hash := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if !ok || flow.challenge != base64.RawURLEncoding.EncodeToString(hash[:]) {
			w.WriteHeader(400)
			return
		}
		delete(f.codes, code)
		json.NewEncoder(w).Encode(f.issue(flow.subject))
	case "/oauth/userinfo":
		if f.userinfoStatus != 0 {
			w.WriteHeader(f.userinfoStatus)
			io.WriteString(w, f.userinfoPayload)
			return
		}
		if f.userinfoPayload != "" {
			io.WriteString(w, f.userinfoPayload)
			return
		}
		subject := f.accesses[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
		if subject == "" {
			w.WriteHeader(401)
			return
		}
		json.NewEncoder(w).Encode(User{Sub: subject, Email: "synthetic@example.test", Name: "Synthetic student"})
	case "/oauth/revoke":
		r.ParseForm()
		token := r.Form.Get("token")
		delete(f.accesses, token)
		delete(f.refreshes, token)
		w.WriteHeader(200)
	default:
		w.WriteHeader(404)
	}
}

func (f *mysqlAPIFixture) userTasks(subject string) map[string]tasklyHomeTask {
	tasks := f.tasks[subject]
	if tasks == nil {
		tasks = map[string]tasklyHomeTask{}
		for index, key := range []string{"assigned-visit-1", "visit-survey-1", "visit-survey-2", "overall-survey", "sheet-submission"} {
			completed, disabled := false, false
			tasks[key] = tasklyHomeTask{Key: key, TaskID: uint64(index + 1), Completed: &completed, CompletionDisabled: &disabled, TasklyURL: "https://tasks.example.test/"}
		}
		f.tasks[subject] = tasks
	}
	return tasks
}

func (f *mysqlAPIFixture) nativeTask(subject, key string, completed bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	tasks := f.userTasks(subject)
	task := tasks[key]
	task.Completed = &completed
	task.AutoCompletedBy = ""
	task.AutoAssignmentScope = ""
	tasks[key] = task
	for otherKey, other := range tasks {
		if other.AutoCompletedBy == key {
			other.AutoCompletedBy = ""
			other.AutoAssignmentScope = ""
			tasks[otherKey] = other
		}
	}
}

func (f *mysqlAPIFixture) serveTaskly(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if f.tasklyRedirect != "" {
		http.Redirect(w, r, f.tasklyRedirect, 302)
		return
	}
	if f.tasklyStatus != 0 {
		w.WriteHeader(f.tasklyStatus)
		io.WriteString(w, f.tasklyPayload)
		return
	}
	if f.tasklyPayload != "" {
		io.WriteString(w, f.tasklyPayload)
		return
	}
	subject := f.accesses[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]
	if subject == "" {
		w.WriteHeader(401)
		return
	}
	if r.Header.Get("X-Guidance-Event-ID") != f.cfg.TasklyEventID || r.Header.Get("Cookie") != "" {
		w.WriteHeader(403)
		return
	}
	tasks := f.userTasks(subject)
	if r.Method == "GET" {
		values := []tasklyHomeTask{}
		for _, task := range tasks {
			values = append(values, task)
		}
		json.NewEncoder(w).Encode(map[string]any{"event_id": f.cfg.TasklyEventID, "tasks": values})
		return
	}
	key := strings.TrimPrefix(r.URL.Path, "/integrations/nnct-guidance/tasks/")
	task, ok := tasks[key]
	if !ok {
		w.WriteHeader(404)
		return
	}
	var input struct {
		Completed         bool   `json:"completed"`
		LinkAssignedVisit bool   `json:"link_assigned_visit"`
		AssignmentScope   string `json:"assignment_scope"`
	}
	if json.NewDecoder(r.Body).Decode(&input) != nil {
		w.WriteHeader(400)
		return
	}
	var related []tasklyHomeTask
	if input.LinkAssignedVisit {
		reverse := strings.HasPrefix(key, "assigned-visit-")
		partnerKey := "assigned-visit-" + strings.TrimPrefix(key, "visit-survey-")
		if reverse {
			partnerKey = "visit-survey-" + strings.TrimPrefix(key, "assigned-visit-")
		}
		partner, exists := tasks[partnerKey]
		if !exists {
			w.WriteHeader(404)
			return
		}
		if input.Completed && (*task.CompletionDisabled || *partner.CompletionDisabled) {
			w.WriteHeader(409)
			return
		}
		if reverse {
			if task.AutoCompletedBy == partnerKey && task.AutoAssignmentScope == input.AssignmentScope {
				value := false
				partner.Completed = &value
			}
		} else if input.Completed && !*task.Completed && !*partner.Completed {
			value := true
			partner.Completed = &value
			partner.AutoCompletedBy = key
			partner.AutoAssignmentScope = input.AssignmentScope
		} else if !input.Completed && partner.AutoCompletedBy == key && partner.AutoAssignmentScope == input.AssignmentScope {
			value := false
			partner.Completed = &value
			partner.AutoCompletedBy = ""
			partner.AutoAssignmentScope = ""
		} else if partner.AutoCompletedBy == key && partner.AutoAssignmentScope != input.AssignmentScope {
			partner.AutoCompletedBy = ""
			partner.AutoAssignmentScope = ""
		}
		tasks[partnerKey] = partner
		related = []tasklyHomeTask{partner}
	} else if input.Completed && *task.CompletionDisabled {
		w.WriteHeader(409)
		return
	}
	task.Completed = &input.Completed
	task.AutoCompletedBy = ""
	task.AutoAssignmentScope = ""
	tasks[key] = task
	json.NewEncoder(w).Encode(struct {
		tasklyHomeTask
		Related []tasklyHomeTask `json:"related_tasks,omitempty"`
	}{task, related})
}

func (f *mysqlAPIFixture) login(t *testing.T, subject string) *http.Client {
	t.Helper()
	f.mu.Lock()
	f.loginSub = subject
	f.mu.Unlock()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 10 * time.Second, CheckRedirect: func(r *http.Request, via []*http.Request) error {
		if strings.HasPrefix(r.URL.String(), f.cfg.UIOrigin) {
			return http.ErrUseLastResponse
		}
		return nil
	}}
	response, err := client.Get(f.api.URL + "/auth/start")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 302 || response.Header.Get("Location") != f.cfg.UIOrigin+"/" {
		t.Fatalf("synthetic login status%d", response.StatusCode)
	}
	return client
}

func (f *mysqlAPIFixture) send(t *testing.T, client *http.Client, method, path, body string, expected int) []byte {
	t.Helper()
	req, err := http.NewRequest(method, f.api.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", f.cfg.UIOrigin)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != expected {
		t.Fatalf("%s %s status%d want%d: %s", method, path, response.StatusCode, expected, payload)
	}
	if strings.HasPrefix(path, "/api/") && response.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("authenticated integration response must be no-store")
	}
	return payload
}

func (f *mysqlAPIFixture) sessionHash(t *testing.T, client *http.Client) string {
	t.Helper()
	u, _ := url.Parse(f.api.URL)
	for _, cookie := range client.Jar.Cookies(u) {
		if cookie.Name == "guidance_session" {
			return digest(cookie.Value)
		}
	}
	t.Fatal("synthetic login did not create a local session")
	return ""
}

func (f *mysqlAPIFixture) currentCredentials(t *testing.T, client *http.Client) (string, sessionCredentials, time.Time) {
	t.Helper()
	hash := f.sessionHash(t, client)
	encrypted, expiry, err := (SQLStore{DB: f.db}).Session(context.Background(), hash)
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := f.app.decryptCredentials(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	return hash, credentials, expiry
}
