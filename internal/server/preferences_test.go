package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func preferenceRequest(s *Server, body string, cookie *http.Cookie, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPut, s.config.APIOrigin+"/api/preferences", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	return w
}

func syntheticPreferencesDataset(f *fakeStore) {
	f.dataset = json.RawMessage(`{"assignments":[{"department":"電子制御工学科","grade":4,"number":7,"visits":[]},{"department":"電子制御工学科","grade":4,"number":12,"visits":[]},{"department":"架空工学科","grade":4,"number":8,"visits":[]},{"department":"電子制御工学科","grade":3,"number":9,"visits":[]}]}`)
}

func TestPreferencesRequireAuthenticationAndExactOrigin(t *testing.T) {
	s, f := testServer(t)
	requireStatus(t, request(s, "GET", "/api/preferences", nil, s.config.UIOrigin), 401)
	requireStatus(t, preferenceRequest(s, `{"roster_number":7}`, nil, s.config.UIOrigin), 401)
	cookie := authenticated(t, s, f)
	requireStatus(t, preferenceRequest(s, `{"roster_number":7}`, cookie, ""), 403)
	requireStatus(t, preferenceRequest(s, `{"roster_number":7}`, cookie, "https://untrusted.example.test"), 403)
}

func TestPreferencesPersistAndRemainIsolatedByIdentity(t *testing.T) {
	s, f := testServer(t)
	syntheticPreferencesDataset(f)
	first := authenticated(t, s, f)
	w := request(s, "GET", "/api/preferences", first, s.config.UIOrigin)
	requireStatus(t, w, 200)
	var initial struct {
		Number     *int   `json:"roster_number"`
		Department string `json:"department"`
		Grade      int    `json:"grade"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &initial); err != nil {
		t.Fatal(err)
	}
	if initial.Number != nil || initial.Department != "電子制御工学科" || initial.Grade != 4 {
		t.Fatalf("unexpected default: %s", w.Body.String())
	}
	w = preferenceRequest(s, `{"roster_number":7}`, first, s.config.UIOrigin)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"roster_number":7`) {
		t.Fatalf("saved preference absent: %s", w.Body.String())
	}
	requireStatus(t, preferenceRequest(s, `{"roster_number":7}`, first, s.config.UIOrigin), 200)

	second := &http.Cookie{Name: s.sessionCookieName(), Value: strings.Repeat("b", 43)}
	access, err := s.encrypt("second-user-access")
	if err != nil {
		t.Fatal(err)
	}
	f.sessions[digest(second.Value)] = fakeSession{access, time.Now().Add(time.Hour)}
	s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") == "Bearer second-user-access" {
			return identityResponse(200, `{"sub":"user-2","name":"Second synthetic user"}`), nil
		}
		return healthyIdentity(r)
	})
	w = request(s, "GET", "/api/preferences", second, s.config.UIOrigin)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"roster_number":null`) {
		t.Fatal("another identity received the first preference")
	}
	requireStatus(t, preferenceRequest(s, `{"roster_number":12}`, second, s.config.UIOrigin), 200)
	w = request(s, "GET", "/api/preferences", first, s.config.UIOrigin)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"roster_number":7`) {
		t.Fatal("another identity overwrote the first preference")
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("preference response is cacheable")
	}
}

func TestPreferencesRejectMissingOrOtherClassAssignments(t *testing.T) {
	s, f := testServer(t)
	syntheticPreferencesDataset(f)
	cookie := authenticated(t, s, f)
	for _, value := range []string{"0", "-1", "100", "8", "9", "10"} {
		t.Run(value, func(t *testing.T) {
			requireStatus(t, preferenceRequest(s, `{"roster_number":`+value+`}`, cookie, s.config.UIOrigin), 422)
		})
	}
	for _, body := range []string{`{}`, `null`} {
		requireStatus(t, preferenceRequest(s, body, cookie, s.config.UIOrigin), 422)
	}
	for _, body := range []string{`{`, `{"roster_number":"7"}`, `{"roster_number":7.5}`, `{"roster_number":7,"department":"other"}`, `{"roster_number":7} {}`, strings.Repeat(" ", 8193) + `{"roster_number":7}`} {
		t.Run(body[:min(len(body), 50)], func(t *testing.T) {
			w := preferenceRequest(s, body, cookie, s.config.UIOrigin)
			if w.Code != 400 && w.Code != 413 {
				t.Fatalf("invalid JSON accepted or misclassified: %d %s", w.Code, w.Body.String())
			}
		})
	}
}

