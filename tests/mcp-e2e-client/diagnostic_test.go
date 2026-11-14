package main

import (
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestToolFailureDiagnosticsNeverExposeArbitraryResponseData(t *testing.T) {
	for _, test := range []struct {
		name   string
		result *mcp.CallToolResult
		want   string
	}{
		{"known application code", &mcp.CallToolResult{Meta: mcp.Meta{"status": float64(503)}, Content: []mcp.Content{&mcp.TextContent{Text: "taskly_unavailable"}}}, "status=503 code=taskly_unavailable"},
		{"integer status", &mcp.CallToolResult{Meta: mcp.Meta{"status": 401}, Content: []mcp.Content{&mcp.TextContent{Text: "authentication_required"}}}, "status=401 code=authentication_required"},
		{"arbitrary content and metadata", &mcp.CallToolResult{Meta: mcp.Meta{"status": "Bearer synthetic-secret", "token": "synthetic-secret"}, Content: []mcp.Content{&mcp.TextContent{Text: "postgres://private-user:synthetic-secret@host/db"}}}, "status=unknown code=unrecognized"},
		{"invalid numeric status", &mcp.CallToolResult{Meta: mcp.Meta{"status": 503.5}, Content: []mcp.Content{&mcp.TextContent{Text: "unexpected arbitrary payload"}}}, "status=unknown code=unrecognized"},
		{"out of range status", &mcp.CallToolResult{Meta: mcp.Meta{"status": 1000}}, "status=unknown code=unrecognized"},
		{"missing result", nil, "status=unknown code=unrecognized"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := safeToolFailure(test.result); got != test.want {
				t.Fatalf("diagnostic=%q want=%q", got, test.want)
			}
		})
	}
}
