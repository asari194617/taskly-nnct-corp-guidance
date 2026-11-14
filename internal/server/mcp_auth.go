package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
)

const mcpPublicClientID = "nnct-guidance-chatgpt"
const mcpBackendClientID = "nnct-guidance-mcp-backend"
const mcpReadScope = "guidance:read"
const mcpBookmarkWriteScope = "guidance:bookmarks:write"
const mcpTaskWriteScope = "guidance:tasks:write"
const exchangedAccessType = "urn:ietf:params:oauth:token-type:access_token"
const mcpRequestTimeout = 20 * time.Second

type mcpRequestContextKey struct{}

// The SDK intentionally detaches HTTP cancellation for legacy protocols. Keep
// that request's lifetime as a value, then join it with the SDK's tool context
// so neither HTTP cancellation nor protocol-level cancellation is lost.
func mcpToolContext(ctx context.Context) (context.Context, context.CancelFunc) {
	deadline := time.Now().Add(mcpRequestTimeout)
	original, _ := ctx.Value(mcpRequestContextKey{}).(context.Context)
	if original != nil {
		if expires, ok := original.Deadline(); ok && expires.Before(deadline) {
			deadline = expires
		}
	}
	bounded, cancel := context.WithDeadline(ctx, deadline)
	if original == nil {
		return bounded, cancel
	}
	stop := context.AfterFunc(original, cancel)
	if original.Err() != nil {
		cancel()
	}
	return bounded, func() {
		stop()
		cancel()
	}
}

func (s *Server) mcpResource() string { return s.config.APIOrigin + "/mcp" }
func (s *Server) mcpMetadataURL() string {
	return s.config.APIOrigin + "/.well-known/oauth-protected-resource/mcp"
}
func (s *Server) mcpTasklyResource() string {
	return s.config.TasklyAPIOrigin + "/integrations/nnct-guidance/tasks"
}

type mcpIdentity struct {
	Active    bool   `json:"active"`
	Subject   string `json:"sub"`
	ClientID  string `json:"client_id"`
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	Expires   int64  `json:"exp"`
	Scope     string `json:"scope"`
	TokenType string `json:"token_type"`
}

type mcpProblem struct {
	status int
	code   string
}

func (p *mcpProblem) Error() string { return p.code }

// The dedicated backend credential can introspect this resource and exchange
// a live user token. It cannot log in as a user or mint client-credentials grants.
func (s *Server) mcpPost(ctx context.Context, path string, form url.Values) (int, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.config.AuthIssuer+path, strings.NewReader(form.Encode()))
	if err != nil {
		return 0, nil, err
	}
	request.SetBasicAuth(mcpBackendClientID, s.config.MCPBackendSecret)
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	client := &http.Client{Transport: s.client.Transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 16385))
	if err != nil || len(payload) > 16384 {
		return 0, nil, fmt.Errorf("identity response unavailable")
	}
	return response.StatusCode, payload, nil
}

func (s *Server) verifyMCP(ctx context.Context, token string) (*auth.TokenInfo, *mcpProblem) {
	status, payload, err := s.mcpPost(ctx, "/oauth/introspect", url.Values{"token": {token}, "token_type_hint": {"access_token"}})
	if err != nil || status != 200 {
		return nil, &mcpProblem{503, "identity_unavailable"}
	}
	var identity mcpIdentity
	if json.Unmarshal(payload, &identity) != nil {
		return nil, &mcpProblem{503, "identity_unavailable"}
	}
	uid, err := strconv.ParseUint(identity.Subject, 10, 64)
	scopes := strings.Fields(identity.Scope)
	read := false
	for _, scope := range scopes {
		switch scope {
		case mcpReadScope:
			read = true
		case mcpBookmarkWriteScope, mcpTaskWriteScope:
		default:
			return nil, &mcpProblem{401, "invalid_token"}
		}
	}
	if err != nil || uid == 0 || !identity.Active || identity.ClientID != mcpPublicClientID || identity.Issuer != s.config.AuthIssuer || identity.Audience != s.mcpResource() || identity.Expires <= time.Now().Unix() || identity.TokenType != "Bearer" || !read {
		return nil, &mcpProblem{401, "invalid_token"}
	}
	return &auth.TokenInfo{UserID: identity.Subject, Scopes: scopes, Expiration: time.Unix(identity.Expires, 0)}, nil
}

