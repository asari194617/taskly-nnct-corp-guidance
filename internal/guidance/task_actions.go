// Package guidance validates metadata extracted from a private source guide.
package guidance

import (
	"fmt"
	"net/url"
	"regexp"
	"time"
)

type TaskAction struct {
	URL        string `json:"url"`
	DueAt      string `json:"due_at"`
	DocumentID string `json:"document_id"`
	Page       int    `json:"page"`
}

var documentID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func IsHTTPSURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && parsed.Opaque == ""
}

// ValidateTaskActions validates each supplied action. Older or partially
// extracted datasets may omit actions; callers requiring a complete home task
// list separately check all required kinds before presenting any completion.
func ValidateTaskActions(actions map[string]TaskAction, documents map[string]string) error {
	for kind, action := range actions {
		if action.DueAt != "" {
			if _, err := time.Parse(time.RFC3339, action.DueAt); err != nil {
				return fmt.Errorf("task action has an invalid deadline")
			}
		}
		switch kind {
		case "visit_survey", "overall_survey":
			if !IsHTTPSURL(action.URL) {
				return fmt.Errorf("survey action requires an HTTPS URL")
			}
		case "sheet_submission":
			if !documentID.MatchString(action.DocumentID) || documents[action.DocumentID] != "application/pdf" || action.Page < 1 || action.Page > 10000 {
				return fmt.Errorf("sheet action requires an allowlisted PDF and positive page")
			}
		default:
			return fmt.Errorf("unsupported task action kind")
		}
	}
	return nil
}
