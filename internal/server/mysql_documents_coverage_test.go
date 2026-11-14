package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestMySQLDocumentSignedURLAndRevocableCompatibility(t *testing.T) {
	f := newMySQLAPIFixture(t)
	alice := f.login(t, "document-reader")
	hash := f.sessionHash(t, alice)
	// The authenticated issuance deadline is bounded by this actual SQL session.
	deadline := time.Now().Add(45 * time.Second)
	if _, err := f.db.Exec("UPDATE guidance_sessions SET expires_at=? WHERE token_hash=?", deadline.UTC(), hash); err != nil {
		t.Fatal(err)
	}
	body := f.send(t, alice, "GET", "/api/documents/guide/url", "", 200)
	var link struct {
		URL     string    `json:"url"`
		Expires time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(body, &link); err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(link.URL)
	if err != nil {
		t.Fatal(err)
	}
	seconds, err := strconv.Atoi(parsed.Query().Get("X-Amz-Expires"))
	if err != nil || seconds < 1 || seconds > 45 || link.Expires.After(deadline) {
		t.Fatal("signed document outlived its SQL session")
	}
	if parsed.Query().Get("response-content-type") != "application/pdf" || !strings.HasPrefix(parsed.Query().Get("response-content-disposition"), "inline;") {
		t.Fatal("document presentation overrides missing")
	}
	claims := signedDocumentClaims{DocumentID: "guide", SessionHash: hash, ExpiresAt: time.Now().Add(30 * time.Second).Unix()}
	token := f.app.signDocumentToken(claims)
	path := "/documents/guide?token=" + url.QueryEscape(token)
	payload := f.send(t, http.DefaultClient, "GET", path, "", 200)
	if !strings.HasPrefix(string(payload), "%PDF") {
		t.Fatal("legacy signed link failed to reach object service without cookie")
	}
	f.send(t, http.DefaultClient, "HEAD", path, "", 200)
	f.send(t, alice, "POST", "/auth/logout", "", 204)
	f.send(t, http.DefaultClient, "GET", path, "", 403)
	f.send(t, alice, "GET", "/api/documents/guide/url", "", 401)
	// Direct R2 URLs already issued remain bearer links until their short expiry;
	// the compatibility API URL above separately rechecks revocable SQL session.
	request, err := http.NewRequest("GET", link.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Range", "bytes=0-3")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 206 {
		t.Fatalf("direct range status%d", response.StatusCode)
	}
}

func TestMySQLDocumentRejectsInvalidLegacyClaimsAndMetadata(t *testing.T) {
	f := newMySQLAPIFixture(t)
	client := f.login(t, "document-validation")
	hash := f.sessionHash(t, client)
	valid := signedDocumentClaims{DocumentID: "guide", SessionHash: hash, ExpiresAt: time.Now().Add(time.Minute).Unix()}
	token := f.app.signDocumentToken(valid)
	f.send(t, http.DefaultClient, "GET", "/documents/guide", "", 403)
	f.send(t, http.DefaultClient, "GET", "/documents/guide?token="+url.QueryEscape(token)+"&token=duplicate", "", 403)
	for _, bad := range []string{"missing-dot", "a.%%%", "a.YQ", strings.Repeat("a", 2049)} {
		f.send(t, http.DefaultClient, "GET", "/documents/guide?token="+url.QueryEscape(bad), "", 403)
	}
	for _, change := range []func(*signedDocumentClaims){func(c *signedDocumentClaims) { c.DocumentID = "other" }, func(c *signedDocumentClaims) { c.SessionHash = "invalid" }, func(c *signedDocumentClaims) { c.ExpiresAt = time.Now().Add(-time.Second).Unix() }, func(c *signedDocumentClaims) { c.ExpiresAt = time.Now().Add(10 * time.Minute).Unix() }} {
		claims := valid
		change(&claims)
		f.send(t, http.DefaultClient, "GET", "/documents/guide?token="+url.QueryEscape(f.app.signDocumentToken(claims)), "", 403)
	}
	// A correctly signed but corrupted legacy payload is still rejected before SQL
	// identity or object reads. No unit helper or fake persistence is involved.
	encoded := base64.RawURLEncoding.EncodeToString([]byte("not-json"))
	mac := hmac.New(sha256.New, f.app.documentSigningKey())
	mac.Write([]byte(encoded))
	malformed := encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	f.send(t, http.DefaultClient, "GET", "/documents/guide?token="+url.QueryEscape(malformed), "", 403)
	for _, path := range []string{"/api/documents/invalid!/url", "/api/documents/missing/url", "/api/documents/missing", "/api/documents/invalid!"} {
		f.send(t, client, "GET", path, "", 404)
	}
	if _, err := f.db.Exec("UPDATE guidance_documents SET file_name='../private.pdf' WHERE id='guide'"); err != nil {
		t.Fatal(err)
	}
	f.send(t, client, "GET", "/api/documents/guide/url", "", 404)
	f.send(t, client, "GET", "/api/documents/guide", "", 404)
	if _, err := f.db.Exec("UPDATE guidance_documents SET file_name='synthetic.pdf',mime_type='text/html' WHERE id='guide'"); err != nil {
		t.Fatal(err)
	}
	f.send(t, client, "GET", "/api/documents/guide/url", "", 404)
	if _, err := f.db.Exec("UPDATE guidance_documents SET mime_type='application/pdf' WHERE id='guide'"); err != nil {
		t.Fatal(err)
	}
	// A metadata outage produces an unavailable error, never an unsigned fallback.
	if _, err := f.db.Exec("RENAME TABLE guidance_documents TO synthetic_documents_unavailable"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { f.db.Exec("RENAME TABLE synthetic_documents_unavailable TO guidance_documents") })
	f.send(t, client, "GET", "/api/documents/guide/url", "", 503)
	f.send(t, client, "GET", "/api/documents/guide", "", 503)
}

func TestMySQLHTTPReadinessSecurityAndCleanup(t *testing.T) {
	f := newMySQLAPIFixture(t)
	f.send(t, http.DefaultClient, "GET", "/healthz", "", 200)
	f.send(t, http.DefaultClient, "GET", "/readyz", "", 200)
	for _, test := range []struct {
		method, origin string
		status         int
	}{{"OPTIONS", "", 403}, {"OPTIONS", f.cfg.UIOrigin, 204}, {"GET", "https://other.example.test", 403}, {"POST", "", 403}} {
		request, err := http.NewRequest(test.method, f.api.URL+"/api/home", nil)
		if err != nil {
			t.Fatal(err)
		}
		if test.origin != "" {
			request.Header.Set("Origin", test.origin)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != test.status {
			t.Fatalf("%s origin gate%d want%d", test.method, response.StatusCode, test.status)
		}
	}
	expired := time.Now().Add(-time.Hour)
	future := time.Now().Add(time.Hour)
	store := SQLStore{DB: f.db}
	if err := store.SaveFlow(context.Background(), digest("expired-flow"), []byte("synthetic"), expired); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveFlow(context.Background(), digest("live-flow"), []byte("synthetic"), future); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveSession(context.Background(), digest("expired-session"), []byte("synthetic"), expired); err != nil {
		t.Fatal(err)
	}
	if err := store.Cleanup(context.Background()); err != nil {
		t.Fatal(err)
	}
	var flows, sessions int
	if err := f.db.QueryRow("SELECT COUNT(*) FROM guidance_oauth_flows").Scan(&flows); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow("SELECT COUNT(*) FROM guidance_sessions").Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if flows != 1 || sessions != 0 {
		t.Fatal("cleanup removed live rows or retained expired rows")
	}
	if _, err := f.db.Exec("DELETE FROM guidance_dataset"); err != nil {
		t.Fatal(err)
	}
	f.send(t, http.DefaultClient, "GET", "/readyz", "", 503)
	client := f.login(t, "missing-dataset")
	f.send(t, client, "GET", "/api/guidance", "", 503)
}
