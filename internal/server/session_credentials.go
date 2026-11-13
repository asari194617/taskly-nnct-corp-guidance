package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const sessionLifetime = 30 * 24 * time.Hour
const accessLifetime = 15 * time.Minute
const refreshWindow = 30 * time.Second

// Both credentials remain encrypted on the API server. The browser receives
// only a random local session ID, whose absolute expiry never slides on refresh.
type sessionCredentials struct {
	AccessToken  string    `json:"access_token"`
	RefreshToken string    `json:"refresh_token"`
	AccessExpiry time.Time `json:"access_expires_at"`
	Subject      string    `json:"subject"`
}

type oauthTokens struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
}

func (t oauthTokens) valid() bool {
	return t.AccessToken != "" && t.RefreshToken != "" && strings.EqualFold(t.TokenType, "Bearer") && t.ExpiresIn > 0
}

func (t oauthTokens) credentials(subject string) sessionCredentials {
	lifetime := time.Duration(t.ExpiresIn) * time.Second
	if t.ExpiresIn > int(accessLifetime/time.Second) {
		lifetime = accessLifetime
	}
	return sessionCredentials{AccessToken: t.AccessToken, RefreshToken: t.RefreshToken, AccessExpiry: time.Now().Add(lifetime), Subject: subject}
}

func (s *Server) encryptCredentials(credentials sessionCredentials) ([]byte, error) {
	payload, err := json.Marshal(credentials)
	if err != nil {
		return nil, err
	}
	return s.encrypt(string(payload))
}

func (s *Server) decryptCredentials(encrypted []byte) (sessionCredentials, error) {
	plaintext, err := s.decrypt(encrypted)
	if err != nil {
		return sessionCredentials{}, err
	}
	// Existing sessions have a single encrypted access token and retain their
	// original short expiry until the user signs in again.
	if !strings.HasPrefix(plaintext, "{") {
		if plaintext == "" {
			return sessionCredentials{}, errors.New("missing session credential")
		}
		return sessionCredentials{AccessToken: plaintext}, nil
	}
	var credentials sessionCredentials
	if json.Unmarshal([]byte(plaintext), &credentials) != nil || credentials.AccessToken == "" || credentials.RefreshToken == "" || credentials.AccessExpiry.IsZero() || credentials.Subject == "" {
		return sessionCredentials{}, errors.New("invalid session credentials")
	}
	return credentials, nil
}

// RotateSession serializes a refresh under a database row lock. Multiple API
// instances therefore cannot reuse one rotating upstream refresh token.
type SessionCredentialStore interface {
	RotateSession(context.Context, string, func([]byte, time.Time) ([]byte, error)) ([]byte, time.Time, error)
}

