package server

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func expiringSession(t *testing.T, s *Server, f *fakeStore) *http.Cookie {
	t.Helper()
	cookie := authenticated(t, s, f)
	credentials := sessionCredentials{AccessToken: "expired-access", RefreshToken: "old-refresh", AccessExpiry: time.Now().Add(-16 * time.Minute), Subject: "user-1"}
	encrypted, err := s.encryptCredentials(credentials)
	if err != nil {
		t.Fatal(err)
	}
	f.sessions[digest(cookie.Value)] = fakeSession{encrypted, time.Now().Add(sessionLifetime)}
	return cookie
}

func refreshingIdentity(t *testing.T, calls *atomic.Int32) roundTripFunc {
	t.Helper()
	return func(r *http.Request) (*http.Response, error) {
		switch r.URL.Path {
		case "/oauth/token":
			calls.Add(1)
			_ = r.ParseForm()
			if r.Form.Get("grant_type") != "refresh_token" || r.Form.Get("refresh_token") != "old-refresh" || r.Form.Get("client_id") == "" || r.Form.Get("client_secret") != "" || r.Header.Get("Authorization") != "" {
				t.Error("invalid public client refresh request")
			}
			return identityResponse(200, `{"access_token":"renewed-access","refresh_token":"renewed-refresh","token_type":"Bearer","expires_in":900}`), nil
		case "/oauth/userinfo":
			if r.Header.Get("Authorization") != "Bearer renewed-access" {
				t.Error("expired access token used after refresh")
			}
			return healthyIdentity(r)
		default:
			return healthyIdentity(r)
		}
	}
}

func TestExpiredAccessRefreshesOnceAcrossConcurrentRequests(t *testing.T) {
	s, f := testServer(t)
	cookie := expiringSession(t, s, f)
	expiry := f.sessions[digest(cookie.Value)].expiry
	var calls atomic.Int32
	s.client.Transport = refreshingIdentity(t, &calls)
	var requests sync.WaitGroup
	statuses := make(chan int, 12)
	for range 12 {
		requests.Add(1)
		go func() {
			defer requests.Done()
			statuses <- request(s, "GET", "/api/me", cookie, "").Code
		}()
	}
	requests.Wait()
	close(statuses)
	for status := range statuses {
		if status != 200 {
			t.Fatalf("concurrent authenticated request returned %d", status)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("rotating refresh token reused %d times", calls.Load())
	}
	row := f.sessions[digest(cookie.Value)]
	credentials, err := s.decryptCredentials(row.encrypted)
	if err != nil || credentials.RefreshToken != "renewed-refresh" || !row.expiry.Equal(expiry) {
		t.Fatal("rotation did not preserve the absolute session deadline")
	}
	if strings.Contains(string(row.encrypted), "renewed-refresh") {
		t.Fatal("refresh token stored without encryption")
	}
	var revoked string
	s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		_ = r.ParseForm()
		revoked = r.Form.Get("token")
		return identityResponse(200, `{}`), nil
	})
	requireStatus(t, request(s, "POST", "/auth/logout", cookie, s.config.UIOrigin), 204)
	if revoked != "renewed-refresh" || len(f.sessions) != 0 {
		t.Fatal("logout did not revoke the rotated refresh family")
	}
}

func TestSuccessfulRotationSurvivesTemporaryUserinfoFailure(t *testing.T) {
	s, f := testServer(t)
	cookie := expiringSession(t, s, f)
	var calls atomic.Int32
	identity := refreshingIdentity(t, &calls)
	unavailable := true
	s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/oauth/userinfo" && unavailable {
			return identityResponse(503, `{}`), nil
		}
		return identity(r)
	})
	requireStatus(t, request(s, "GET", "/api/me", cookie, ""), 503)
	stored, err := s.decryptCredentials(f.sessions[digest(cookie.Value)].encrypted)
	if err != nil || stored.RefreshToken != "renewed-refresh" {
		t.Fatal("successful rotation was lost when userinfo was unavailable")
	}
	unavailable = false
	requireStatus(t, request(s, "GET", "/api/me", cookie, ""), 200)
	if calls.Load() != 1 {
		t.Fatal("recovery reused the consumed refresh token")
	}
}

