package server

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

func (s *Server) start(w http.ResponseWriter, r *http.Request) {
	state, err := randomToken()
	if err != nil {
		failure(w, 500, "login_unavailable")
		return
	}
	verifier, err := randomToken()
	if err != nil {
		failure(w, 500, "login_unavailable")
		return
	}
	encrypted, err := s.encrypt(verifier)
	if err != nil {
		failure(w, 500, "login_unavailable")
		return
	}
	expiry := time.Now().Add(5 * time.Minute)
	if err = s.store.SaveFlow(r.Context(), digest(state), encrypted, expiry); err != nil {
		failure(w, 503, "login_unavailable")
		return
	}
	s.cookie(w, s.flowCookieName(), state, expiry)
	h := sha256.Sum256([]byte(verifier))
	q := url.Values{"response_type": {"code"}, "client_id": {s.config.ClientID}, "redirect_uri": {s.config.APIOrigin + "/auth/callback"}, "scope": {"taskly:login"}, "state": {state}, "code_challenge": {base64.RawURLEncoding.EncodeToString(h[:])}, "code_challenge_method": {"S256"}}
	http.Redirect(w, r, s.config.AuthIssuer+"/oauth/authorize?"+q.Encode(), http.StatusFound)
}
func (s *Server) callback(w http.ResponseWriter, r *http.Request) {
	state := r.URL.Query().Get("state")
	cookie, err := r.Cookie(s.flowCookieName())
	if err != nil || !validToken(state) || subtle.ConstantTimeCompare([]byte(state), []byte(cookie.Value)) != 1 {
		failure(w, 400, "invalid_login_state")
		return
	}
	s.clearCookie(w, s.flowCookieName())
	if r.URL.Query().Get("iss") != s.config.AuthIssuer {
		failure(w, 400, "invalid_issuer")
		return
	}
	encrypted, err := s.store.ConsumeFlow(r.Context(), digest(state))
	if errors.Is(err, ErrNotFound) {
		failure(w, 400, "expired_login")
		return
	}
	if err != nil {
		failure(w, 503, "login_unavailable")
		return
	}
	if r.URL.Query().Get("error") != "" {
		http.Redirect(w, r, s.config.UIOrigin+"/?auth_error=login_cancelled", http.StatusFound)
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" || len(code) > 2048 {
		failure(w, 400, "invalid_code")
		return
	}
	verifier, err := s.decrypt(encrypted)
	if err != nil {
		failure(w, 503, "login_unavailable")
		return
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier}, "redirect_uri": {s.config.APIOrigin + "/auth/callback"}, "client_id": {s.config.ClientID}}
	resp, err := s.postForm(r.Context(), "/oauth/token", form)
	if err != nil {
		failure(w, 503, "identity_unavailable")
		return
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		failure(w, 502, "login_exchange_failed")
		return
	}
	var tokens struct {
		AccessToken string `json:"access_token"`
		TokenType   string `json:"token_type"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err = decodeResponse(resp, &tokens); err != nil || tokens.AccessToken == "" || !strings.EqualFold(tokens.TokenType, "Bearer") || tokens.ExpiresIn <= 0 {
		failure(w, 502, "invalid_identity_response")
		return
	}
	if _, _, err = s.userinfo(r.Context(), tokens.AccessToken); err != nil {
		failure(w, 502, "identity_unavailable")
		return
	}
	if tokens.ExpiresIn > 900 {
		tokens.ExpiresIn = 900
	}
	access, err := s.encrypt(tokens.AccessToken)
	if err != nil {
		failure(w, 500, "login_unavailable")
		return
	}
	session, err := randomToken()
	if err != nil {
		failure(w, 500, "login_unavailable")
		return
	}
	expiry := time.Now().Add(time.Duration(tokens.ExpiresIn) * time.Second)
	if err = s.store.SaveSession(r.Context(), digest(session), access, expiry); err != nil {
		failure(w, 503, "login_unavailable")
		return
	}
	// Successful re-authentication rotates the local session and removes the old
	// one without ever exposing the upstream access token to the browser.
	if old, err := r.Cookie(s.sessionCookieName()); err == nil && validToken(old.Value) {
		_ = s.store.DeleteSession(r.Context(), digest(old.Value))
	}
	s.cookie(w, s.sessionCookieName(), session, expiry)
	http.Redirect(w, r, s.config.UIOrigin+"/", http.StatusFound)
}
func (s *Server) userinfo(ctx context.Context, access string) (User, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.config.AuthIssuer+"/oauth/userinfo", nil)
	if err != nil {
		return User{}, 0, err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	resp, err := s.client.Do(req)
	if err != nil {
		return User{}, 0, err
	}
	status := resp.StatusCode
	if status != 200 {
		resp.Body.Close()
		return User{}, status, fmt.Errorf("identity status %d", status)
	}
	var user User
	if err := decodeResponse(resp, &user); err != nil {
		return User{}, status, err
	}
	if user.Sub == "" {
		return User{}, status, errors.New("missing identity subject")
	}
	return user, status, nil
}
func (s *Server) postForm(ctx context.Context, path string, form url.Values) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.config.AuthIssuer+path, strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return s.client.Do(req)
}
func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(s.sessionCookieName())
	if err != nil || !validToken(cookie.Value) {
		s.clearCookie(w, s.sessionCookieName())
		w.WriteHeader(204)
		return
	}
	access, _, lookupErr := s.store.Session(r.Context(), digest(cookie.Value))
	if lookupErr != nil && !errors.Is(lookupErr, ErrNotFound) {
		failure(w, 503, "session_unavailable")
		return
	}
	if err = s.store.DeleteSession(r.Context(), digest(cookie.Value)); err != nil {
		failure(w, 503, "logout_unavailable")
		return
	}
	s.clearCookie(w, s.sessionCookieName())
	if lookupErr == nil {
		if token, err := s.decrypt(access); err == nil {
			resp, err := s.postForm(r.Context(), "/oauth/revoke", url.Values{"token": {token}, "client_id": {s.config.ClientID}})
			if err == nil {
				resp.Body.Close()
			}
		}
	}
	w.WriteHeader(204)
}
