package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"testing"
	"time"
)

func mysqlSessionCount(t *testing.T, f *mysqlAPIFixture, hash string) int {
	t.Helper()
	var count int
	if err := f.db.QueryRow("SELECT COUNT(*) FROM guidance_sessions WHERE token_hash=?", hash).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func mysqlWriteCredentials(t *testing.T, f *mysqlAPIFixture, hash string, credentials sessionCredentials) {
	t.Helper()
	encrypted, err := f.app.encryptCredentials(credentials)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.Exec("UPDATE guidance_sessions SET access_ciphertext=? WHERE token_hash=?", encrypted, hash); err != nil {
		t.Fatal(err)
	}
}

func TestMySQLSessionRejectsExpiredMissingAndCorruptCredentials(t *testing.T) {
	for _, mode := range []string{"missing", "expired", "short ciphertext", "tampered ciphertext", "empty plaintext", "invalid JSON", "incomplete credentials", "legacy access token"} {
		t.Run(mode, func(t *testing.T) {
			f := newMySQLAPIFixture(t)
			client := f.login(t, "alice")
			hash, credentials, _ := f.currentCredentials(t, client)
			expected := 503
			preserved := true
			switch mode {
			case "missing":
				if _, err := f.db.Exec("DELETE FROM guidance_sessions WHERE token_hash=?", hash); err != nil {
					t.Fatal(err)
				}
				expected = 401
				preserved = false
			case "expired":
				if _, err := f.db.Exec("UPDATE guidance_sessions SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 SECOND WHERE token_hash=?", hash); err != nil {
					t.Fatal(err)
				}
				expected = 401
			default:
				var encrypted []byte
				var err error
				switch mode {
				case "short ciphertext":
					encrypted = []byte{1, 2, 3}
				case "tampered ciphertext":
					encrypted, err = f.app.encryptCredentials(credentials)
					if err == nil {
						encrypted[len(encrypted)-1] ^= 0xff
					}
				case "empty plaintext":
					encrypted, err = f.app.encrypt("")
				case "invalid JSON":
					encrypted, err = f.app.encrypt("{")
				case "incomplete credentials":
					encrypted, err = f.app.encrypt(`{"access_token":"only-one-field"}`)
				case "legacy access token":
					encrypted, err = f.app.encrypt(credentials.AccessToken)
					expected = 200
				}
				if err != nil {
					t.Fatal(err)
				}
				if _, err = f.db.Exec("UPDATE guidance_sessions SET access_ciphertext=? WHERE token_hash=?", encrypted, hash); err != nil {
					t.Fatal(err)
				}
			}
			f.send(t, client, "GET", "/api/me", "", expected)
			if (mysqlSessionCount(t, f, hash) == 1) != preserved {
				t.Fatal("credential failure unexpectedly changed persisted session ownership")
			}
		})
	}
}

func TestMySQLSessionIdentityFailuresPreserveOrRevokeTheSQLSession(t *testing.T) {
	for _, tc := range []struct {
		name      string
		status    int
		payload   string
		expected  int
		preserved bool
	}{
		{"unauthorized", 401, "", 401, false}, {"blocked", 403, "", 401, false}, {"provider outage", 503, "", 503, true},
		{"malformed identity", 0, "invalid-json", 503, true}, {"missing subject", 0, `{"email":"synthetic@example.test"}`, 503, true},
		{"changed subject", 0, `{"sub":"another-user","email":"synthetic@example.test"}`, 401, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMySQLAPIFixture(t)
			client := f.login(t, "alice")
			hash := f.sessionHash(t, client)
			f.mu.Lock()
			f.userinfoStatus = tc.status
			f.userinfoPayload = tc.payload
			f.mu.Unlock()
			f.send(t, client, "GET", "/api/me", "", tc.expected)
			if (mysqlSessionCount(t, f, hash) == 1) != tc.preserved {
				t.Fatal("identity outcome did not preserve/revoke the expected real SQL session")
			}
		})
	}
	t.Run("transport outage retains session", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		client := f.login(t, "alice")
		hash := f.sessionHash(t, client)
		f.issuer.Close()
		f.send(t, client, "GET", "/api/me", "", 503)
		if mysqlSessionCount(t, f, hash) != 1 {
			t.Fatal("transient identity outage removed local session")
		}
	})
}

