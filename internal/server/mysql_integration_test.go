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
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-sql-driver/mysql"
)

// CI provides a disposable MySQL database. This test never contacts production
// identity services and imports only synthetic data into that disposable DB.
func TestMySQLIntegration(t *testing.T) {
	dsn := os.Getenv("MYSQL_TEST_DSN")
	if dsn == "" {
		t.Skip("MYSQL_TEST_DSN unset; real MySQL integration runs in CI")
	}
	connection, err := mysql.ParseDSN(dsn)
	if err != nil {
		t.Fatal("MYSQL_TEST_DSN has an invalid test database configuration")
	}
	if !strings.HasSuffix(connection.DBName, "_test") && !strings.HasSuffix(connection.DBName, "_e2e") {
		t.Fatal("MYSQL_TEST_DSN must name a disposable database ending in _test or _e2e")
	}
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	schema, err := os.ReadFile("../../schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range strings.Split(string(schema), ";") {
		if strings.TrimSpace(statement) != "" {
			if _, err := db.ExecContext(ctx, statement); err != nil {
				t.Fatal(err)
			}
		}
	}
	for _, table := range []string{"guidance_preferences", "guidance_bookmarks", "guidance_sessions", "guidance_oauth_flows", "guidance_documents", "guidance_dataset"} {
		if _, err := db.ExecContext(ctx, "DELETE FROM "+table); err != nil {
			t.Fatal(err)
		}
	}
	payload := `{"event":{"title":"Synthetic integration event"},"companies":[{"id":"AM-1","name":"Example company","session":"AM","booth":1,"industries":[]}],"schedule":[],"assignments":[{"department":"電子制御工学科","grade":4,"number":7,"visits":[]},{"department":"電子制御工学科","grade":4,"number":8,"visits":[]}],"documents":[],"notices":[]}`
	if _, err := db.ExecContext(ctx, `INSERT INTO guidance_dataset(id,payload) VALUES(1,?)`, payload); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "synthetic.pdf"), []byte("%PDF-1.4 synthetic document"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO guidance_documents(id,file_name,mime_type,title) VALUES('example-map','synthetic.pdf','application/pdf','Example map')`); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	var subject, expectedChallenge string
	revoked := map[string]bool{}
	identities := map[string]string{}
	refreshFamilies := map[string]string{}
	activeRefresh := map[string]bool{}
	familySubjects := map[string]string{}
	familyTokens := map[string][]string{}
	refreshCounts := map[string]int{}
	serial := 0
	issueTokens := func(id, family string) map[string]any {
		serial++
		if family == "" {
			family = fmt.Sprintf("family-%d", serial)
			familySubjects[family] = id
		}
		access := fmt.Sprintf("access-%s-%d", id, serial)
		refresh := fmt.Sprintf("refresh-%s-%d", id, serial)
		identities[access] = id
		refreshFamilies[refresh] = family
		activeRefresh[refresh] = true
		familyTokens[family] = append(familyTokens[family], access, refresh)
		return map[string]any{"access_token": access, "refresh_token": refresh, "token_type": "Bearer", "expires_in": 900}
	}
	var apiOrigin string
	issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/oauth/authorize":
			q := r.URL.Query()
			if q.Get("code_challenge_method") != "S256" || q.Get("client_id") != "integration-client" || q.Get("redirect_uri") != apiOrigin+"/auth/callback" {
				t.Error("invalid authorization request")
			}
			expectedChallenge = q.Get("code_challenge")
			callback := q.Get("redirect_uri") + "?code=synthetic-code&state=" + url.QueryEscape(q.Get("state")) + "&iss=" + url.QueryEscape("http://"+r.Host)
			http.Redirect(w, r, callback, http.StatusFound)
		case "/oauth/token":
			if err := r.ParseForm(); err != nil {
				t.Error(err)
			}
			if r.Form.Get("grant_type") == "refresh_token" {
				refresh := r.Form.Get("refresh_token")
				family := refreshFamilies[refresh]
				if family == "" || !activeRefresh[refresh] || revoked[refresh] || r.Form.Get("client_id") != "integration-client" || r.Header.Get("Authorization") != "" {
					w.WriteHeader(400)
					return
				}
				activeRefresh[refresh] = false
				id := familySubjects[family]
				refreshCounts[id]++
				_ = json.NewEncoder(w).Encode(issueTokens(id, family))
				return
			}
			h := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
			if base64.RawURLEncoding.EncodeToString(h[:]) != expectedChallenge || r.Form.Get("client_id") != "integration-client" || r.Header.Get("Authorization") != "" {
				t.Error("PKCE/public client exchange mismatch")
			}
			_ = json.NewEncoder(w).Encode(issueTokens(subject, ""))
		case "/oauth/userinfo":
			token := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
			if revoked[token] || identities[token] == "" {
				w.WriteHeader(401)
				return
			}
			_ = json.NewEncoder(w).Encode(User{Sub: identities[token], Email: "student@example.test", Name: "Example student"})
		case "/oauth/revoke":
			_ = r.ParseForm()
			token := r.Form.Get("token")
			revoked[token] = true
			if family := refreshFamilies[token]; family != "" {
				for _, credential := range familyTokens[family] {
					revoked[credential] = true
				}
			}
			w.WriteHeader(200)
		default:
			w.WriteHeader(404)
		}
	}))
	defer issuer.Close()
	apiServer := httptest.NewUnstartedServer(nil)
	apiOrigin = "http://" + apiServer.Listener.Addr().String()
	cfg := Config{UIOrigin: "http://127.0.0.1:3000", APIOrigin: apiOrigin, AuthIssuer: issuer.URL, ClientID: "integration-client", DataDir: dir, EncryptionKey: make([]byte, 32)}
	app, err := New(cfg, SQLStore{DB: db}, nil)
	if err != nil {
		t.Fatal(err)
	}
	apiServer.Config.Handler = app.Handler()
	apiServer.Start()
	defer apiServer.Close()
	request := func(client *http.Client, method, path string, status int, payload ...string) string {
		t.Helper()
		var body io.Reader
		if len(payload) != 0 {
			body = strings.NewReader(payload[0])
		}
		req, _ := http.NewRequest(method, apiOrigin+path, body)
		req.Header.Set("Origin", cfg.UIOrigin)
		if len(payload) != 0 {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		responseBody, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != status {
			t.Fatalf("%s %s: got %d want %d: %s", method, path, resp.StatusCode, status, responseBody)
		}
		if resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("private response cacheable")
		}
		return string(responseBody)
	}
	login := func(id string) *http.Client {
		t.Helper()
		mu.Lock()
		subject = id
		mu.Unlock()
		jar, _ := cookiejar.New(nil)
		client := &http.Client{Jar: jar, Timeout: 10 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if strings.HasPrefix(req.URL.String(), cfg.UIOrigin) {
				return http.ErrUseLastResponse
			}
			return nil
		}}
		resp, err := client.Get(apiOrigin + "/auth/start")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 302 || resp.Header.Get("Location") != cfg.UIOrigin+"/" {
			t.Fatalf("login failed: %d %s", resp.StatusCode, resp.Header.Get("Location"))
		}
		for _, cookie := range resp.Cookies() {
			if cookie.Name == "guidance_session" && (cookie.MaxAge < 2591990 || cookie.MaxAge > 2592000 || time.Until(cookie.Expires) < sessionLifetime-time.Minute) {
				t.Fatal("one-month browser session deadline not issued")
			}
		}
		return client
	}
	request(http.DefaultClient, "GET", "/api/guidance", 401)
	alice := login("alice")
	var cipherText []byte
	if err := db.QueryRowContext(ctx, `SELECT access_ciphertext FROM guidance_sessions LIMIT 1`).Scan(&cipherText); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(cipherText), "access-") {
		t.Fatal("upstream token stored unencrypted")
	}
	var flows int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM guidance_oauth_flows`).Scan(&flows); err != nil || flows != 0 {
		t.Fatalf("authorization state not consumed: %d, %v", flows, err)
	}
	if !strings.Contains(request(alice, "GET", "/api/me", 200), `"alice"`) {
		t.Fatal("identity mismatch")
	}
	request(alice, "GET", "/api/guidance", 200)
	if !strings.Contains(request(alice, "GET", "/api/preferences", 200), `"roster_number":null`) {
		t.Fatal("first visit unexpectedly configured")
	}
	request(alice, "PUT", "/api/preferences", 422, `{"roster_number":99}`)
	request(alice, "PUT", "/api/preferences", 200, `{"roster_number":7}`)
	if !strings.Contains(request(alice, "GET", "/api/preferences", 200), `"roster_number":7`) {
		t.Fatal("roster preference not persisted")
	}
	if !strings.HasPrefix(request(alice, "GET", "/api/documents/example-map", 200), "%PDF") {
		t.Fatal("document mismatch")
	}
	var aliceDocument struct {
		URL string `json:"url"`
	}
	if err := json.Unmarshal([]byte(request(alice, "GET", "/api/documents/example-map/url", 200)), &aliceDocument); err != nil {
		t.Fatal(err)
	}
	aliceDocumentPath := strings.TrimPrefix(aliceDocument.URL, apiOrigin)
	if !strings.HasPrefix(request(http.DefaultClient, "GET", aliceDocumentPath, 200), "%PDF") {
		t.Fatal("signed document did not open without browser credentials")
	}
	request(http.DefaultClient, "HEAD", aliceDocumentPath, 200)
	request(alice, "PUT", "/api/bookmarks/AM-1", 204)
	request(alice, "PUT", "/api/bookmarks/AM-1", 204)
	if !strings.Contains(request(alice, "GET", "/api/bookmarks", 200), `"AM-1"`) {
		t.Fatal("bookmark not saved")
	}
	bob := login("bob")
	if !strings.Contains(request(bob, "GET", "/api/preferences", 200), `"roster_number":null`) {
		t.Fatal("cross-user roster preference leak")
	}
	request(bob, "PUT", "/api/preferences", 200, `{"roster_number":8}`)
	if !strings.Contains(request(alice, "GET", "/api/preferences", 200), `"roster_number":7`) {
		t.Fatal("other user overwrote roster preference")
	}
	if strings.Contains(request(bob, "GET", "/api/bookmarks", 200), `"AM-1"`) {
		t.Fatal("cross-user bookmark leak")
	}
	request(bob, "DELETE", "/api/bookmarks/AM-1", 204)
	if !strings.Contains(request(alice, "GET", "/api/bookmarks", 200), `"AM-1"`) {
		t.Fatal("other user deleted bookmark")
	}
	aliceOtherDevice := login("alice")
	if !strings.Contains(request(aliceOtherDevice, "GET", "/api/preferences", 200), `"roster_number":7`) {
		t.Fatal("roster preference missing on other device")
	}
	if !strings.Contains(request(aliceOtherDevice, "GET", "/api/bookmarks", 200), `"AM-1"`) {
		t.Fatal("bookmark missing on other device")
	}
	request(aliceOtherDevice, "DELETE", "/api/bookmarks/AM-1", 204)
	request(alice, "GET", "/api/bookmarks", 200)
	request(alice, "PUT", "/api/bookmarks/unknown", 404)
	request(bob, "POST", "/auth/logout", 204)
	request(bob, "GET", "/api/me", 401)
	mu.Lock()
	for token, id := range identities {
		if id == "alice" {
			revoked[token] = true
		}
	}
	mu.Unlock()
	request(alice, "GET", "/api/guidance", 401)
	request(aliceOtherDevice, "GET", "/api/documents/example-map", 401)
	request(http.DefaultClient, "GET", aliceDocumentPath, 403)
	// Independent API instances share a DB row lock, not an in-process mutex.
	// Age the encrypted access credential beyond its 900-second lifetime while
	// retaining the same 30-day browser session, preferences and saved companies.
	rotating := login("rotating")
	request(rotating, "PUT", "/api/preferences", 200, `{"roster_number":7}`)
	request(rotating, "PUT", "/api/bookmarks/AM-1", 204)
	apiURL, _ := url.Parse(apiOrigin)
	var rotatingHash string
	for _, cookie := range rotating.Jar.Cookies(apiURL) {
		if cookie.Name == "guidance_session" {
			rotatingHash = digest(cookie.Value)
		}
	}
	if rotatingHash == "" {
		t.Fatal("missing rotating session")
	}
	oldCiphertext, absoluteExpiry, err := (SQLStore{DB: db}).Session(ctx, rotatingHash)
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := app.decryptCredentials(oldCiphertext)
	if err != nil {
		t.Fatal(err)
	}
	oldAccess, oldRefresh := credentials.AccessToken, credentials.RefreshToken
	credentials.AccessExpiry = time.Now().Add(-16 * time.Minute)
	aged, err := app.encryptCredentials(credentials)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `UPDATE guidance_sessions SET access_ciphertext=? WHERE token_hash=?`, aged, rotatingHash); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	revoked[oldAccess] = true // An expired upstream access token cannot be used.
	mu.Unlock()
	secondDB, err := sql.Open("mysql", dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer secondDB.Close()
	secondDB.SetMaxOpenConns(1)
	secondApp, err := New(cfg, SQLStore{DB: secondDB}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var concurrent sync.WaitGroup
	results := make(chan error, 8)
	for index := range 8 {
		instance := app
		if index%2 == 1 {
			instance = secondApp
		}
		concurrent.Add(1)
		go func() {
			defer concurrent.Done()
			user, failure := instance.sessionIdentity(ctx, rotatingHash)
			if failure != nil {
				results <- failure
			} else if user.Sub != "rotating" {
				results <- fmt.Errorf("rotation changed subject")
			} else {
				results <- nil
			}
		}()
	}
	concurrent.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatalf("concurrent cross-instance refresh failed: %v", err)
		}
	}
	mu.Lock()
	count := refreshCounts["rotating"]
	mu.Unlock()
	if count != 1 {
		t.Fatalf("rotating refresh token consumed %d times", count)
	}
	updatedCiphertext, updatedExpiry, err := (SQLStore{DB: db}).Session(ctx, rotatingHash)
	if err != nil {
		t.Fatal(err)
	}
	updated, err := app.decryptCredentials(updatedCiphertext)
	if err != nil || updated.AccessToken == oldAccess || updated.RefreshToken == oldRefresh || !absoluteExpiry.Equal(updatedExpiry) {
		t.Fatal("refresh did not atomically replace encrypted tokens at the original deadline")
	}
	if !strings.Contains(request(rotating, "GET", "/api/preferences", 200), `"roster_number":7`) || !strings.Contains(request(rotating, "GET", "/api/bookmarks", 200), `"AM-1"`) {
		t.Fatal("session refresh lost user preferences or saved companies")
	}
	request(rotating, "POST", "/auth/logout", 204)
	request(rotating, "GET", "/api/me", 401)
	mu.Lock()
	familyRevoked := revoked[updated.AccessToken] && revoked[updated.RefreshToken]
	mu.Unlock()
	if !familyRevoked {
		t.Fatal("logout did not revoke the rotated upstream token family")
	}
	expired := login("expired")
	for _, cookie := range expired.Jar.Cookies(apiURL) {
		if cookie.Name == "guidance_session" {
			if _, err := db.ExecContext(ctx, `UPDATE guidance_sessions SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 SECOND WHERE token_hash=?`, digest(cookie.Value)); err != nil {
				t.Fatal(err)
			}
		}
	}
	request(expired, "GET", "/api/me", 401)
	t.Log("Real MySQL verified OAuth PKCE, signed documents, roster preferences, user isolation, cross-device bookmarks, cross-instance rotating refresh, logout and revocation")
}
