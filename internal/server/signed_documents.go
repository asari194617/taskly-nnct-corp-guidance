package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const documentURLLifetime = 5 * time.Minute

// The session hash identifies the issuing server-side session, never its cookie
// or the upstream access token. A link remains revocable through that session.
type signedDocumentClaims struct {
	DocumentID  string `json:"d"`
	SessionHash string `json:"s"`
	ExpiresAt   int64  `json:"e"`
}

var sessionHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (s *Server) documentSigningKey() []byte {
	mac := hmac.New(sha256.New, s.config.EncryptionKey)
	_, _ = mac.Write([]byte("taskly-guidance/document-url/v1"))
	return mac.Sum(nil)
}

func (s *Server) signDocumentToken(claims signedDocumentClaims) string {
	payload, _ := json.Marshal(claims)
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, s.documentSigningKey())
	_, _ = mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (s *Server) parseDocumentToken(id, token string, now time.Time) (signedDocumentClaims, bool) {
	var claims signedDocumentClaims
	if !documentIDPattern.MatchString(id) || len(token) > 2048 {
		return claims, false
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return claims, false
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return claims, false
	}
	mac := hmac.New(sha256.New, s.documentSigningKey())
	_, _ = mac.Write([]byte(parts[0]))
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return claims, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil || json.Unmarshal(payload, &claims) != nil {
		return claims, false
	}
	if claims.DocumentID != id || !sessionHashPattern.MatchString(claims.SessionHash) || claims.ExpiresAt <= now.Unix() || claims.ExpiresAt > now.Add(documentURLLifetime).Unix() {
		return signedDocumentClaims{}, false
	}
	return claims, true
}

func (s *Server) documentURL(w http.ResponseWriter, r *http.Request, _ User) {
	id := r.PathValue("id")
	if !documentIDPattern.MatchString(id) {
		failure(w, 404, "document_not_found")
		return
	}
	document, err := s.store.Document(r.Context(), id)
	if errors.Is(err, ErrNotFound) || (err == nil && !allowedDocumentMIME(document.MIMEType)) {
		failure(w, 404, "document_not_found")
		return
	}
	if err != nil {
		failure(w, 503, "document_unavailable")
		return
	}
	cookie, _ := r.Cookie(s.sessionCookieName()) // protect already verified it.
	sessionHash := digest(cookie.Value)
	_, sessionExpiry, err := s.store.Session(r.Context(), sessionHash)
	if errors.Is(err, ErrNotFound) || (err == nil && !sessionExpiry.After(time.Now())) {
		failure(w, 401, "authentication_required")
		return
	}
	if err != nil {
		failure(w, 503, "session_unavailable")
		return
	}
	expiry := time.Now().Add(documentURLLifetime)
	if sessionExpiry.Before(expiry) {
		expiry = sessionExpiry
	}
	expiry = expiry.Truncate(time.Second)
	if !expiry.After(time.Now()) {
		failure(w, 401, "authentication_required")
		return
	}
	token := s.signDocumentToken(signedDocumentClaims{DocumentID: id, SessionHash: sessionHash, ExpiresAt: expiry.Unix()})
	link := s.config.APIOrigin + "/documents/" + url.PathEscape(id) + "?" + url.Values{"token": {token}}.Encode()
	respond(w, 200, map[string]any{"url": link, "expires_at": expiry})
}

func (s *Server) signedDocument(w http.ResponseWriter, r *http.Request) {
	values := r.URL.Query()["token"]
	if len(values) != 1 {
		failure(w, 403, "invalid_document_link")
		return
	}
	claims, ok := s.parseDocumentToken(r.PathValue("id"), values[0], time.Now())
	if !ok {
		failure(w, 403, "invalid_document_link")
		return
	}
	access, expiry, err := s.store.Session(r.Context(), claims.SessionHash)
	if errors.Is(err, ErrNotFound) || (err == nil && !expiry.After(time.Now())) {
		failure(w, 403, "expired_document_link")
		return
	}
	if err != nil {
		failure(w, 503, "session_unavailable")
		return
	}
	token, err := s.decrypt(access)
	if err != nil {
		failure(w, 503, "session_unavailable")
		return
	}
	_, status, err := s.userinfo(r.Context(), token)
	if err != nil {
		if status == http.StatusUnauthorized || status == http.StatusForbidden {
			_ = s.store.DeleteSession(r.Context(), claims.SessionHash)
			failure(w, 403, "expired_document_link")
		} else {
			failure(w, 503, "identity_unavailable")
		}
		return
	}
	s.serveDocument(w, r)
}
