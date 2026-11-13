package server

import (
	"context"
	"crypto/cipher"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Server struct {
	config Config
	store  Store
	client *http.Client
	aead   cipher.AEAD
}
type User struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

func New(c Config, store Store, client *http.Client) (*Server, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	c.SecureCookies = strings.HasPrefix(c.APIOrigin, "https://")
	aead, err := newCipher(c.EncryptionKey)
	if err != nil {
		return nil, err
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	}
	return &Server{config: c, store: store, client: client, aead: aead}, nil
}
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.health)
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("GET /auth/start", s.start)
	mux.HandleFunc("GET /auth/callback", s.callback)
	mux.HandleFunc("POST /auth/logout", s.logout)
	mux.HandleFunc("GET /api/me", s.protect(s.me))
	mux.HandleFunc("GET /api/guidance", s.protect(s.guidance))
	mux.HandleFunc("GET /api/documents/{id}", s.protect(s.document))
	mux.HandleFunc("GET /api/documents/{id}/url", s.protect(s.documentURL))
	mux.HandleFunc("GET /documents/{id}", s.signedDocument)
	mux.HandleFunc("GET /api/preferences", s.protect(s.preferences))
	mux.HandleFunc("PUT /api/preferences", s.protect(s.setPreferences))
	mux.HandleFunc("GET /api/bookmarks", s.protect(s.bookmarks))
	mux.HandleFunc("PUT /api/bookmarks/{companyID}", s.protect(s.addBookmark))
	mux.HandleFunc("DELETE /api/bookmarks/{companyID}", s.protect(s.removeBookmark))
	return s.middleware(mux)
}
func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; sandbox")
		w.Header().Add("Vary", "Origin")
		origin := r.Header.Get("Origin")
		if origin != "" {
			if origin != s.config.UIOrigin {
				failure(w, 403, "origin_not_allowed")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", s.config.UIOrigin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		if r.Method == http.MethodOptions {
			if origin == "" {
				failure(w, 403, "origin_required")
				return
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Range")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.WriteHeader(204)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead && origin != s.config.UIOrigin {
			failure(w, 403, "origin_required")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}
func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Ping(r.Context()); err != nil {
		failure(w, 503, "unavailable")
		return
	}
	respond(w, 200, map[string]string{"status": "ok"})
}
func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Ping(r.Context()); err != nil {
		failure(w, 503, "unavailable")
		return
	}
	if _, err := s.store.Dataset(r.Context()); err != nil {
		failure(w, 503, "dataset_unavailable")
		return
	}
	respond(w, 200, map[string]string{"status": "ready"})
}
func (s *Server) protect(next func(http.ResponseWriter, *http.Request, User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(s.sessionCookieName())
		if err != nil || !validToken(cookie.Value) {
			failure(w, 401, "authentication_required")
			return
		}
		access, _, err := s.store.Session(r.Context(), digest(cookie.Value))
		if errors.Is(err, ErrNotFound) {
			s.clearCookie(w, s.sessionCookieName())
			failure(w, 401, "authentication_required")
			return
		}
		if err != nil {
			failure(w, 503, "session_unavailable")
			return
		}
		token, err := s.decrypt(access)
		if err != nil {
			slog.Error("session decryption failed")
			failure(w, 503, "session_unavailable")
			return
		}
		user, status, err := s.userinfo(r.Context(), token)
		if err != nil {
			if status == 401 || status == 403 {
				_ = s.store.DeleteSession(r.Context(), digest(cookie.Value))
				s.clearCookie(w, s.sessionCookieName())
				failure(w, 401, "authentication_required")
			} else {
				failure(w, 503, "identity_unavailable")
			}
			return
		}
		next(w, r, user)
	}
}
func (s *Server) me(w http.ResponseWriter, r *http.Request, user User) {
	respond(w, 200, map[string]User{"user": user})
}
func (s *Server) guidance(w http.ResponseWriter, r *http.Request, _ User) {
	data, err := s.store.Dataset(r.Context())
	if err != nil {
		failure(w, 503, "dataset_unavailable")
		return
	}
	respond(w, 200, data)
}

var documentIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func (s *Server) document(w http.ResponseWriter, r *http.Request, _ User) {
	s.serveDocument(w, r)
}

func (s *Server) serveDocument(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !documentIDPattern.MatchString(id) {
		failure(w, 404, "document_not_found")
		return
	}
	d, err := s.store.Document(r.Context(), id)
	if errors.Is(err, ErrNotFound) {
		failure(w, 404, "document_not_found")
		return
	}
	if err != nil {
		failure(w, 503, "document_unavailable")
		return
	}
	// Only flat, allowlisted regular files are served. Symlinks are rejected even
	// within the private directory to make deployment mistakes fail closed.
	if d.FileName == "" || d.FileName == "." || filepath.Base(d.FileName) != d.FileName || strings.ContainsAny(d.FileName, "/\\") || !allowedDocumentMIME(d.MIMEType) {
		failure(w, 404, "document_not_found")
		return
	}
	root, err := os.OpenRoot(s.config.DataDir)
	if err != nil {
		failure(w, 503, "document_unavailable")
		return
	}
	defer root.Close()
	st, err := root.Lstat(d.FileName)
	if err != nil || !st.Mode().IsRegular() {
		failure(w, 404, "document_not_found")
		return
	}
	f, err := root.Open(d.FileName)
	if err != nil {
		failure(w, 404, "document_not_found")
		return
	}
	defer f.Close()
	st, err = f.Stat()
	if err != nil || !st.Mode().IsRegular() {
		failure(w, 404, "document_not_found")
		return
	}
	w.Header().Set("Content-Type", d.MIMEType)
	w.Header().Set("Content-Disposition", `inline; filename="`+id+documentExtension(d.MIMEType)+`"`)
	http.ServeContent(w, r, d.FileName, st.ModTime(), f)
}
func allowedDocumentMIME(v string) bool {
	return v == "image/png" || v == "image/jpeg" || v == "application/pdf"
}
func documentExtension(v string) string {
	switch v {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	default:
		return ".pdf"
	}
}
func respond(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func failure(w http.ResponseWriter, status int, code string) {
	respond(w, status, map[string]string{"error": code})
}
func decodeResponse(resp *http.Response, v any) error {
	defer resp.Body.Close()
	dec := json.NewDecoder(io.LimitReader(resp.Body, 1<<20))
	return dec.Decode(v)
}
func (s *Server) sessionCookieName() string {
	if s.config.SecureCookies {
		return "__Host-guidance_session"
	}
	return "guidance_session"
}
func (s *Server) flowCookieName() string {
	if s.config.SecureCookies {
		return "__Host-guidance_flow"
	}
	return "guidance_flow"
}
func validToken(v string) bool {
	if len(v) != 43 {
		return false
	}
	for _, c := range v {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
			return false
		}
	}
	return true
}
func (s *Server) cookie(w http.ResponseWriter, name, value string, expiry time.Time) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: value, Path: "/", Expires: expiry, MaxAge: int(time.Until(expiry).Seconds()), HttpOnly: true, Secure: s.config.SecureCookies, SameSite: http.SameSiteLaxMode})
}
func (s *Server) clearCookie(w http.ResponseWriter, name string) {
	http.SetCookie(w, &http.Cookie{Name: name, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: s.config.SecureCookies, SameSite: http.SameSiteLaxMode})
}
