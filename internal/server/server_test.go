package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func identityResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}
func healthyIdentity(r *http.Request) (*http.Response, error) {
	if r.URL.Path == "/oauth/userinfo" {
		return identityResponse(200, `{"sub":"user-1","name":"Synthetic user","email":"student@example.test"}`), nil
	}
	if r.URL.Path == "/oauth/revoke" {
		return identityResponse(200, `{}`), nil
	}
	return identityResponse(404, `{}`), nil
}
func testServer(t *testing.T) (*Server, *fakeStore) {
	t.Helper()
	f := newFakeStore()
	c := validConfig()
	s, err := New(c, f, &http.Client{Transport: roundTripFunc(healthyIdentity)})
	if err != nil {
		t.Fatal(err)
	}
	return s, f
}
func authenticated(t *testing.T, s *Server, f *fakeStore) *http.Cookie {
	t.Helper()
	token := strings.Repeat("a", 43)
	encrypted, err := s.encrypt("upstream-access")
	if err != nil {
		t.Fatal(err)
	}
	f.sessions[digest(token)] = fakeSession{encrypted, time.Now().Add(time.Hour)}
	return &http.Cookie{Name: s.sessionCookieName(), Value: token}
}
func request(s *Server, method, path string, cookie *http.Cookie, origin string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, s.config.APIOrigin+path, nil)
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
func requireStatus(t *testing.T, w *httptest.ResponseRecorder, want int) {
	t.Helper()
	if w.Code != want {
		t.Fatalf("status %d want %d: %s", w.Code, want, w.Body.String())
	}
}