func (s SQLStore) RotateSession(ctx context.Context, hash string, rotate func([]byte, time.Time) ([]byte, error)) ([]byte, time.Time, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, time.Time{}, err
	}
	defer tx.Rollback()
	var current []byte
	var expiry time.Time
	err = tx.QueryRowContext(ctx, `SELECT access_ciphertext,expires_at FROM guidance_sessions WHERE token_hash=? AND expires_at>UTC_TIMESTAMP() FOR UPDATE`, hash).Scan(&current, &expiry)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, time.Time{}, ErrNotFound
	}
	if err != nil {
		return nil, time.Time{}, err
	}
	updated, err := rotate(current, expiry)
	if err != nil {
		var invalid *invalidRotation
		if errors.As(err, &invalid) {
			// Fence a consumed or uncertain refresh token before releasing the
			// row lock, so another process cannot retry it during cleanup.
			if _, deleteErr := tx.ExecContext(ctx, `DELETE FROM guidance_sessions WHERE token_hash=?`, hash); deleteErr != nil {
				return nil, time.Time{}, deleteErr
			}
			if commitErr := tx.Commit(); commitErr != nil {
				return nil, time.Time{}, commitErr
			}
		}
		return nil, time.Time{}, err
	}
	if !bytes.Equal(current, updated) {
		if _, err := tx.ExecContext(ctx, `UPDATE guidance_sessions SET access_ciphertext=? WHERE token_hash=?`, updated, hash); err != nil {
			return nil, time.Time{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, time.Time{}, err
	}
	return updated, expiry, nil
}

type sessionFailure struct {
	status int
	code   string
}

func (e *sessionFailure) Error() string { return e.code }

type invalidRotation struct{ cause error }

func (e *invalidRotation) Error() string { return e.cause.Error() }
func (e *invalidRotation) Unwrap() error { return e.cause }

func (s *Server) invalidateSession(ctx context.Context, hash string, credentials sessionCredentials) {
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_ = s.store.DeleteSession(cleanup, hash)
	s.revokeSessionTokens(cleanup, credentials)
}

func (s *Server) sessionIdentity(ctx context.Context, hash string) (User, *sessionFailure) {
	encrypted, expiry, err := s.store.Session(ctx, hash)
	if errors.Is(err, ErrNotFound) || (err == nil && !expiry.After(time.Now())) {
		return User{}, &sessionFailure{401, "authentication_required"}
	}
	if err != nil {
		return User{}, &sessionFailure{503, "session_unavailable"}
	}
	credentials, err := s.decryptCredentials(encrypted)
	if err != nil {
		return User{}, &sessionFailure{503, "session_unavailable"}
	}
	if credentials.RefreshToken != "" && !credentials.AccessExpiry.After(time.Now().Add(refreshWindow)) {
		store, ok := s.store.(SessionCredentialStore)
		if !ok {
			return User{}, &sessionFailure{503, "session_unavailable"}
		}
		refreshAttempted := false
		// Completing rotation must not depend on whether the user closes a tab.
		rotationContext, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		encrypted, _, err = store.RotateSession(rotationContext, hash, func(current []byte, expiry time.Time) (updated []byte, rotationError error) {
			defer func() {
				if refreshAttempted && rotationError != nil {
					rotationError = &invalidRotation{rotationError}
				}
			}()
			if !expiry.After(time.Now()) {
				return nil, &sessionFailure{401, "authentication_required"}
			}
			latest, err := s.decryptCredentials(current)
			if err != nil {
				return nil, &sessionFailure{503, "session_unavailable"}
			}
			if latest.AccessExpiry.After(time.Now().Add(refreshWindow)) {
				return current, nil // Another request already rotated the token.
			}
			refreshAttempted = true
			response, err := s.postForm(rotationContext, "/oauth/token", url.Values{"grant_type": {"refresh_token"}, "refresh_token": {latest.RefreshToken}, "client_id": {s.config.ClientID}})
			if err != nil {
				return nil, &sessionFailure{503, "identity_unavailable"}
			}
			if response.StatusCode != http.StatusOK {
				status := response.StatusCode
				response.Body.Close()
				if status == 400 || status == 401 || status == 403 {
					return nil, &sessionFailure{401, "authentication_required"}
				}
				return nil, &sessionFailure{503, "identity_unavailable"}
			}
			var tokens oauthTokens
			if decodeResponse(response, &tokens) != nil || !tokens.valid() {
				return nil, &sessionFailure{401, "authentication_required"}
			}
			// Persist the rotated pair before checking userinfo. A temporary
			// userinfo outage must not roll back to an already-used refresh token.
			return s.encryptCredentials(tokens.credentials(latest.Subject))
		})
		if err != nil {
			if refreshAttempted {
				// The provider may have consumed the rotating token even when its
				// response or our DB commit failed. Never retry an uncertain token.
				s.invalidateSession(ctx, hash, credentials)
			}
			var failure *sessionFailure
			if errors.As(err, &failure) {
				if failure.status == 401 && !refreshAttempted {
					s.invalidateSession(ctx, hash, credentials)
				}
				return User{}, failure
			}
			if errors.Is(err, ErrNotFound) {
				return User{}, &sessionFailure{401, "authentication_required"}
			}
			return User{}, &sessionFailure{503, "session_unavailable"}
		}
		credentials, err = s.decryptCredentials(encrypted)
		if err != nil {
			return User{}, &sessionFailure{503, "session_unavailable"}
		}
	}
	user, status, err := s.userinfo(ctx, credentials.AccessToken)
	if err != nil {
		if status == 401 || status == 403 {
			s.invalidateSession(ctx, hash, credentials)
			return User{}, &sessionFailure{401, "authentication_required"}
		}
		return User{}, &sessionFailure{503, "identity_unavailable"}
	}
	if credentials.Subject != "" && user.Sub != credentials.Subject {
		s.invalidateSession(ctx, hash, credentials)
		return User{}, &sessionFailure{401, "authentication_required"}
	}
	return user, nil
}
