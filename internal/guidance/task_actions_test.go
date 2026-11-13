package guidance

import "testing"

func TestTaskActionsValidateSuppliedPrivateMetadata(t *testing.T) {
	valid := map[string]TaskAction{
		"visit_survey":     {URL: "https://forms.example.test/visit", DueAt: "2030-01-02T23:59:59+09:00"},
		"overall_survey":   {URL: "https://forms.example.test/overall"},
		"sheet_submission": {DocumentID: "guide", Page: 3},
	}
	documents := map[string]string{"guide": "application/pdf", "map": "image/png"}
	if err := ValidateTaskActions(valid, documents); err != nil {
		t.Fatal(err)
	}
	if err := ValidateTaskActions(nil, nil); err != nil {
		t.Fatal("legacy metadata should remain importable")
	}
	if err := ValidateTaskActions(map[string]TaskAction{"visit_survey": valid["visit_survey"]}, nil); err != nil {
		t.Fatal("partial extraction should not hide the complete company catalog")
	}
	for _, kind := range []string{"visit_survey", "overall_survey", "sheet_submission"} {
		for _, invalid := range []TaskAction{{URL: "javascript:alert(1)"}, {URL: "http://remote.example.test"}, {URL: "https://user:pass@example.test"}, {URL: "https://%"}, {URL: "https://forms.example.test", DueAt: "tomorrow"}, {DocumentID: "../guide", Page: 1}, {DocumentID: "map", Page: 1}, {DocumentID: "guide", Page: 0}, {DocumentID: "guide", Page: 10001}} {
			if err := ValidateTaskActions(map[string]TaskAction{kind: invalid}, documents); err == nil {
				t.Fatalf("invalid %s action accepted", kind)
			}
		}
	}
	if err := ValidateTaskActions(map[string]TaskAction{"unknown": {}}, documents); err == nil {
		t.Fatal("unknown action silently accepted")
	}
}
