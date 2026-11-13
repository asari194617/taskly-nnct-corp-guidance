package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func signedDocumentFixture(t *testing.T) (*Server, *fakeStore, *http.Cookie, string) {
	t.Helper()
	s, f := testServer(t)
	cookie := authenticated(t, s, f)
	body := "%PDF-1.4\nSynthetic signed document\n%%EOF\n"
	f.documents["guide"] = Document{ID: "guide", FileName: "synthetic.pdf", MIMEType: "application/pdf", Title: "Synthetic guide"}
	return s, f, cookie, body
}

func issueDocumentURL(t *testing.T, s *Server, cookie *http.Cookie) (*url.URL, time.Time) {
	t.Helper()
	w := request(s, "GET", "/api/documents/guide/url", cookie, s.config.UIOrigin)
	requireStatus(t, w, 200)
	var data struct {
		URL     string    `json:"url"`
		Expires time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(data.URL)
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme+"://"+u.Host != s.config.R2Endpoint || u.Path != "/"+s.config.R2Bucket+"/synthetic.pdf" || u.Query().Get("X-Amz-Signature") == "" {
		t.Fatalf("invalid URL contract: %s", data.URL)
	}
	if strings.Contains(data.URL, cookie.Value) || strings.Contains(data.URL, "upstream-access") {
		t.Fatal("credential exposed in document URL")
	}
	if data.Expires.IsZero() || time.Until(data.Expires) <= 0 || time.Until(data.Expires) > 5*time.Minute {
		t.Fatal("signed URL exceeds five minute lifetime")
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("signed URL issuance cacheable")
	}
	return u, data.Expires
}

func TestSignedDocumentsRequireLoginForIssuance(t *testing.T) {
	s, _, _, _ := signedDocumentFixture(t)
	requireStatus(t, request(s, "GET", "/api/documents/guide/url", nil, s.config.UIOrigin), 401)
	requireStatus(t, request(s, "GET", "/documents/guide", nil, ""), 403)
}

func TestSignedDocumentTokenRejectsExpiryInvalidClaimsAndEncoding(t *testing.T) {
	s, _, cookie, _ := signedDocumentFixture(t)
	now := time.Now().Truncate(time.Second)
	claims := signedDocumentClaims{DocumentID: "guide", SessionHash: digest(cookie.Value), ExpiresAt: now.Add(time.Minute).Unix()}
	parsed, ok := s.parseDocumentToken("guide", s.signDocumentToken(claims), now)
	if !ok || parsed != claims {
		t.Fatal("valid signed claims did not roundtrip")
	}
	for _, change := range []struct {
		name string
		edit func(*signedDocumentClaims)
	}{
		{"expired", func(c *signedDocumentClaims) { c.ExpiresAt = now.Unix() }},
		{"too far in future", func(c *signedDocumentClaims) { c.ExpiresAt = now.Add(5*time.Minute + time.Second).Unix() }},
		{"invalid session hash", func(c *signedDocumentClaims) { c.SessionHash = "not-a-session" }},
		{"another document", func(c *signedDocumentClaims) { c.DocumentID = "other" }},
	} {
		t.Run(change.name, func(t *testing.T) {
			value := claims
			change.edit(&value)
			if _, ok := s.parseDocumentToken("guide", s.signDocumentToken(value), now); ok {
				t.Fatal("invalid signed claims accepted")
			}
		})
	}
	valid := s.signDocumentToken(claims)
	for _, token := range []string{valid + ".extra", strings.Split(valid, ".")[0] + ".*", "", "a.b"} {
		if _, ok := s.parseDocumentToken("guide", token, now); ok {
			t.Fatal("invalid token encoding accepted")
		}
	}
	for _, payload := range []string{"???", base64.RawURLEncoding.EncodeToString([]byte("{")), base64.RawURLEncoding.EncodeToString([]byte("[]"))} {
		mac := hmac.New(sha256.New, s.documentSigningKey())
		_, _ = mac.Write([]byte(payload))
		token := payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
		if _, ok := s.parseDocumentToken("guide", token, now); ok {
			t.Fatal("invalid authenticated payload accepted")
		}
	}
	if _, ok := s.parseDocumentToken("../guide", valid, now); ok {
		t.Fatal("unsafe document ID accepted")
	}
	u := s.config.APIOrigin + "/documents/guide?token=" + url.QueryEscape(valid) + "&token=" + url.QueryEscape(valid)
	r := httptest.NewRequest("GET", u, nil)
	w := httptest.NewRecorder()
	s.Handler().ServeHTTP(w, r)
	requireStatus(t, w, 403)
	claims.ExpiresAt = now.Add(-time.Second).Unix()
	requireStatus(t, request(s, "GET", "/documents/guide?token="+url.QueryEscape(s.signDocumentToken(claims)), nil, ""), 403)
}

type secondSessionFailureStore struct {
	*fakeStore
	calls int
	err   error
}

func (f *secondSessionFailureStore) Session(ctx context.Context, key string) ([]byte, time.Time, error) {
	f.calls++
	if f.calls > 1 {
		return nil, time.Time{}, f.err
	}
	return f.fakeStore.Session(ctx, key)
}

func TestSignedDocumentIssuanceHandlesDocumentAndSessionFailures(t *testing.T) {
	for _, mode := range []string{"unknown document", "invalid document id", "unsupported mime", "document storage", "expired session", "session lost during issuance", "session storage during issuance"} {
		t.Run(mode, func(t *testing.T) {
			s, f, cookie, _ := signedDocumentFixture(t)
			path := "/api/documents/guide/url"
			want := 404
			switch mode {
			case "unknown document":
				delete(f.documents, "guide")
			case "invalid document id":
				path = "/api/documents/invalid!/url"
			case "unsupported mime":
				d := f.documents["guide"]
				d.MIMEType = "text/html"
				f.documents["guide"] = d
			case "document storage":
				f.errorDocument = errors.New("database unavailable")
				want = 503
			case "expired session":
				row := f.sessions[digest(cookie.Value)]
				row.expiry = time.Now().Add(-time.Second)
				f.sessions[digest(cookie.Value)] = row
				want = 401
			case "session lost during issuance":
				s.store = &secondSessionFailureStore{fakeStore: f, err: ErrNotFound}
				want = 401
			case "session storage during issuance":
				s.store = &secondSessionFailureStore{fakeStore: f, err: errors.New("database unavailable")}
				want = 503
			}
			requireStatus(t, request(s, "GET", path, cookie, s.config.UIOrigin), want)
		})
	}
}

func legacyDocumentURL(t *testing.T, s *Server, cookie *http.Cookie) (*url.URL, time.Time) {
	t.Helper()
	_, expiry := issueDocumentURL(t, s, cookie)
	claims := signedDocumentClaims{DocumentID: "guide", SessionHash: digest(cookie.Value), ExpiresAt: expiry.Unix()}
	u, err := url.Parse(s.config.APIOrigin + "/documents/guide?token=" + url.QueryEscape(s.signDocumentToken(claims)))
	if err != nil {
		t.Fatal(err)
	}
	return u, expiry
}
func TestLegacySignedDocumentsRedirectGetAndHeadToR2(t *testing.T) {
	s, _, cookie, _ := signedDocumentFixture(t)
	u, _ := legacyDocumentURL(t, s, cookie)
	for _, method := range []string{"GET", "HEAD"} {
		w := request(s, method, u.RequestURI(), nil, "")
		requireStatus(t, w, 302)
		target, _ := url.Parse(w.Header().Get("Location"))
		if target.Host != strings.TrimPrefix(s.config.R2Endpoint, "https://") || target.Path != "/"+s.config.R2Bucket+"/synthetic.pdf" {
			t.Fatal("legacy redirect changed allowed object")
		}
	}
}

func TestSignedDocumentSignatureIsBoundToPathAndToken(t *testing.T) {
	s, _, cookie, _ := signedDocumentFixture(t)
	original, _ := legacyDocumentURL(t, s, cookie)
	for _, change := range []struct {
		name   string
		mutate func(*url.URL)
	}{
		{"wrong document", func(u *url.URL) { u.Path = "/documents/other-guide" }},
		{"corrupted token", func(u *url.URL) { q := u.Query(); q.Set("token", "invalid"); u.RawQuery = q.Encode() }},
		{"modified payload", func(u *url.URL) {
			q := u.Query()
			token := q.Get("token")
			replacement := "A"
			if token[0] == 'A' {
				replacement = "B"
			}
			q.Set("token", replacement+token[1:])
			u.RawQuery = q.Encode()
		}},
		{"oversized token", func(u *url.URL) { q := u.Query(); q.Set("token", strings.Repeat("a", 16385)); u.RawQuery = q.Encode() }},
	} {
		t.Run(change.name, func(t *testing.T) {
			u := *original
			change.mutate(&u)
			requireStatus(t, request(s, "GET", u.RequestURI(), nil, ""), 403)
		})
	}
	other := *s
	other.config = s.config
	other.config.EncryptionKey = append([]byte(nil), s.config.EncryptionKey...)
	other.config.EncryptionKey[0] ^= 1
	// A different service key cannot turn the same bearer URL into authorization.
	otherServer, err := New(other.config, s.store, s.client)
	if err != nil {
		t.Fatal(err)
	}
	requireStatus(t, request(otherServer, "GET", original.RequestURI(), nil, ""), 403)
}

func TestSignedURLLifetimeNeverOutlivesTheSession(t *testing.T) {
	s, f, cookie, _ := signedDocumentFixture(t)
	row := f.sessions[digest(cookie.Value)]
	row.expiry = time.Now().Add(40 * time.Second)
	f.sessions[digest(cookie.Value)] = row
	_, expiry := issueDocumentURL(t, s, cookie)
	if expiry.After(row.expiry) {
		t.Fatal("document URL outlives parent session")
	}
}

func TestLegacySignedDocumentsStopWorkingAfterLogoutSessionExpiryOrRevocation(t *testing.T) {
	for _, mode := range []string{"logout", "missing session", "expired session", "upstream revoked", "upstream blocked"} {
		t.Run(mode, func(t *testing.T) {
			s, f, cookie, body := signedDocumentFixture(t)
			u, _ := legacyDocumentURL(t, s, cookie)
			switch mode {
			case "logout":
				requireStatus(t, request(s, "POST", "/auth/logout", cookie, s.config.UIOrigin), 204)
			case "missing session":
				delete(f.sessions, digest(cookie.Value))
			case "expired session":
				row := f.sessions[digest(cookie.Value)]
				row.expiry = time.Now().Add(-time.Second)
				f.sessions[digest(cookie.Value)] = row
			case "upstream revoked":
				s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return identityResponse(401, `{}`), nil })
			case "upstream blocked":
				s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return identityResponse(403, `{}`), nil })
			}
			w := request(s, "GET", u.RequestURI(), nil, "")
			if w.Code != 401 && w.Code != 403 {
				t.Fatalf("inactive parent authorized download: %d", w.Code)
			}
			if strings.Contains(w.Body.String(), body) {
				t.Fatal("private document returned on failed authorization")
			}
		})
	}
}

