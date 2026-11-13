package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

var ErrNotFound = errors.New("not found")

type Document struct {
	ID       string
	FileName string
	MIMEType string
	Title    string
}

type Store interface {
	Ping(context.Context) error
	SaveFlow(context.Context, string, []byte, time.Time) error
	Flow(context.Context, string) ([]byte, error)
	ConsumeFlow(context.Context, string) ([]byte, error)
	SaveSession(context.Context, string, []byte, time.Time) error
	Session(context.Context, string) ([]byte, time.Time, error)
	DeleteSession(context.Context, string) error
	Dataset(context.Context) (json.RawMessage, error)
	Document(context.Context, string) (Document, error)
	Cleanup(context.Context) error
}

type SQLStore struct{ DB *sql.DB }

func (s SQLStore) Ping(ctx context.Context) error { return s.DB.PingContext(ctx) }
func (s SQLStore) SaveFlow(ctx context.Context, state string, verifier []byte, expiry time.Time) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO guidance_oauth_flows (state_hash,verifier_ciphertext,expires_at) VALUES (?,?,?)`, state, verifier, expiry.UTC())
	return err
}
func (s SQLStore) Flow(ctx context.Context, state string) ([]byte, error) {
	var verifier []byte
	err := s.DB.QueryRowContext(ctx, `SELECT verifier_ciphertext FROM guidance_oauth_flows WHERE state_hash=? AND expires_at>UTC_TIMESTAMP()`, state).Scan(&verifier)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return verifier, err
}
func (s SQLStore) ConsumeFlow(ctx context.Context, state string) ([]byte, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	var verifier []byte
	err = tx.QueryRowContext(ctx, `SELECT verifier_ciphertext FROM guidance_oauth_flows WHERE state_hash=? AND expires_at>UTC_TIMESTAMP() FOR UPDATE`, state).Scan(&verifier)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM guidance_oauth_flows WHERE state_hash=?`, state); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return verifier, nil
}
func (s SQLStore) SaveSession(ctx context.Context, token string, access []byte, expiry time.Time) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO guidance_sessions (token_hash,access_ciphertext,expires_at) VALUES (?,?,?)`, token, access, expiry.UTC())
	return err
}
func (s SQLStore) Session(ctx context.Context, token string) ([]byte, time.Time, error) {
	var access []byte
	var expiry time.Time
	err := s.DB.QueryRowContext(ctx, `SELECT access_ciphertext,expires_at FROM guidance_sessions WHERE token_hash=? AND expires_at>UTC_TIMESTAMP()`, token).Scan(&access, &expiry)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return access, expiry, err
}
func (s SQLStore) DeleteSession(ctx context.Context, token string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM guidance_sessions WHERE token_hash=?`, token)
	return err
}
func (s SQLStore) Dataset(ctx context.Context) (json.RawMessage, error) {
	var payload []byte
	err := s.DB.QueryRowContext(ctx, `SELECT payload FROM guidance_dataset WHERE id=1`).Scan(&payload)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return json.RawMessage(payload), err
}
func (s SQLStore) Document(ctx context.Context, id string) (Document, error) {
	var d Document
	err := s.DB.QueryRowContext(ctx, `SELECT id,file_name,mime_type,title FROM guidance_documents WHERE id=?`, id).Scan(&d.ID, &d.FileName, &d.MIMEType, &d.Title)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return d, err
}
func (s SQLStore) Cleanup(ctx context.Context) error {
	for _, q := range []string{`DELETE FROM guidance_sessions WHERE expires_at<=UTC_TIMESTAMP()`, `DELETE FROM guidance_oauth_flows WHERE expires_at<=UTC_TIMESTAMP()`} {
		if _, err := s.DB.ExecContext(ctx, q); err != nil {
			return err
		}
	}
	return nil
}