func TestMySQLSessionRefreshFailuresFenceConsumedCredentials(t *testing.T) {
	for _, tc := range []struct {
		name     string
		status   int
		payload  string
		expected int
	}{
		{"rejected refresh", 400, "", 401}, {"unauthorized refresh", 401, "", 401}, {"blocked refresh", 403, "", 401},
		{"provider failure", 503, "", 503}, {"malformed refresh", 0, "invalid-json", 401},
		{"missing refresh token", 0, `{"access_token":"new","token_type":"Bearer","expires_in":900}`, 401},
		{"wrong token type", 0, `{"access_token":"new","refresh_token":"new-refresh","token_type":"Other","expires_in":900}`, 401},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newMySQLAPIFixture(t)
			client := f.login(t, "alice")
			hash, credentials, _ := f.currentCredentials(t, client)
			credentials.AccessExpiry = time.Now().Add(-time.Minute)
			mysqlWriteCredentials(t, f, hash, credentials)
			f.mu.Lock()
			f.refreshStatus = tc.status
			f.refreshPayload = tc.payload
			f.mu.Unlock()
			f.send(t, client, "GET", "/api/me", "", tc.expected)
			if mysqlSessionCount(t, f, hash) != 0 {
				t.Fatal("uncertain rotating credentials remained reusable in SQL")
			}
			f.send(t, client, "GET", "/api/me", "", 401)
		})
	}
	t.Run("refresh transport failure is fenced", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		client := f.login(t, "alice")
		hash, credentials, _ := f.currentCredentials(t, client)
		credentials.AccessExpiry = time.Now().Add(-time.Minute)
		mysqlWriteCredentials(t, f, hash, credentials)
		f.issuer.Close()
		f.send(t, client, "GET", "/api/me", "", 503)
		if mysqlSessionCount(t, f, hash) != 0 {
			t.Fatal("uncertain refresh transport failure retained SQL session")
		}
	})
	t.Run("refreshed credential survives temporary userinfo outage", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		client := f.login(t, "alice")
		hash, credentials, absolute := f.currentCredentials(t, client)
		credentials.AccessExpiry = time.Now().Add(-time.Minute)
		mysqlWriteCredentials(t, f, hash, credentials)
		f.mu.Lock()
		f.userinfoStatus = 503
		f.mu.Unlock()
		f.send(t, client, "GET", "/api/me", "", 503)
		_, updated, expiry := f.currentCredentials(t, client)
		if updated.AccessToken == credentials.AccessToken || updated.RefreshToken == credentials.RefreshToken || !expiry.Equal(absolute) {
			t.Fatal("rotated tokens were not durably stored at the existing absolute deadline")
		}
		f.mu.Lock()
		f.userinfoStatus = 0
		f.mu.Unlock()
		f.send(t, client, "GET", "/api/me", "", 200)
	})
}

func mysqlRenameSessionTable(t *testing.T, f *mysqlAPIFixture, table string) func() {
	t.Helper()
	backup := table + "_coverage_backup"
	if _, err := f.db.Exec("RENAME TABLE " + table + " TO " + backup); err != nil {
		t.Fatal(err)
	}
	restored := false
	restore := func() {
		if restored {
			return
		}
		if _, err := f.db.Exec("RENAME TABLE " + backup + " TO " + table); err != nil {
			t.Error(err)
		}
		restored = true
	}
	t.Cleanup(restore)
	return restore
}

