package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type mcpBlockingDataset struct {
	*fakeStore
	started chan context.Context
	stopped chan error
}

func (store *mcpBlockingDataset) Dataset(ctx context.Context) (json.RawMessage, error) {
	store.started <- ctx
	<-ctx.Done()
	store.stopped <- ctx.Err()
	return nil, ctx.Err()
}

func TestMCPSDKPropagatesHTTPRequestLifetimeToTools(t *testing.T) {
	for _, version := range []string{"2025-11-25", "2026-07-28"} {
		for _, cancellation := range []string{"deadline", "disconnect"} {
			t.Run(version+"/"+cancellation, func(t *testing.T) {
				s, fake, _ := mcpAuthTestServer(t)
				store := &mcpBlockingDataset{fakeStore: fake, started: make(chan context.Context, 1), stopped: make(chan error, 1)}
				s.store = store
				handler := s.Handler()
				var original context.Context
				var cancel context.CancelFunc
				if cancellation == "deadline" {
					original, cancel = context.WithTimeout(context.Background(), 500*time.Millisecond)
				} else {
					original, cancel = context.WithCancel(context.Background())
				}
				params := map[string]any{"name": "search_companies", "arguments": map[string]any{}}
				if version == "2026-07-28" {
					params["_meta"] = map[string]any{
						"io.modelcontextprotocol/protocolVersion":    version,
						"io.modelcontextprotocol/clientInfo":         map[string]any{"name": "synthetic-context-test", "version": "1"},
						"io.modelcontextprotocol/clientCapabilities": map[string]any{},
					}
				}
				body, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": params})
				if err != nil {
					cancel()
					t.Fatal(err)
				}
				req := httptest.NewRequest(http.MethodPost, s.mcpResource(), strings.NewReader(string(body))).WithContext(original)
				req.Header.Set("Authorization", "Bearer synthetic-parent")
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Accept", "application/json, text/event-stream")
				req.Header.Set("MCP-Protocol-Version", version)
				if version == "2026-07-28" {
					req.Header.Set("Mcp-Method", "tools/call")
					req.Header.Set("Mcp-Name", "search_companies")
				}
				w := httptest.NewRecorder()
				finished := make(chan struct{})
				t.Cleanup(func() {
					cancel()
					select {
					case <-finished:
					case <-time.After(3 * time.Second):
						t.Error("MCP HTTP handler remained running after cancellation")
					}
				})
				go func() {
					defer close(finished)
					handler.ServeHTTP(w, req)
				}()
				var toolContext context.Context
				select {
				case toolContext = <-store.started:
				case <-finished:
					t.Fatalf("tool never reached dataset: HTTP%d %s", w.Code, w.Body.String())
				case <-time.After(2 * time.Second):
					t.Fatal("tool did not start within bounded test time")
				}
				toolDeadline, ok := toolContext.Deadline()
				if !ok || toolDeadline.After(time.Now().Add(mcpRequestTimeout)) {
					t.Fatal("tool context lost the server deadline")
				}
				if incomingDeadline, ok := original.Deadline(); ok && toolDeadline.After(incomingDeadline) {
					t.Fatal("tool outlived the incoming HTTP deadline")
				}
				if cancellation == "disconnect" {
					cancel()
				}
				select {
				case err := <-store.stopped:
					if err == nil {
						t.Fatal("dataset operation completed without cancellation")
					}
				case <-time.After(2 * time.Second):
					t.Fatal("dataset ignored the HTTP request lifetime")
				}
				select {
				case <-finished:
				case <-time.After(2 * time.Second):
					t.Fatal("HTTP request did not finish after its tool stopped")
				}
			})
		}
	}
}

func TestMCPToolContextRestoresDetachedCancellationAndBoundsFallback(t *testing.T) {
	original, cancelOriginal := context.WithTimeout(context.Background(), time.Second)
	defer cancelOriginal()
	// Model the SDK's legacy-protocol detachment while preserving HTTP values.
	detached := context.WithoutCancel(context.WithValue(original, mcpRequestContextKey{}, original))
	tool, cancelTool := mcpToolContext(detached)
	defer cancelTool()
	want, _ := original.Deadline()
	if got, ok := tool.Deadline(); !ok || got.After(want) {
		t.Fatal("detached tool lost its original HTTP deadline")
	}
	cancelOriginal()
	select {
	case <-tool.Done():
	case <-time.After(time.Second):
		t.Fatal("detached tool ignored original HTTP cancellation")
	}
	before := time.Now()
	fallback, cancelFallback := mcpToolContext(context.Background())
	defer cancelFallback()
	if deadline, ok := fallback.Deadline(); !ok || deadline.Before(before.Add(mcpRequestTimeout)) || deadline.After(time.Now().Add(mcpRequestTimeout)) {
		t.Fatal("tool without HTTP context did not receive a bounded fallback deadline")
	}
	cancelFallback()
	if fallback.Err() == nil {
		t.Fatal("fallback cancel function did not cancel the tool")
	}
	// An already-canceled HTTP request cannot start detached tool work.
	tool, cancelTool = mcpToolContext(detached)
	defer cancelTool()
	if tool.Err() == nil {
		t.Fatal("already-canceled HTTP request produced a live detached tool")
	}
}

func TestMCPSDKCanceledOriginalContextCannotInvokeToolHandler(t *testing.T) {
	s, _, _ := mcpAuthTestServer(t)
	server := mcp.NewServer(&mcp.Implementation{Name: "synthetic-context-guard", Version: "1"}, nil)
	called := false
	addMCPTool(s, server, "get_profile", "Profile", "Synthetic context guard", mcpReadScope, false, mcpObject(map[string]any{}), func(context.Context, User, string, mcpEmptyInput) (mcpProfileOutput, *mcpProblem) {
		called = true
		return mcpProfileOutput{ID: "123"}, nil
	})
	transport := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true, PropagateRequestCancellation: true})
	handler := auth.RequireBearerToken(func(context.Context, string, *http.Request) (*auth.TokenInfo, error) {
		return &auth.TokenInfo{UserID: "123", Scopes: []string{mcpReadScope}, Expiration: time.Now().Add(time.Minute)}, nil
	}, nil)(transport)
	original, cancel := context.WithCancel(context.Background())
	cancel()
	// The HTTP/SDK context remains usable to observe the result, while its
	// preserved originating request lifetime has already ended before dispatch.
	ctx := context.WithValue(context.Background(), mcpRequestContextKey{}, original)
	req := httptest.NewRequest(http.MethodPost, s.mcpResource(), strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_profile","arguments":{}}}`)).WithContext(ctx)
	req.Header.Set("Authorization", "Bearer synthetic-parent")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("MCP-Protocol-Version", "2025-11-25")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	var response struct {
		Result struct {
			IsError    bool            `json:"isError"`
			Structured json.RawMessage `json:"structuredContent"`
		} `json:"result"`
	}
	if called || w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || !response.Result.IsError || len(response.Result.Structured) != 0 {
		t.Fatalf("already-canceled request: called=%t HTTP%d response=%s", called, w.Code, w.Body.String())
	}
}
