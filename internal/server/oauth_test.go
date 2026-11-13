package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func beginLogin(t *testing.T, s *Server) (*http.Cookie, url.Values) {
	t.Helper()
	w := request(s, "GET", "/auth/start", nil, "")
	requireStatus(t, w, 302)
	u, err := url.Parse(w.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	var flow *http.Cookie
	for _, c := range w.Result().Cookies() {
		if c.Name == s.flowCookieName() {
			flow = c
		}
	}
	if flow == nil {
		t.Fatal("missing login cookie")
	}
	return flow, u.Query()
}
func TestOAuthRepeatedStartReusesActiveFlowAcrossTabs(t *testing.T) {
	s, f := testServer(t)
	flow, first := beginLogin(t, s)
	repeated := request(s, "GET", "/auth/start", flow, "")
	requireStatus(t, repeated, 302)
	redirect, err := url.Parse(repeated.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	if redirect.Query().Get("state") != first.Get("state") || redirect.Query().Get("code_challenge") != first.Get("code_challenge") {
		t.Fatal("repeated start changed the active PKCE flow")
	}
	if len(f.flows) != 1 {
		t.Fatalf("repeated browser start saved %d flows", len(f.flows))
	}
	// A completed first tab still exchanges its original code and consumes
	// the one shared flow. A later login starts a fresh flow.
	s.client.Transport = tokenIdentity(t, s, f)
	requireStatus(t, request(s, "GET", callbackPath(s, flow.Value), flow, ""), 302)
	if len(f.flows) != 0 {
		t.Fatal("completed flow was not consumed")
	}
	requireStatus(t, request(s, "GET", "/auth/start", flow, ""), 302)
	if len(f.flows) != 1 {
		t.Fatal("re-login did not create a fresh flow")
	}
}

func TestOAuthStartLimitsFlowCreationWithoutCookies(t *testing.T) {
	s, f := testServer(t)
	s.flowLimit = newFlowLimiter(1, 2)
	for i := 0; i < 2; i++ {
		requireStatus(t, request(s, "GET", "/auth/start", nil, ""), 302)
	}
	// Spoofing a forwarding header cannot evade the API's global cap.
	r := httptest.NewRequest("GET", s.config.APIOrigin+"/auth/start", nil)
	r.Header.Set("X-Forwarded-For", "198.51.100.99")
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	requireStatus(t, w, 429)
	if w.Header().Get("Retry-After") == "" || len(f.flows) != 2 {
		t.Fatalf("limited request saved a flow or missed Retry-After: flows=%d", len(f.flows))
	}
}
func callbackPath(s *Server, state string) string {
	q := url.Values{"state": {state}, "iss": {s.config.AuthIssuer}, "code": {"authorization-code"}}
	return "/auth/callback?" + q.Encode()
}
func tokenIdentity(t *testing.T, s *Server, f *fakeStore) roundTripFunc {
	t.Helper()
	return func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/oauth/token":
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if r.Form.Get("client_id") != s.config.ClientID || r.Form.Get("grant_type") != "authorization_code" || r.Form.Get("code") != "authorization-code" || r.Form.Get("redirect_uri") != s.config.APIOrigin+"/auth/callback" || !validToken(r.Form.Get("code_verifier")) {
				t.Errorf("invalid token exchange: %v", r.Form)
			}
			if r.Header.Get("Authorization") != "" || r.Form.Get("client_secret") != "" {
				t.Error("public client must not send a client secret")
			}
			return identityResponse(200, `{"access_token":"upstream-access","refresh_token":"upstream-refresh","token_type":"Bearer","expires_in":3600}`), nil
		case "/oauth/userinfo":
			if r.Header.Get("Authorization") != "Bearer upstream-access" {
				t.Error("missing upstream bearer token")
			}
			return healthyIdentity(r)
		default:
			return healthyIdentity(r)
		}
	}
}
func TestOAuthAuthorizationCodePKCEAndSessionRotation(t *testing.T) {
	s, f := testServer(t)
	s.client.Transport = tokenIdentity(t, s, f)
	flow, q := beginLogin(t, s)
	if q.Get("client_id") != s.config.ClientID || q.Get("scope") != "taskly:login" || q.Get("code_challenge_method") != "S256" || q.Get("response_type") != "code" || q.Get("redirect_uri") != s.config.APIOrigin+"/auth/callback" {
		t.Fatalf("authorization parameters: %v", q)
	}
	if flow.Value != q.Get("state") || !flow.HttpOnly || !flow.Secure || flow.Path != "/" || flow.Domain != "" || flow.SameSite != http.SameSiteLaxMode {
		t.Fatalf("unsafe flow cookie: %+v", flow)
	}
	if flow.MaxAge <= 0 || flow.MaxAge > 300 {
		t.Fatalf("flow lifetime %d", flow.MaxAge)
	}
	encrypted := f.flows[digest(flow.Value)]
	verifier, err := s.decrypt(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256([]byte(verifier))
	if base64.RawURLEncoding.EncodeToString(h[:]) != q.Get("code_challenge") {
		t.Fatal("challenge not bound to verifier")
	}
	old := authenticated(t, s, f)
	r := request(s, "GET", callbackPath(s, flow.Value), flow, "")
	requireStatus(t, r, 302)
	if r.Header().Get("Location") != s.config.UIOrigin+"/" {
		t.Fatal("incorrect post-login redirect")
	}
	if strings.Contains(r.Header().Get("Set-Cookie"), "upstream-access") {
		t.Fatal("upstream token leaked to browser")
	}
	var session *http.Cookie
	for _, c := range r.Result().Cookies() {
		if c.Name == s.sessionCookieName() {
			session = c
		}
	}
	if session == nil || !session.HttpOnly || !session.Secure || session.Domain != "" || session.MaxAge > 2592000 || session.MaxAge < 2591990 {
		t.Fatalf("unsafe session cookie: %+v", session)
	}
	saved, ok := f.sessions[digest(session.Value)]
	if !ok {
		t.Fatal("hashed session missing")
	}
	credentials, err := s.decryptCredentials(saved.encrypted)
	if err != nil || credentials.AccessToken != "upstream-access" || credentials.RefreshToken != "upstream-refresh" || credentials.Subject != "user-1" {
		t.Fatalf("session credentials not encrypted: %v", err)
	}
	if time.Until(credentials.AccessExpiry) > 901*time.Second {
		t.Fatal("upstream expiry was not capped")
	}
	if remaining := time.Until(saved.expiry); remaining < sessionLifetime-time.Minute || remaining > sessionLifetime {
		t.Fatal("session expiry is not one month")
	}
	if len(f.flows) != 0 {
		t.Fatal("flow was not consumed")
	}
	requireStatus(t, request(s, "GET", callbackPath(s, flow.Value), flow, ""), 400)
	// A separate authorization rotates an existing local session as well.
	flow, _ = beginLogin(t, s)
	reqURL := s.config.APIOrigin + callbackPath(s, flow.Value)
	req, _ := http.NewRequest("GET", reqURL, nil)
	req.AddCookie(flow)
	req.AddCookie(old)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, req)
	requireStatus(t, w, 302)
	if _, ok := f.sessions[digest(old.Value)]; ok {
		t.Fatal("previous session retained after rotation")
	}
}
func TestOAuthRejectsInvalidStateIssuerAndExpiredFlows(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*Server, *fakeStore, *http.Cookie, url.Values)
	}{
		{"missing cookie", func(s *Server, f *fakeStore, c *http.Cookie, q url.Values) { c.Name = "wrong" }},
		{"wrong state", func(s *Server, f *fakeStore, c *http.Cookie, q url.Values) { q.Set("state", strings.Repeat("b", 43)) }},
		{"invalid state", func(s *Server, f *fakeStore, c *http.Cookie, q url.Values) { q.Set("state", "bad") }},
		{"wrong issuer", func(s *Server, f *fakeStore, c *http.Cookie, q url.Values) {
			q.Set("iss", "https://attacker.example.test")
		}},
		{"missing issuer", func(s *Server, f *fakeStore, c *http.Cookie, q url.Values) { q.Del("iss") }},
		{"expired flow", func(s *Server, f *fakeStore, c *http.Cookie, q url.Values) { delete(f.flows, digest(c.Value)) }},
		{"missing code", func(s *Server, f *fakeStore, c *http.Cookie, q url.Values) { q.Del("code") }},
		{"oversized code", func(s *Server, f *fakeStore, c *http.Cookie, q url.Values) { q.Set("code", strings.Repeat("a", 2049)) }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, f := testServer(t)
			flow, _ := beginLogin(t, s)
			q := url.Values{"state": {flow.Value}, "iss": {s.config.AuthIssuer}, "code": {"authorization-code"}}
			tc.mutate(s, f, flow, q)
			requireStatus(t, request(s, "GET", "/auth/callback?"+q.Encode(), flow, ""), 400)
			if len(f.sessions) != 0 {
				t.Fatal("invalid authorization created a session")
			}
		})
	}
}
func TestOAuthCancellationAndDependencyFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*Server, *fakeStore, url.Values)
		status int
	}{
		{"cancelled", func(s *Server, f *fakeStore, q url.Values) { q.Set("error", "access_denied") }, 302},
		{"flow database unavailable", func(s *Server, f *fakeStore, q url.Values) { f.errorFlow = errors.New("unavailable") }, 503},
		{"corrupt verifier", func(s *Server, f *fakeStore, q url.Values) { f.flows[digest(q.Get("state"))] = []byte("corrupt") }, 503},
		{"token offline", func(s *Server, f *fakeStore, q url.Values) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("offline") })
		}, 503},
		{"exchange rejected", func(s *Server, f *fakeStore, q url.Values) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
				return identityResponse(400, `{"error":"invalid_grant"}`), nil
			})
		}, 502},
		{"malformed token", func(s *Server, f *fakeStore, q url.Values) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return identityResponse(200, `{`), nil })
		}, 502},
		{"missing access token", func(s *Server, f *fakeStore, q url.Values) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
				return identityResponse(200, `{"refresh_token":"refresh","token_type":"Bearer","expires_in":900}`), nil
			})
		}, 502},
		{"missing refresh token", func(s *Server, f *fakeStore, q url.Values) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
				return identityResponse(200, `{"access_token":"token","token_type":"Bearer","expires_in":900}`), nil
			})
		}, 502},
		{"incorrect token type", func(s *Server, f *fakeStore, q url.Values) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
				return identityResponse(200, `{"access_token":"token","refresh_token":"refresh","token_type":"MAC","expires_in":900}`), nil
			})
		}, 502},
		{"expired token", func(s *Server, f *fakeStore, q url.Values) {
			s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
				return identityResponse(200, `{"access_token":"token","refresh_token":"refresh","token_type":"Bearer","expires_in":0}`), nil
			})
		}, 502},
		{"userinfo rejected", func(s *Server, f *fakeStore, q url.Values) {
			s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/oauth/token" {
					return identityResponse(200, `{"access_token":"token","refresh_token":"refresh","token_type":"Bearer","expires_in":900}`), nil
				}
				return identityResponse(503, `{}`), nil
			})
		}, 502},
		{"session storage unavailable", func(s *Server, f *fakeStore, q url.Values) { f.errorSession = errors.New("unavailable") }, 503},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, f := testServer(t)
			s.client.Transport = tokenIdentity(t, s, f)
			flow, _ := beginLogin(t, s)
			q := url.Values{"state": {flow.Value}, "iss": {s.config.AuthIssuer}, "code": {"authorization-code"}}
			tc.change(s, f, q)
			w := request(s, "GET", "/auth/callback?"+q.Encode(), flow, "")
			requireStatus(t, w, tc.status)
			if tc.name == "cancelled" && !strings.Contains(w.Header().Get("Location"), "auth_error=login_cancelled") {
				t.Fatal("cancellation not reported")
			}
			if len(f.sessions) != 0 {
				t.Fatal("failure created session")
			}
		})
	}
	s, f := testServer(t)
	f.errorFlow = errors.New("database unavailable")
	requireStatus(t, request(s, "GET", "/auth/start", nil, ""), 503)
}
func TestLogoutRevokesUpstreamAndDeletesLocalSession(t *testing.T) {
	s, f := testServer(t)
	cookie := authenticated(t, s, f)
	called := false
	s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path != "/oauth/revoke" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		called = true
		r.ParseForm()
		if r.Form.Get("token") != "upstream-access" || r.Form.Get("client_id") != s.config.ClientID {
			t.Errorf("bad revocation form %v", r.Form)
		}
		return identityResponse(200, `{}`), nil
	})
	w := request(s, "POST", "/auth/logout", cookie, s.config.UIOrigin)
	requireStatus(t, w, 204)
	if !called || len(f.sessions) != 0 {
		t.Fatal("session not revoked")
	}
	if !strings.Contains(w.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Fatal("browser cookie not removed")
	}
	requireStatus(t, request(s, "POST", "/auth/logout", nil, s.config.UIOrigin), 204)
	requireStatus(t, request(s, "POST", "/auth/logout", cookie, s.config.UIOrigin), 204)
}
func TestLogoutFailsClosedAndToleratesUpstreamOutage(t *testing.T) {
	s, f := testServer(t)
	c := authenticated(t, s, f)
	f.errorSession = errors.New("storage offline")
	requireStatus(t, request(s, "POST", "/auth/logout", c, s.config.UIOrigin), 503)
	if len(f.sessions) != 1 {
		t.Fatal("storage failure reported successful logout")
	}
	f.errorSession = nil
	s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("offline") })
	requireStatus(t, request(s, "POST", "/auth/logout", c, s.config.UIOrigin), 204)
	if len(f.sessions) != 0 {
		t.Fatal("local logout depends on upstream availability")
	}
	c = authenticated(t, s, f)
	f.sessions[digest(c.Value)] = fakeSession{[]byte("corrupt"), time.Now().Add(time.Hour)}
	requireStatus(t, request(s, "POST", "/auth/logout", c, s.config.UIOrigin), 204)
}