func mysqlSessionTrigger(t *testing.T, f *mysqlAPIFixture, name, event string) {
	t.Helper()
	statement := "CREATE TRIGGER " + name + " BEFORE " + event + " ON guidance_sessions FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic session write rejected'"
	if _, err := f.db.Exec(statement); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := f.db.Exec("DROP TRIGGER IF EXISTS " + name); err != nil {
			t.Error(err)
		}
	})
}

func TestMySQLStoreRotationTransactionsKeepOrFenceTheActualRow(t *testing.T) {
	f := newMySQLAPIFixture(t)
	client := f.login(t, "alice")
	hash := f.sessionHash(t, client)
	store := SQLStore{DB: f.db}
	ctx := context.Background()
	original, expiry, err := store.Session(ctx, hash)
	if err != nil {
		t.Fatal(err)
	}
	updated, deadline, err := store.RotateSession(ctx, hash, func(current []byte, currentExpiry time.Time) ([]byte, error) {
		if !bytes.Equal(current, original) || !currentExpiry.Equal(expiry) {
			t.Fatal("rotation callback received another session")
		}
		return current, nil
	})
	if err != nil || !bytes.Equal(updated, original) || !deadline.Equal(expiry) {
		t.Fatal("read-only rotation changed the session")
	}
	sentinel := errors.New("synthetic operation aborted before refresh")
	if _, _, err = store.RotateSession(ctx, hash, func([]byte, time.Time) ([]byte, error) { return nil, sentinel }); !errors.Is(err, sentinel) {
		t.Fatal("callback error lost")
	}
	current, _, err := store.Session(ctx, hash)
	if err != nil || !bytes.Equal(current, original) {
		t.Fatal("failed callback modified persisted credentials")
	}
	if _, _, err = store.RotateSession(ctx, strings.Repeat("0", 64), func([]byte, time.Time) ([]byte, error) { t.Fatal("missing session callback invoked"); return nil, nil }); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing session not distinguished")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, _, err = store.RotateSession(canceled, hash, func([]byte, time.Time) ([]byte, error) {
		t.Fatal("canceled rotation invoked callback")
		return nil, nil
	}); err == nil {
		t.Fatal("canceled transaction accepted")
	}
	if _, _, err = store.RotateSession(ctx, hash, func([]byte, time.Time) ([]byte, error) { return nil, &invalidRotation{cause: sentinel} }); !errors.Is(err, sentinel) {
		t.Fatal("invalid rotation error lost")
	}
	if mysqlSessionCount(t, f, hash) != 0 {
		t.Fatal("invalid refresh did not durably fence the row")
	}
}

func TestMySQLStoreRotationRollsBackRealSQLWriteFailures(t *testing.T) {
	for _, event := range []string{"UPDATE", "DELETE"} {
		t.Run(event, func(t *testing.T) {
			f := newMySQLAPIFixture(t)
			client := f.login(t, "alice")
			hash := f.sessionHash(t, client)
			store := SQLStore{DB: f.db}
			original, _, err := store.Session(context.Background(), hash)
			if err != nil {
				t.Fatal(err)
			}
			mysqlSessionTrigger(t, f, "coverage_reject_session_"+strings.ToLower(event), event)
			_, _, err = store.RotateSession(context.Background(), hash, func(current []byte, _ time.Time) ([]byte, error) {
				if event == "DELETE" {
					return nil, &invalidRotation{cause: errors.New("synthetic consumed refresh")}
				}
				return append(append([]byte(nil), current...), 0), nil
			})
			if err == nil {
				t.Fatal("database trigger failure was hidden")
			}
			preserved, _, err := store.Session(context.Background(), hash)
			if err != nil || !bytes.Equal(preserved, original) {
				t.Fatal("failed transaction partially changed persisted session")
			}
		})
	}
	t.Run("unavailable SQL table", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		client := f.login(t, "alice")
		hash := f.sessionHash(t, client)
		restore := mysqlRenameSessionTable(t, f, "guidance_sessions")
		f.send(t, client, "GET", "/api/me", "", 503)
		if _, _, err := (SQLStore{DB: f.db}).RotateSession(context.Background(), hash, func([]byte, time.Time) ([]byte, error) { t.Fatal("SQL failure reached callback"); return nil, nil }); err == nil {
			t.Fatal("missing SQL table accepted")
		}
		if err := (SQLStore{DB: f.db}).Cleanup(context.Background()); err == nil {
			t.Fatal("cleanup SQL error hidden")
		}
		restore()
	})
}

