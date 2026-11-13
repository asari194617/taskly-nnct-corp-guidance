package server

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

func mockStore(t *testing.T) (SQLStore, sqlmock.Sqlmock) {
	t.Helper()
	db, m, err := sqlmock.New(sqlmock.MonitorPingsOption(true))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := m.ExpectationsWereMet(); err != nil {
			t.Error(err)
		}
		db.Close()
	})
	return SQLStore{DB: db}, m
}
func TestSQLStoreWriteAndCleanup(t *testing.T) {
	s, m := mockStore(t)
	ctx := context.Background()
	now := time.Now().UTC()
	failure := errors.New("storage unavailable")
	m.ExpectPing()
	if err := s.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	m.ExpectExec(regexp.QuoteMeta("INSERT INTO guidance_oauth_flows (state_hash,verifier_ciphertext,expires_at) VALUES (?,?,?)")).WithArgs("state", []byte("encrypted"), now).WillReturnResult(sqlmock.NewResult(1, 1))
	if err := s.SaveFlow(ctx, "state", []byte("encrypted"), now); err != nil {
		t.Fatal(err)
	}
	m.ExpectExec(regexp.QuoteMeta("INSERT INTO guidance_sessions (token_hash,access_ciphertext,expires_at) VALUES (?,?,?)")).WithArgs("hash", []byte("encrypted"), now).WillReturnResult(sqlmock.NewResult(1, 1))
	if err := s.SaveSession(ctx, "hash", []byte("encrypted"), now); err != nil {
		t.Fatal(err)
	}
	m.ExpectExec("DELETE FROM guidance_sessions WHERE token_hash").WithArgs("hash").WillReturnResult(sqlmock.NewResult(0, 1))
	if err := s.DeleteSession(ctx, "hash"); err != nil {
		t.Fatal(err)
	}
	m.ExpectExec("DELETE FROM guidance_sessions WHERE expires_at").WillReturnResult(sqlmock.NewResult(0, 2))
	m.ExpectExec("DELETE FROM guidance_oauth_flows WHERE expires_at").WillReturnResult(sqlmock.NewResult(0, 3))
	if err := s.Cleanup(ctx); err != nil {
		t.Fatal(err)
	}
	m.ExpectExec("DELETE FROM guidance_sessions WHERE expires_at").WillReturnError(failure)
	if err := s.Cleanup(ctx); !errors.Is(err, failure) {
		t.Fatal("cleanup failure hidden")
	}
}
func TestSQLStoreReads(t *testing.T) {
	s, m := mockStore(t)
	ctx := context.Background()
	expiry := time.Now().UTC()
	failure := errors.New("query failed")
	m.ExpectQuery("SELECT access_ciphertext,expires_at FROM guidance_sessions").WithArgs("hash").WillReturnRows(sqlmock.NewRows([]string{"access_ciphertext", "expires_at"}).AddRow([]byte("ciphertext"), expiry))
	token, actual, err := s.Session(ctx, "hash")
	if err != nil || string(token) != "ciphertext" || !actual.Equal(expiry) {
		t.Fatalf("session: %q %s %v", token, actual, err)
	}
	m.ExpectQuery("SELECT access_ciphertext,expires_at FROM guidance_sessions").WithArgs("missing").WillReturnError(sql.ErrNoRows)
	if _, _, err = s.Session(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing session not mapped")
	}
	m.ExpectQuery("SELECT payload FROM guidance_dataset WHERE id=1").WillReturnRows(sqlmock.NewRows([]string{"payload"}).AddRow(`{"event":{}}`))
	dataset, err := s.Dataset(ctx)
	if err != nil || string(dataset) != `{"event":{}}` {
		t.Fatalf("dataset: %s %v", dataset, err)
	}
	m.ExpectQuery("SELECT payload FROM guidance_dataset WHERE id=1").WillReturnError(sql.ErrNoRows)
	if _, err = s.Dataset(ctx); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing dataset not mapped")
	}
	m.ExpectQuery("SELECT id,file_name,mime_type,title FROM guidance_documents").WithArgs("guide").WillReturnRows(sqlmock.NewRows([]string{"id", "file_name", "mime_type", "title"}).AddRow("guide", "guide.pdf", "application/pdf", "Guide"))
	d, err := s.Document(ctx, "guide")
	if err != nil || d.FileName != "guide.pdf" || d.ID != "guide" {
		t.Fatalf("document: %+v %v", d, err)
	}
	m.ExpectQuery("SELECT id,file_name,mime_type,title FROM guidance_documents").WithArgs("missing").WillReturnError(sql.ErrNoRows)
	if _, err = s.Document(ctx, "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing document not mapped")
	}
	m.ExpectQuery("SELECT id,file_name,mime_type,title FROM guidance_documents").WithArgs("failure").WillReturnError(failure)
	if _, err = s.Document(ctx, "failure"); !errors.Is(err, failure) {
		t.Fatal("query failure hidden")
	}
}
func TestSQLStoreConsumesFlowAtomically(t *testing.T) {
	for _, tc := range []struct {
		name   string
		failAt string
	}{{"success", ""}, {"begin failure", "begin"}, {"missing", "missing"}, {"query failure", "query"}, {"delete failure", "delete"}, {"commit failure", "commit"}} {
		t.Run(tc.name, func(t *testing.T) {
			s, m := mockStore(t)
			failure := errors.New("database failure")
			begin := m.ExpectBegin()
			if tc.failAt == "begin" {
				begin.WillReturnError(failure)
			} else {
				query := m.ExpectQuery("SELECT verifier_ciphertext FROM guidance_oauth_flows.*FOR UPDATE").WithArgs("state")
				if tc.failAt == "missing" {
					query.WillReturnError(sql.ErrNoRows)
					m.ExpectRollback()
				} else if tc.failAt == "query" {
					query.WillReturnError(failure)
					m.ExpectRollback()
				} else {
					query.WillReturnRows(sqlmock.NewRows([]string{"verifier_ciphertext"}).AddRow([]byte("ciphertext")))
					del := m.ExpectExec("DELETE FROM guidance_oauth_flows WHERE state_hash").WithArgs("state")
					if tc.failAt == "delete" {
						del.WillReturnError(failure)
						m.ExpectRollback()
					} else {
						del.WillReturnResult(sqlmock.NewResult(0, 1))
						commit := m.ExpectCommit()
						if tc.failAt == "commit" {
							commit.WillReturnError(failure)
						}
					}
				}
			}
			value, err := s.ConsumeFlow(context.Background(), "state")
			if tc.failAt == "" {
				if err != nil || string(value) != "ciphertext" {
					t.Fatalf("flow: %q %v", value, err)
				}
			} else if tc.failAt == "missing" {
				if !errors.Is(err, ErrNotFound) {
					t.Fatal("missing flow not mapped")
				}
			} else if !errors.Is(err, failure) {
				t.Fatalf("failure not returned: %v", err)
			}
		})
	}
}