func TestNewAndSecurityHeaders(t *testing.T) {
	s, err := New(validConfig(), newFakeStore(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if s.client.Timeout != 10*time.Second {
		t.Fatal("HTTP timeout missing")
	}
	if err := s.client.CheckRedirect(nil, nil); !errors.Is(err, http.ErrUseLastResponse) {
		t.Fatal("identity redirects must be rejected")
	}
	c := validConfig()
	c.EncryptionKey = nil
	if _, err = New(c, newFakeStore(), nil); err == nil {
		t.Fatal("invalid config accepted")
	}
	s, _ = testServer(t)
	w := request(s, "GET", "/healthz", nil, s.config.UIOrigin)
	requireStatus(t, w, 200)
	for k, want := range map[string]string{"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Access-Control-Allow-Origin": s.config.UIOrigin, "Access-Control-Allow-Credentials": "true"} {
		if got := w.Header().Get(k); got != want {
			t.Errorf("%s=%q want %q", k, got, want)
		}
	}
	if !strings.Contains(w.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("frame policy missing")
	}
	for _, tc := range []struct {
		method, origin string
		status         int
	}{{"OPTIONS", s.config.UIOrigin, 204}, {"OPTIONS", "", 403}, {"OPTIONS", "https://evil.example.test", 403}, {"GET", "https://evil.example.test", 403}, {"POST", "", 403}, {"POST", s.config.UIOrigin, 405}} {
		w = request(s, tc.method, "/healthz", nil, tc.origin)
		requireStatus(t, w, tc.status)
	}
}
func TestHealthAndReadiness(t *testing.T) {
	s, f := testServer(t)
	requireStatus(t, request(s, "GET", "/readyz", nil, ""), 200)
	f.errorDataset = ErrNotFound
	requireStatus(t, request(s, "GET", "/readyz", nil, ""), 503)
	f.pingErr = errors.New("db unavailable")
	requireStatus(t, request(s, "GET", "/healthz", nil, ""), 503)
	requireStatus(t, request(s, "GET", "/readyz", nil, ""), 503)
}
func TestAllPrivateEndpointsRequireAuthentication(t *testing.T) {
	s, _ := testServer(t)
	for _, tc := range []struct{ method, path string }{{"GET", "/api/me"}, {"GET", "/api/guidance"}, {"GET", "/api/documents/map"}, {"GET", "/api/bookmarks"}, {"PUT", "/api/bookmarks/AM-1"}, {"DELETE", "/api/bookmarks/AM-1"}} {
		t.Run(tc.method+tc.path, func(t *testing.T) { requireStatus(t, request(s, tc.method, tc.path, nil, s.config.UIOrigin), 401) })
	}
}
func TestAuthenticatedGuidanceAndIdentity(t *testing.T) {
	s, f := testServer(t)
	cookie := authenticated(t, s, f)
	w := request(s, "GET", "/api/me", cookie, s.config.UIOrigin)
	requireStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), `"sub":"user-1"`) {
		t.Fatal("identity missing")
	}
	w = request(s, "GET", "/api/guidance", cookie, "")
	requireStatus(t, w, 200)
	if !json.Valid(w.Body.Bytes()) || !strings.Contains(w.Body.String(), "Synthetic event") {
		t.Fatal("dataset missing")
	}
	f.errorDataset = errors.New("db unavailable")
	requireStatus(t, request(s, "GET", "/api/guidance", cookie, ""), 503)
}
func TestAuthenticationFailureModes(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Server, *fakeStore, *http.Cookie)
		status int
	}{
		{"invalid token", func(s *Server, f *fakeStore, c *http.Cookie) { c.Value = "invalid" }, 401},
		{"missing session", func(s *Server, f *fakeStore, c *http.Cookie) { delete(f.sessions, digest(c.Value)) }, 401},
		{"database unavailable", func(s *Server, f *fakeStore, c *http.Cookie) { f.errorSession = errors.New("unavailable") }, 503},
		{"ciphertext corrupt", func(s *Server, f *fakeStore, c *http.Cookie) {
			f.sessions[digest(c.Value)] = fakeSession{[]byte("corrupt"), time.Now().Add(time.Hour)}
		}, 503},
		{"revoked upstream", func(s *Server, f *fakeStore, c *http.Cookie) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return identityResponse(401, `{}`), nil })
		}, 401},
		{"blocked upstream", func(s *Server, f *fakeStore, c *http.Cookie) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return identityResponse(403, `{}`), nil })
		}, 401},
		{"upstream unavailable", func(s *Server, f *fakeStore, c *http.Cookie) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return identityResponse(503, `{}`), nil })
		}, 503},
		{"upstream connection failure", func(s *Server, f *fakeStore, c *http.Cookie) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("offline") })
		}, 503},
		{"malformed userinfo", func(s *Server, f *fakeStore, c *http.Cookie) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return identityResponse(200, `{`), nil })
		}, 503},
		{"missing subject", func(s *Server, f *fakeStore, c *http.Cookie) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
				return identityResponse(200, `{"email":"student@example.test"}`), nil
			})
		}, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, f := testServer(t)
			c := authenticated(t, s, f)
			tc.change(s, f, c)
			w := request(s, "GET", "/api/me", c, "")
			requireStatus(t, w, tc.status)
			if tc.name == "revoked upstream" || tc.name == "blocked upstream" {
				if len(f.sessions) != 0 {
					t.Fatal("revoked session retained")
				}
			}
		})
	}
}
func TestDocumentsRedirectToPrivateR2WithoutReadingHostFiles(t *testing.T) {
	s, f := testServer(t)
	cookie := authenticated(t, s, f)
	f.documents["map"] = Document{ID: "map", FileName: "map.png", MIMEType: "image/png", Title: "Map"}
	for _, method := range []string{"GET", "HEAD"} {
		w := request(s, method, "/api/documents/map", cookie, "")
		requireStatus(t, w, 302)
		target, err := url.Parse(w.Header().Get("Location"))
		if err != nil {
			t.Fatal(err)
		}
		if target.Scheme+"://"+target.Host != s.config.R2Endpoint || target.Path != "/"+s.config.R2Bucket+"/map.png" || target.Query().Get("X-Amz-Signature") == "" {
			t.Fatal("document did not redirect directly to private R2")
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("private redirect cacheable")
		}
	}
	if documentExtension("image/png") != ".png" || documentExtension("image/jpeg") != ".jpg" || documentExtension("application/pdf") != ".pdf" {
		t.Fatal("unexpected extension")
	}
}
func TestDocumentsRejectUnknownOrUnsafeObjectMetadata(t *testing.T) {
	for _, tc := range []struct {
		name string
		edit func(*Server, *fakeStore)
		id   string
		want int
	}{
		{"invalid identifier", func(*Server, *fakeStore) {}, "map.invalid", 404},
		{"missing metadata", func(_ *Server, f *fakeStore) { delete(f.documents, "map") }, "map", 404},
		{"metadata failure", func(_ *Server, f *fakeStore) { f.errorDocument = errors.New("offline") }, "map", 503},
		{"unsafe key", func(_ *Server, f *fakeStore) {
			f.documents["map"] = Document{ID: "map", FileName: "../secret.pdf", MIMEType: "application/pdf"}
		}, "map", 404},
		{"unsupported mime", func(_ *Server, f *fakeStore) {
			f.documents["map"] = Document{ID: "map", FileName: "map.html", MIMEType: "text/html"}
		}, "map", 404},
		{"empty key", func(_ *Server, f *fakeStore) { f.documents["map"] = Document{ID: "map", MIMEType: "application/pdf"} }, "map", 404},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, f := testServer(t)
			c := authenticated(t, s, f)
			f.documents["map"] = Document{ID: "map", FileName: "map.png", MIMEType: "image/png"}
			tc.edit(s, f)
			requireStatus(t, request(s, "GET", "/api/documents/"+tc.id, c, ""), tc.want)
		})
	}
}
func TestBookmarksPersistPerUserAndRejectUnknownCompany(t *testing.T) {
	s, f := testServer(t)
	c := authenticated(t, s, f)
	origin := s.config.UIOrigin
	requireStatus(t, request(s, "PUT", "/api/bookmarks/AM-1", c, ""), 403)
	requireStatus(t, request(s, "PUT", "/api/bookmarks/AM-1", c, "https://evil.example.test"), 403)
	requireStatus(t, request(s, "PUT", "/api/bookmarks/AM-1", c, origin), 204)
	requireStatus(t, request(s, "PUT", "/api/bookmarks/AM-1", c, origin), 204)
	w := request(s, "GET", "/api/bookmarks", c, origin)
	requireStatus(t, w, 200)
	if w.Body.String() != "{\"company_ids\":[\"AM-1\"]}\n" {
		t.Fatalf("bookmark result: %s", w.Body.String())
	}
	s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return identityResponse(200, `{"sub":"user-2"}`), nil })
	w = request(s, "GET", "/api/bookmarks", c, origin)
	requireStatus(t, w, 200)
	if strings.Contains(w.Body.String(), "AM-1") {
		t.Fatal("cross-user bookmark leak")
	}
	s.client.Transport = roundTripFunc(healthyIdentity)
	requireStatus(t, request(s, "DELETE", "/api/bookmarks/AM-1", c, origin), 204)
	requireStatus(t, request(s, "DELETE", "/api/bookmarks/AM-1", c, origin), 204)
	w = request(s, "GET", "/api/bookmarks", c, origin)
	requireStatus(t, w, 200)
	if strings.Contains(w.Body.String(), "AM-1") {
		t.Fatal("removed bookmark returned")
	}
	requireStatus(t, request(s, "PUT", "/api/bookmarks/AM-2", c, origin), 404)
	requireStatus(t, request(s, "PUT", "/api/bookmarks/bad.id", c, origin), 404)
}
func TestBookmarkFailureModes(t *testing.T) {
	s, f := testServer(t)
	c := authenticated(t, s, f)
	f.errorBookmark = errors.New("db unavailable")
	for _, tc := range []struct{ method, path string }{{"GET", "/api/bookmarks"}, {"PUT", "/api/bookmarks/AM-1"}, {"DELETE", "/api/bookmarks/AM-1"}} {
		requireStatus(t, request(s, tc.method, tc.path, c, s.config.UIOrigin), 503)
	}
	f.errorBookmark = nil
	f.errorDataset = errors.New("unavailable")
	requireStatus(t, request(s, "PUT", "/api/bookmarks/AM-1", c, s.config.UIOrigin), 503)
	f.errorDataset = nil
	f.dataset = json.RawMessage(`{`)
	if _, err := s.companyExists(context.Background(), "AM-1"); err == nil {
		t.Fatal("malformed dataset accepted")
	}
}
func TestTokenSyntaxAndDevelopmentCookies(t *testing.T) {
	for _, token := range []string{"", strings.Repeat("a", 42), strings.Repeat("a", 44), strings.Repeat("a", 42) + "!"} {
		if validToken(token) {
			t.Fatalf("invalid token accepted %q", token)
		}
	}
	if !validToken(strings.Repeat("a", 41) + "_-") {
		t.Fatal("valid token rejected")
	}
	s, f := testServer(t)
	s.config.SecureCookies = false
	if s.sessionCookieName() != "guidance_session" || s.flowCookieName() != "guidance_flow" {
		t.Fatal("development cookie names wrong")
	}
	c := authenticated(t, s, f)
	requireStatus(t, request(s, "GET", "/api/me", c, ""), 200)
}

type noBookmarkStore struct{ Store }
type emptyBookmarkStore struct{ Store }

func (emptyBookmarkStore) Bookmarks(context.Context, string) ([]string, error)  { return nil, nil }
func (emptyBookmarkStore) AddBookmark(context.Context, string, string) error    { return nil }
func (emptyBookmarkStore) RemoveBookmark(context.Context, string, string) error { return nil }
func TestBookmarkOptionalStorageFailsClosed(t *testing.T) {
	s, f := testServer(t)
	c := authenticated(t, s, f)
	s.store = noBookmarkStore{f}
	for _, tc := range []struct{ method, path string }{{"GET", "/api/bookmarks"}, {"PUT", "/api/bookmarks/AM-1"}, {"DELETE", "/api/bookmarks/AM-1"}} {
		requireStatus(t, request(s, tc.method, tc.path, c, s.config.UIOrigin), 503)
	}
	s.store = emptyBookmarkStore{f}
	w := request(s, "GET", "/api/bookmarks", c, s.config.UIOrigin)
	requireStatus(t, w, 200)
	if w.Body.String() != "{\"company_ids\":[]}\n" {
		t.Fatalf("null array returned: %s", w.Body.String())
	}
}