func TestOAuthFailsClosedWithoutEntropy(t *testing.T) {
	for _, failAt := range []int{1, 2, 3} {
		t.Run(fmt.Sprintf("start failure %d", failAt), func(t *testing.T) {
			s, f := testServer(t)
			replaceEntropy(t, failAt)
			requireStatus(t, request(s, "GET", "/auth/start", nil, ""), 500)
			if len(f.flows) != 0 {
				t.Fatal("failed login created an authorization flow")
			}
		})
	}
	for _, failAt := range []int{1, 2} {
		t.Run(fmt.Sprintf("callback failure %d", failAt), func(t *testing.T) {
			s, f := testServer(t)
			s.client.Transport = tokenIdentity(t, s, f)
			flow, _ := beginLogin(t, s)
			replaceEntropy(t, failAt)
			requireStatus(t, request(s, "GET", callbackPath(s, flow.Value), flow, ""), 500)
			if len(f.sessions) != 0 {
				t.Fatal("failed entropy created session")
			}
		})
	}
}

type failedDeleteStore struct{ *fakeStore }

func (f failedDeleteStore) DeleteSession(context.Context, string) error {
	return errors.New("delete unavailable")
}
func TestLogoutReportsLocalDeletionFailure(t *testing.T) {
	s, f := testServer(t)
	c := authenticated(t, s, f)
	s.store = failedDeleteStore{f}
	w := request(s, "POST", "/auth/logout", c, s.config.UIOrigin)
	requireStatus(t, w, 503)
	if len(f.sessions) != 1 {
		t.Fatal("unexpected session deletion")
	}
}