func (s *Server) mcpChallenge(scope, code string) string {
	if scope != mcpReadScope {
		scope = mcpReadScope + " " + scope
	}
	value := fmt.Sprintf("Bearer resource_metadata=%q, scope=%q", s.mcpMetadataURL(), scope)
	if code != "" {
		value += fmt.Sprintf(", error=%q, error_description=%q", code, "Taskly authorization is required for this operation")
	}
	return value
}

func (s *Server) mcpAuthorize(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		origin, _ := url.Parse(s.config.APIOrigin)
		if !strings.EqualFold(r.Host, origin.Host) {
			failure(w, 403, "host_not_allowed")
			return
		}
		// Server-to-server MCP calls do not require a browser Origin. If one is
		// supplied it must name this same resource; cookies never authorize MCP.
		if supplied := r.Header.Get("Origin"); supplied != "" && supplied != s.config.APIOrigin {
			failure(w, 403, "origin_not_allowed")
			return
		}
		if allowed, retry := s.mcpLimit.allow(time.Now()); !allowed {
			w.Header().Set("Retry-After", strconv.Itoa(retry))
			failure(w, 429, "mcp_rate_limited")
			return
		}
		fields := strings.Fields(r.Header.Get("Authorization"))
		if len(r.Header.Values("Authorization")) != 1 || len(fields) != 2 || !strings.EqualFold(fields[0], "Bearer") || len(fields[1]) > 4096 || r.Header.Get("Cookie") != "" {
			w.Header().Set("WWW-Authenticate", s.mcpChallenge(mcpReadScope, ""))
			failure(w, 401, "authentication_required")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), mcpRequestTimeout)
		defer cancel()
		r = r.WithContext(context.WithValue(ctx, mcpRequestContextKey{}, ctx))
		info, problem := s.verifyMCP(ctx, fields[1])
		if problem != nil {
			if problem.status == 401 {
				w.Header().Set("WWW-Authenticate", s.mcpChallenge(mcpReadScope, "invalid_token"))
			}
			failure(w, problem.status, problem.code)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
		// Use the official SDK to attach the validated principal and expiry. Its
		// verifier receives only this request's token, never a cookie/session token.
		verified := func(_ context.Context, token string, _ *http.Request) (*auth.TokenInfo, error) {
			if token != fields[1] {
				return nil, auth.ErrInvalidToken
			}
			return info, nil
		}
		auth.RequireBearerToken(verified, &auth.RequireBearerTokenOptions{ResourceMetadataURL: s.mcpMetadataURL(), Scopes: []string{mcpReadScope}})(next).ServeHTTP(w, r)
	})
}

func (s *Server) exchangeMCP(ctx context.Context, token string, write bool) (string, *mcpProblem) {
	scope := "guidance:tasks:read"
	if write {
		scope = mcpTaskWriteScope
	}
	status, payload, err := s.mcpPost(ctx, "/oauth/token", url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:token-exchange"}, "subject_token": {token}, "subject_token_type": {exchangedAccessType}, "requested_token_type": {exchangedAccessType}, "resource": {s.mcpTasklyResource()}, "scope": {scope}})
	if err != nil {
		return "", &mcpProblem{503, "identity_unavailable"}
	}
	if status != 200 {
		if status == 400 || status == 401 || status == 403 {
			return "", &mcpProblem{401, "authentication_required"}
		}
		return "", &mcpProblem{503, "identity_unavailable"}
	}
	var result struct {
		AccessToken     string `json:"access_token"`
		TokenType       string `json:"token_type"`
		ExpiresIn       int    `json:"expires_in"`
		IssuedTokenType string `json:"issued_token_type"`
		Scope           string `json:"scope"`
		RefreshToken    string `json:"refresh_token"`
	}
	if json.Unmarshal(bytes.TrimSpace(payload), &result) != nil || result.AccessToken == "" || len(result.AccessToken) > 4096 || result.TokenType != "Bearer" || result.ExpiresIn < 1 || result.ExpiresIn > 60 || result.IssuedTokenType != exchangedAccessType || result.Scope != scope || result.RefreshToken != "" {
		return "", &mcpProblem{503, "invalid_delegation_response"}
	}
	return result.AccessToken, nil
}
