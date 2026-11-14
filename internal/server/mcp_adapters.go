package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
)

type mcpResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func (w *mcpResponse) Header() http.Header { return w.header }
func (w *mcpResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}
func (w *mcpResponse) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = 200
	}
	if w.body.Len()+len(body) > 1<<20 {
		return 0, io.ErrShortBuffer
	}
	return w.body.Write(body)
}

// Invoke the existing authorized-user business handlers without inventing a
// browser cookie/session. The MCP transport already verified identity and scope;
// the handler still performs its normal assignment, ownership and DB checks.
func (s *Server) mcpInvoke(ctx context.Context, user User, method, key, pathValue string, input any, token string, handler func(http.ResponseWriter, *http.Request, User)) ([]byte, *mcpProblem) {
	var body []byte
	if input != nil {
		body, _ = json.Marshal(input)
	}
	request, _ := http.NewRequestWithContext(ctx, method, s.config.APIOrigin+"/mcp", bytes.NewReader(body))
	if key != "" {
		request.SetPathValue(key, pathValue)
	}
	if token != "" {
		request = request.WithContext(context.WithValue(ctx, authenticatedAccessTokenKey{}, token))
	}
	result := &mcpResponse{header: make(http.Header)}
	handler(result, request, user)
	if result.status == 0 {
		result.status = 200
	}
	if result.status < 200 || result.status >= 300 {
		var failure struct {
			Error string `json:"error"`
		}
		json.Unmarshal(result.body.Bytes(), &failure)
		if failure.Error == "" {
			failure.Error = "service_unavailable"
		}
		return nil, &mcpProblem{result.status, failure.Error}
	}
	return result.body.Bytes(), nil
}

func (s *Server) mcpSetFavorite(ctx context.Context, user User, _ string, input mcpFavoriteInput) (mcpFavoriteOutput, *mcpProblem) {
	var handler = s.removeBookmark
	if input.Favorite {
		handler = s.addBookmark
	}
	if _, problem := s.mcpInvoke(ctx, user, http.MethodPut, "companyID", input.CompanyID, nil, "", handler); problem != nil {
		return mcpFavoriteOutput{}, problem
	}
	return mcpFavoriteOutput{CompanyID: input.CompanyID, Favorite: input.Favorite, URL: s.config.UIOrigin + "/?company=" + url.QueryEscape(input.CompanyID)}, nil
}
func (s *Server) mcpGetHome(ctx context.Context, user User, token string) (mcpHomeOutput, *mcpProblem) {
	delegated, problem := s.exchangeMCP(ctx, token, false)
	if problem != nil {
		return mcpHomeOutput{}, problem
	}
	payload, problem := s.mcpInvoke(ctx, user, http.MethodGet, "", "", nil, delegated, s.home)
	if problem != nil {
		return mcpHomeOutput{}, problem
	}
	var output mcpHomeOutput
	if problem := mcpDecode(payload, &output); problem != nil {
		return output, problem
	}
	return output, nil
}
func (s *Server) mcpSetHome(ctx context.Context, user User, token string, input mcpHomeInput) (mcpHomeUpdate, *mcpProblem) {
	delegated, problem := s.exchangeMCP(ctx, token, true)
	if problem != nil {
		return mcpHomeUpdate{}, problem
	}
	payload, problem := s.mcpInvoke(ctx, user, http.MethodPut, "key", input.TaskID, struct {
		Completed bool `json:"completed"`
	}{input.Completed}, delegated, s.setHomeTask)
	if problem != nil {
		return mcpHomeUpdate{}, problem
	}
	var output mcpHomeUpdate
	if problem := mcpDecode(payload, &output); problem != nil {
		return output, problem
	}
	return output, nil
}