func TestLegacySignedDocumentsFailClosedOnStorageIdentityAndMetadataErrors(t *testing.T) {
	for _, mode := range []string{"session storage", "identity unavailable", "identity transport", "bad ciphertext", "document storage", "invalid filename", "unsupported mime"} {
		t.Run(mode, func(t *testing.T) {
			s, f, cookie, _ := signedDocumentFixture(t)
			u, _ := legacyDocumentURL(t, s, cookie)
			want := 503
			switch mode {
			case "session storage":
				f.errorSession = errors.New("database unavailable")
			case "identity unavailable":
				s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return identityResponse(503, `{}`), nil })
			case "identity transport":
				s.client.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) { return nil, errors.New("offline") })
			case "bad ciphertext":
				row := f.sessions[digest(cookie.Value)]
				row.encrypted = []byte("corrupt")
				f.sessions[digest(cookie.Value)] = row
			case "document storage":
				f.errorDocument = errors.New("database unavailable")
			case "invalid filename":
				d := f.documents["guide"]
				d.FileName = "../secret.pdf"
				f.documents["guide"] = d
				want = 404
			case "unsupported mime":
				d := f.documents["guide"]
				d.MIMEType = "text/html"
				f.documents["guide"] = d
				want = 404
			}
			requireStatus(t, request(s, "GET", u.RequestURI(), nil, ""), want)
		})
	}
}