func TestMySQLStoreFlowConsumptionAndCleanup(t *testing.T) {
	f := newMySQLAPIFixture(t)
	client := f.login(t, "alice")
	hash := f.sessionHash(t, client)
	store := SQLStore{DB: f.db}
	ctx := context.Background()
	flowHash := strings.Repeat("a", 64)
	expiredHash := strings.Repeat("b", 64)
	proof := []byte("synthetic encrypted verifier")
	if err := store.SaveFlow(ctx, flowHash, proof, time.Now().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveFlow(ctx, flowHash, proof, time.Now().Add(time.Minute)); err == nil {
		t.Fatal("duplicate flow overwrite accepted")
	}
	if got, err := store.Flow(ctx, flowHash); err != nil || !bytes.Equal(got, proof) {
		t.Fatal("active flow missing")
	}
	if got, err := store.ConsumeFlow(ctx, flowHash); err != nil || !bytes.Equal(got, proof) {
		t.Fatal("flow not consumed transactionally")
	}
	if _, err := store.ConsumeFlow(ctx, flowHash); !errors.Is(err, ErrNotFound) {
		t.Fatal("flow replay accepted")
	}
	if err := store.SaveFlow(ctx, expiredHash, proof, time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Flow(ctx, expiredHash); !errors.Is(err, ErrNotFound) {
		t.Fatal("expired flow readable")
	}
	if _, err := store.ConsumeFlow(ctx, expiredHash); !errors.Is(err, ErrNotFound) {
		t.Fatal("expired flow consumable")
	}
	if err := store.SaveSession(ctx, expiredHash, proof, time.Now().Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	if err := store.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	var oldFlows, oldSessions int
	if err := f.db.QueryRow("SELECT COUNT(*) FROM guidance_oauth_flows WHERE state_hash=?", expiredHash).Scan(&oldFlows); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow("SELECT COUNT(*) FROM guidance_sessions WHERE token_hash=?", expiredHash).Scan(&oldSessions); err != nil {
		t.Fatal(err)
	}
	if oldFlows != 0 || oldSessions != 0 || mysqlSessionCount(t, f, hash) != 1 {
		t.Fatal("cleanup failed retention boundary")
	}
	t.Run("flow deletion SQL failure rolls back", func(t *testing.T) {
		if err := store.SaveFlow(ctx, flowHash, proof, time.Now().Add(time.Minute)); err != nil {
			t.Fatal(err)
		}
		if _, err := f.db.Exec("CREATE TRIGGER coverage_reject_flow_delete BEFORE DELETE ON guidance_oauth_flows FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='synthetic flow delete rejected'"); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { f.db.Exec("DROP TRIGGER IF EXISTS coverage_reject_flow_delete") })
		if _, err := store.ConsumeFlow(ctx, flowHash); err == nil {
			t.Fatal("consume hid SQL delete failure")
		}
		if got, err := store.Flow(ctx, flowHash); err != nil || !bytes.Equal(got, proof) {
			t.Fatal("failed consume lost the original verifier")
		}
	})
	t.Run("flow query SQL failure", func(t *testing.T) {
		restore := mysqlRenameSessionTable(t, f, "guidance_oauth_flows")
		defer restore()
		if _, err := store.Flow(ctx, flowHash); err == nil {
			t.Fatal("missing flow store accepted")
		}
		if _, err := store.ConsumeFlow(ctx, flowHash); err == nil {
			t.Fatal("missing consume store accepted")
		}
	})
}

func mysqlPendingLogin(t *testing.T, f *mysqlAPIFixture) (*http.Client, string) {
	t.Helper()
	f.mu.Lock()
	f.loginSub = "pending"
	f.mu.Unlock()
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get(f.api.URL + "/auth/start")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 302 {
		t.Fatalf("start status%d", response.StatusCode)
	}
	response, err = client.Get(response.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 302 {
		t.Fatalf("synthetic authorization status%d", response.StatusCode)
	}
	return client, response.Header.Get("Location")
}

func mysqlLoginResult(t *testing.T, client *http.Client, target string, status int) {
	t.Helper()
	response, err := client.Get(target)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != status {
		t.Fatalf("login outcome%d expected%d: %s", response.StatusCode, status, body)
	}
}

func TestMySQLSessionOAuthFailuresConsumeOnlyTheIntendedFlow(t *testing.T) {
	for _, mode := range []string{"wrong state", "wrong issuer", "expired flow", "provider cancellation", "missing code", "overlong code", "corrupt verifier", "token rejection", "malformed token", "invalid token fields", "identity rejection", "session SQL insert failure", "token transport failure"} {
		t.Run(mode, func(t *testing.T) {
			f := newMySQLAPIFixture(t)
			client, callback := mysqlPendingLogin(t, f)
			parsed, err := url.Parse(callback)
			if err != nil {
				t.Fatal(err)
			}
			query := parsed.Query()
			expected := 400
			switch mode {
			case "wrong state":
				query.Set("state", strings.Repeat("z", 43))
			case "wrong issuer":
				query.Set("iss", "https://another-issuer.example.test")
			case "expired flow":
				if _, err := f.db.Exec("UPDATE guidance_oauth_flows SET expires_at=UTC_TIMESTAMP()-INTERVAL 1 SECOND"); err != nil {
					t.Fatal(err)
				}
			case "provider cancellation":
				query.Set("error", "access_denied")
				expected = 302
			case "missing code":
				query.Del("code")
			case "overlong code":
				query.Set("code", strings.Repeat("x", 2049))
			case "corrupt verifier":
				if _, err := f.db.Exec("UPDATE guidance_oauth_flows SET verifier_ciphertext=?", []byte{1, 2, 3}); err != nil {
					t.Fatal(err)
				}
				expected = 503
			case "token rejection":
				f.mu.Lock()
				f.tokenStatus = 400
				f.mu.Unlock()
				expected = 502
			case "malformed token":
				f.mu.Lock()
				f.tokenPayload = "invalid-json"
				f.mu.Unlock()
				expected = 502
			case "invalid token fields":
				f.mu.Lock()
				f.tokenPayload = `{"access_token":"only"}`
				f.mu.Unlock()
				expected = 502
			case "identity rejection":
				f.mu.Lock()
				f.userinfoStatus = 403
				f.mu.Unlock()
				expected = 502
			case "session SQL insert failure":
				mysqlSessionTrigger(t, f, "coverage_reject_session_insert", "INSERT")
				expected = 503
			case "token transport failure":
				f.issuer.Close()
				expected = 503
			}
			parsed.RawQuery = query.Encode()
			mysqlLoginResult(t, client, parsed.String(), expected)
			var sessions int
			if err := f.db.QueryRow("SELECT COUNT(*) FROM guidance_sessions").Scan(&sessions); err != nil {
				t.Fatal(err)
			}
			if sessions != 0 {
				t.Fatal("failed/cancelled flow created a session")
			}
			if mode != "wrong state" && mode != "wrong issuer" && mode != "expired flow" {
				var count int
				if err := f.db.QueryRow("SELECT COUNT(*) FROM guidance_oauth_flows").Scan(&count); err != nil {
					t.Fatal(err)
				}
				if count != 0 {
					t.Fatal("consumed authorization flow replayable after outcome")
				}
			}
		})
	}
}

func TestMySQLSessionOAuthReuseReauthenticationAndCreationLimit(t *testing.T) {
	t.Run("active flow reuse and malformed stored verifier", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		jar, _ := cookiejar.New(nil)
		client := &http.Client{Jar: jar, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		first, err := client.Get(f.api.URL + "/auth/start")
		if err != nil {
			t.Fatal(err)
		}
		first.Body.Close()
		second, err := client.Get(f.api.URL + "/auth/start")
		if err != nil {
			t.Fatal(err)
		}
		second.Body.Close()
		if first.StatusCode != 302 || second.StatusCode != 302 || first.Header.Get("Location") != second.Header.Get("Location") {
			t.Fatal("active browser flow was not reused")
		}
		var rows int
		if err := f.db.QueryRow("SELECT COUNT(*) FROM guidance_oauth_flows").Scan(&rows); err != nil || rows != 1 {
			t.Fatal("repeated start accumulated SQL state")
		}
		if _, err := f.db.Exec("UPDATE guidance_oauth_flows SET verifier_ciphertext=?", []byte{1, 2, 3}); err != nil {
			t.Fatal(err)
		}
		mysqlLoginResult(t, client, f.api.URL+"/auth/start", 503)
	})
	t.Run("reauthentication rotates old SQL session", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		client := f.login(t, "reauthentication")
		old := f.sessionHash(t, client)
		response, err := client.Get(f.api.URL + "/auth/start")
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 302 {
			t.Fatal("reauthentication did not finish")
		}
		replacement := f.sessionHash(t, client)
		if replacement == old || mysqlSessionCount(t, f, old) != 0 || mysqlSessionCount(t, f, replacement) != 1 {
			t.Fatal("reauthentication did not atomically replace local identity")
		}
		f.send(t, client, "GET", "/api/me", "", 200)
	})
	t.Run("HTTP flow creation burst bounded before further SQL writes", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		client := &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		limited := false
		for index := 0; index < 100; index++ {
			response, err := client.Get(f.api.URL + "/auth/start")
			if err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			if response.StatusCode == 429 {
				if response.Header.Get("Retry-After") == "" {
					t.Fatal("rate limit missing retry interval")
				}
				limited = true
				break
			}
			if response.StatusCode != 302 {
				t.Fatalf("unexpected flow status%d", response.StatusCode)
			}
		}
		if !limited {
			t.Fatal("public login flow creation unbounded")
		}
	})
}

func TestMySQLSessionLogoutPersistsRemovalAndReportsStoreFailures(t *testing.T) {
	t.Run("missing cookie remains idempotent", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		f.send(t, &http.Client{}, "POST", "/auth/logout", "", 204)
	})
	t.Run("session lookup SQL outage", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		client := f.login(t, "alice")
		restore := mysqlRenameSessionTable(t, f, "guidance_sessions")
		f.send(t, client, "POST", "/auth/logout", "", 503)
		restore()
	})
	t.Run("session delete SQL failure", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		client := f.login(t, "alice")
		hash := f.sessionHash(t, client)
		mysqlSessionTrigger(t, f, "coverage_reject_logout_delete", "DELETE")
		f.send(t, client, "POST", "/auth/logout", "", 503)
		if mysqlSessionCount(t, f, hash) != 1 {
			t.Fatal("failed logout deleted session despite rolled back SQL")
		}
	})
	t.Run("corrupt credential does not prevent local logout", func(t *testing.T) {
		f := newMySQLAPIFixture(t)
		client := f.login(t, "alice")
		hash := f.sessionHash(t, client)
		if _, err := f.db.Exec("UPDATE guidance_sessions SET access_ciphertext=? WHERE token_hash=?", []byte{1, 2, 3}, hash); err != nil {
			t.Fatal(err)
		}
		f.send(t, client, "POST", "/auth/logout", "", 204)
		if mysqlSessionCount(t, f, hash) != 0 {
			t.Fatal("corrupt local session retained after logout")
		}
	})
}