func TestSQLCredentialRotationLocksAndPreservesAbsoluteExpiry(t *testing.T) {
	for _, mode := range []string{"changed", "already rotated", "begin failure", "missing", "query failure", "callback failure", "invalid token", "invalidate delete failure", "invalidate commit failure", "update failure", "commit failure"} {
		t.Run(mode, func(t *testing.T) {
			store, mock := mockStore(t)
			expiry := time.Now().UTC().Add(sessionLifetime)
			unavailable := errors.New("storage unavailable")
			begin := mock.ExpectBegin()
			if mode == "begin failure" {
				begin.WillReturnError(unavailable)
			} else {
				query := mock.ExpectQuery("SELECT access_ciphertext,expires_at FROM guidance_sessions.*FOR UPDATE").WithArgs("hash")
				switch mode {
				case "missing":
					query.WillReturnError(sql.ErrNoRows)
					mock.ExpectRollback()
				case "query failure":
					query.WillReturnError(unavailable)
					mock.ExpectRollback()
				default:
					query.WillReturnRows(sqlmock.NewRows([]string{"access_ciphertext", "expires_at"}).AddRow([]byte("before"), expiry))
					switch mode {
					case "callback failure":
						mock.ExpectRollback()
					case "invalid token", "invalidate delete failure", "invalidate commit failure":
						remove := mock.ExpectExec("DELETE FROM guidance_sessions WHERE token_hash").WithArgs("hash")
						if mode == "invalidate delete failure" {
							remove.WillReturnError(unavailable)
							mock.ExpectRollback()
						} else {
							remove.WillReturnResult(sqlmock.NewResult(0, 1))
							commit := mock.ExpectCommit()
							if mode == "invalidate commit failure" {
								commit.WillReturnError(unavailable)
							}
						}
					default:
						if mode != "already rotated" {
							update := mock.ExpectExec("UPDATE guidance_sessions SET access_ciphertext=\\? WHERE token_hash=\\?").WithArgs([]byte("after"), "hash")
							if mode == "update failure" {
								update.WillReturnError(unavailable)
								mock.ExpectRollback()
							} else {
								update.WillReturnResult(sqlmock.NewResult(0, 1))
							}
						}
						if mode != "update failure" {
							commit := mock.ExpectCommit()
							if mode == "commit failure" {
								commit.WillReturnError(unavailable)
							}
						}
					}
				}
			}
			value, actualExpiry, err := store.RotateSession(context.Background(), "hash", func(current []byte, absolute time.Time) ([]byte, error) {
				if string(current) != "before" || !absolute.Equal(expiry) {
					t.Fatal("rotation lost the stored credentials or deadline")
				}
				if mode == "callback failure" {
					return nil, unavailable
				}
				if strings.HasPrefix(mode, "invalidate ") || mode == "invalid token" {
					return nil, &invalidRotation{unavailable}
				}
				if mode == "already rotated" {
					return current, nil
				}
				return []byte("after"), nil
			})
			if mode == "changed" || mode == "already rotated" {
				if err != nil || len(value) == 0 || !actualExpiry.Equal(expiry) {
					t.Fatalf("rotation changed the absolute expiry: %v", err)
				}
			} else if mode == "missing" {
				if !errors.Is(err, ErrNotFound) {
					t.Fatal("missing session was not mapped")
				}
			} else if !errors.Is(err, unavailable) {
				t.Fatalf("rotation failure hidden: %v", err)
			}
		})
	}
}