func TestPreferencesFailClosedWhenDatasetOrStorageUnavailable(t *testing.T) {
	s, f := testServer(t)
	syntheticPreferencesDataset(f)
	cookie := authenticated(t, s, f)
	f.errorDataset = errors.New("unavailable")
	requireStatus(t, preferenceRequest(s, `{"roster_number":7}`, cookie, s.config.UIOrigin), 503)
	f.errorDataset = nil
	f.dataset = json.RawMessage(`{`)
	requireStatus(t, preferenceRequest(s, `{"roster_number":7}`, cookie, s.config.UIOrigin), 503)
	syntheticPreferencesDataset(f)
	f.errorPreference = errors.New("preference storage unavailable")
	requireStatus(t, request(s, "GET", "/api/preferences", cookie, s.config.UIOrigin), 503)
	requireStatus(t, preferenceRequest(s, `{"roster_number":7}`, cookie, s.config.UIOrigin), 503)
	f.errorPreference = nil

	// Implementations without preference storage fail closed, even if ordinary
	// authentication and dataset endpoints can still operate.
	baseOnly, err := New(s.config, struct{ Store }{f}, s.client)
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, request(baseOnly, "GET", "/api/preferences", cookie, s.config.UIOrigin), 503)
	requireStatus(t, preferenceRequest(baseOnly, `{"roster_number":7}`, cookie, s.config.UIOrigin), 503)
}

func TestSQLPreferencesUseIdentityBoundParameters(t *testing.T) {
	store, mock := mockStore(t)
	ctx := context.Background()
	mock.ExpectQuery("SELECT roster_number FROM guidance_preferences").WithArgs("first-user").WillReturnRows(sqlmock.NewRows([]string{"roster_number"}).AddRow(7))
	number, err := store.Preference(ctx, "first-user")
	if err != nil || number == nil || *number != 7 {
		t.Fatalf("preference read: %v %v", number, err)
	}
	mock.ExpectQuery("SELECT roster_number FROM guidance_preferences").WithArgs("second-user").WillReturnRows(sqlmock.NewRows([]string{"roster_number"}))
	if number, err = store.Preference(ctx, "second-user"); err != nil || number != nil {
		t.Fatalf("missing preference: %v %v", number, err)
	}
	failure := errors.New("storage offline")
	mock.ExpectQuery("SELECT roster_number FROM guidance_preferences").WithArgs("first-user").WillReturnError(failure)
	if _, err = store.Preference(ctx, "first-user"); !errors.Is(err, failure) {
		t.Fatal("read failure hidden")
	}
	mock.ExpectQuery("SELECT roster_number FROM guidance_preferences").WithArgs("bad-value").WillReturnRows(sqlmock.NewRows([]string{"roster_number"}).AddRow("invalid-integer"))
	if _, err = store.Preference(ctx, "bad-value"); err == nil {
		t.Fatal("invalid stored integer accepted")
	}
	mock.ExpectExec("INSERT INTO guidance_preferences").WithArgs("first-user", 7).WillReturnResult(sqlmock.NewResult(1, 1))
	if err = store.SetPreference(ctx, "first-user", 7); err != nil {
		t.Fatal(err)
	}
	mock.ExpectExec("INSERT INTO guidance_preferences").WithArgs("second-user", 12).WillReturnError(failure)
	if err = store.SetPreference(ctx, "second-user", 12); !errors.Is(err, failure) {
		t.Fatal("write failure hidden")
	}
}