func TestCanceledBrowserRequestDoesNotLoseRotatedCredentials(t *testing.T) {
	s, f := testServer(t)
	cookie := expiringSession(t, s, f)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var calls atomic.Int32
	identity := refreshingIdentity(t, &calls)
	s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/oauth/token" {
			cancel() // The user closes or reloads the page during rotation.
			if r.Context().Err() != nil {
				t.Fatal("browser cancellation aborted the rotating exchange")
			}
		}
		if r.Context().Err() != nil {
			return nil, r.Context().Err()
		}
		return identity(r)
	})
	if _, failure := s.sessionIdentity(ctx, digest(cookie.Value)); failure == nil || failure.status != 503 {
		t.Fatal("canceled request unexpectedly returned protected content")
	}
	credentials, err := s.decryptCredentials(f.sessions[digest(cookie.Value)].encrypted)
	if err != nil || credentials.RefreshToken != "renewed-refresh" {
		t.Fatal("browser cancellation lost the successfully rotated credentials")
	}
	requireStatus(t, request(s, "GET", "/api/me", cookie, ""), 200)
	if calls.Load() != 1 {
		t.Fatal("next request replayed a consumed refresh token")
	}
}

func TestRefreshFailuresNeverRetryUncertainOrRejectedCredentials(t *testing.T) {
	for _, mode := range []string{"network", "denied", "unavailable", "malformed", "missing refresh", "wrong token type", "wrong subject", "revoked identity", "encrypt failure"} {
		t.Run(mode, func(t *testing.T) {
			s, f := testServer(t)
			cookie := expiringSession(t, s, f)
			var calls atomic.Int32
			identity := refreshingIdentity(t, &calls)
			s.client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/oauth/token" {
					switch mode {
					case "network":
						return nil, errors.New("network failed after request write")
					case "denied":
						return identityResponse(400, `{"error":"invalid_grant"}`), nil
					case "unavailable":
						return identityResponse(503, `{}`), nil
					case "malformed":
						return identityResponse(200, `{`), nil
					case "missing refresh":
						return identityResponse(200, `{"access_token":"new","token_type":"Bearer","expires_in":900}`), nil
					case "wrong token type":
						return identityResponse(200, `{"access_token":"new","refresh_token":"new-refresh","token_type":"MAC","expires_in":900}`), nil
					}
				}
				if r.URL.Path == "/oauth/userinfo" {
					if mode == "wrong subject" {
						return identityResponse(200, `{"sub":"another-user"}`), nil
					}
					if mode == "revoked identity" {
						return identityResponse(403, `{}`), nil
					}
				}
				return identity(r)
			})
			if mode == "encrypt failure" {
				replaceEntropy(t, 1)
			}
			expected := 401
			if mode == "network" || mode == "unavailable" || mode == "encrypt failure" {
				expected = 503
			}
			requireStatus(t, request(s, "GET", "/api/me", cookie, ""), expected)
			if len(f.sessions) != 0 {
				t.Fatal("failed or uncertain refresh remained available for reuse")
			}
			requireStatus(t, request(s, "GET", "/api/me", cookie, ""), 401)
		})
	}
}

func TestSignedDocumentRefreshesIssuingSessionWithoutExtendingLink(t *testing.T) {
	s, f, cookie, _ := signedDocumentFixture(t)
	link, expiry := legacyDocumentURL(t, s, cookie)
	expiringSession(t, s, f)
	var calls atomic.Int32
	s.client.Transport = refreshingIdentity(t, &calls)
	requireStatus(t, request(s, "GET", link.RequestURI(), nil, ""), 302)
	if calls.Load() != 1 || time.Until(expiry) > documentURLLifetime {
		t.Fatal("document refresh altered the signed link lifetime")
	}
	requireStatus(t, request(s, "POST", "/auth/logout", cookie, s.config.UIOrigin), 204)
	requireStatus(t, request(s, "GET", link.RequestURI(), nil, ""), 403)
}

type noCredentialRotation struct{ Store }

func TestCredentialCompatibilityAndMissingRotationCapability(t *testing.T) {
	s, f := testServer(t)
	for _, plaintext := range []string{"", "{}", `{"access_token":"a","refresh_token":"b"}`} {
		encrypted, _ := s.encrypt(plaintext)
		if _, err := s.decryptCredentials(encrypted); err == nil {
			t.Fatal("invalid credentials accepted")
		}
	}
	cookie := authenticated(t, s, f)
	requireStatus(t, request(s, "GET", "/api/me", cookie, ""), 200)
	cookie = expiringSession(t, s, f)
	s.store = noCredentialRotation{f}
	requireStatus(t, request(s, "GET", "/api/me", cookie, ""), 503)
	row := f.sessions[digest(cookie.Value)]
	row.expiry = time.Now().Add(-time.Second)
	f.sessions[digest(cookie.Value)] = row
	if _, failure := s.sessionIdentity(context.Background(), digest(cookie.Value)); failure == nil || failure.status != 401 {
		t.Fatal("expired absolute session remained active")
	}
}