func TestSQLBookmarksAreScopedAndHandleFailures(t *testing.T) {
	s, m := mockStore(t)
	ctx := context.Background()
	failure := errors.New("unavailable")
	m.ExpectQuery("SELECT company_id FROM guidance_bookmarks WHERE user_sub").WithArgs("user-a").WillReturnRows(sqlmock.NewRows([]string{"company_id"}).AddRow("AM-1").AddRow("PM-2"))
	ids, err := s.Bookmarks(ctx, "user-a")
	if err != nil || len(ids) != 2 || ids[0] != "AM-1" {
		t.Fatalf("bookmarks: %v %v", ids, err)
	}
	m.ExpectQuery("SELECT company_id FROM guidance_bookmarks WHERE user_sub").WithArgs("user-b").WillReturnRows(sqlmock.NewRows([]string{"company_id"}))
	ids, err = s.Bookmarks(ctx, "user-b")
	if err != nil || ids == nil || len(ids) != 0 {
		t.Fatalf("empty bookmarks: %v %v", ids, err)
	}
	m.ExpectQuery("SELECT company_id FROM guidance_bookmarks WHERE user_sub").WithArgs("failure").WillReturnError(failure)
	if _, err = s.Bookmarks(ctx, "failure"); !errors.Is(err, failure) {
		t.Fatal("query error hidden")
	}
	m.ExpectQuery("SELECT company_id FROM guidance_bookmarks WHERE user_sub").WithArgs("scan").WillReturnRows(sqlmock.NewRows([]string{"company_id"}).AddRow(nil))
	if _, err = s.Bookmarks(ctx, "scan"); err == nil {
		t.Fatal("invalid data accepted")
	}
	m.ExpectQuery("SELECT company_id FROM guidance_bookmarks WHERE user_sub").WithArgs("rows").WillReturnRows(sqlmock.NewRows([]string{"company_id"}).AddRow("AM-1").RowError(0, failure))
	if _, err = s.Bookmarks(ctx, "rows"); !errors.Is(err, failure) {
		t.Fatal("row error hidden")
	}
	m.ExpectExec("INSERT INTO guidance_bookmarks").WithArgs("user-a", "AM-1").WillReturnResult(sqlmock.NewResult(0, 1))
	if err = s.AddBookmark(ctx, "user-a", "AM-1"); err != nil {
		t.Fatal(err)
	}
	m.ExpectExec("DELETE FROM guidance_bookmarks WHERE user_sub").WithArgs("user-a", "AM-1").WillReturnResult(sqlmock.NewResult(0, 1))
	if err = s.RemoveBookmark(ctx, "user-a", "AM-1"); err != nil {
		t.Fatal(err)
	}
}
