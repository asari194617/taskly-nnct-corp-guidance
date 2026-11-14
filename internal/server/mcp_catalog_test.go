package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

const mcpCatalogFixtureJSON = `{
 "event":{"title":"Synthetic guidance","date":"2030-05-14","venue":"Synthetic venue","description":"Synthetic reference data"},
 "companies":[
  {"id":"AM-1","name":"Alpha Robotics","session":"AM","booth":1,"industries":["Engineering"],"source_page":1,"url":"https://private.example.test/secret","favorite":true},
  {"id":"AM-2","name":"Beta Cloud","session":"AM","booth":2,"industries":["ICT"],"source_page":2},
  {"id":"PM-1","name":"Gamma Steel","session":"PM","booth":1,"industries":["Manufacturing"],"source_page":3},
  {"id":"PM-2","name":"Delta Infra","session":"PM","booth":2,"industries":["Engineering","Construction"],"source_page":4}],
 "schedule":[{"id":"term-one","session":"AM","title":"Synthetic AM","start":"2030-05-14T09:00:00+09:00","end":"2030-05-14T09:10:00+09:00","term":1,"required_grades":[4]},{"id":"term-two","session":"PM","title":"Synthetic PM","start":"2030-05-14T13:00:00+09:00","end":"2030-05-14T13:10:00+09:00","term":2}],
 "documents":[{"id":"guide","title":"Guide","kind":"guide","mime_type":"application/pdf","source_page":1,"file_name":"private-source.pdf","url":"https://private.example.test/signed?token=secret"},{"id":"arena","title":"Map","kind":"map","mime_type":"image/png","source_page":2}],
 "assignments":[{"department":"電子制御工学科","grade":4,"number":7,"visits":[{"term":1,"company_id":"AM-1"}]},{"department":"電子制御工学科","grade":4,"number":8,"visits":[{"term":2,"company_id":"PM-1"}]}]
}`

func catalogFixture(t *testing.T) (*Server, *fakeStore) {
	t.Helper()
	s, f := testServer(t)
	var data map[string]any
	if err := json.Unmarshal([]byte(mcpCatalogFixtureJSON), &data); err != nil {
		t.Fatal(err)
	}
	data["event"].(map[string]any)["task_actions"] = map[string]any{"visit_survey": map[string]any{"url": "https://forms.example.test/visit"}, "overall_survey": map[string]any{"url": "https://forms.example.test/overall"}, "sheet_submission": map[string]any{"document_id": "guide", "page": 3}}
	f.dataset, _ = json.Marshal(data)
	f.preferences["alice"] = 7
	f.preferences["bob"] = 8
	if err := f.AddBookmark(context.Background(), "alice", "AM-2"); err != nil {
		t.Fatal(err)
	}
	return s, f
}

func TestMCPCatalogSearchBoundsFiltersAndAccountFavorites(t *testing.T) {
	s, f := catalogFixture(t)
	ctx := context.Background()
	result, problem := s.mcpSearch(ctx, User{Sub: "alice"}, mcpSearchInput{})
	if problem != nil || result.Total != 4 || len(result.Companies) != 4 {
		t.Fatalf("search=%+v problem=%v", result, problem)
	}
	if result.Companies[0].Favorite || !result.Companies[1].Favorite {
		t.Fatal("dataset favorite state was trusted or own favorite lost")
	}
	if strings.Contains(result.Companies[0].URL, "private.example") || result.Companies[0].URL != s.config.UIOrigin+"/?company=AM-1" || !strings.Contains(result.Companies[0].MapURL, "session=AM") {
		t.Fatal("unsafe or broken deep link")
	}
	for _, test := range []struct {
		input mcpSearchInput
		want  int
	}{
		{mcpSearchInput{Query: "robotics"}, 1}, {mcpSearchInput{Query: "ICT"}, 1}, {mcpSearchInput{Query: "2"}, 2},
		{mcpSearchInput{Session: "PM"}, 2}, {mcpSearchInput{Industries: []string{"ICT", "Manufacturing"}}, 2},
		{mcpSearchInput{Industries: []string{"engineering"}}, 2}, {mcpSearchInput{FavoritesOnly: true}, 1},
		{mcpSearchInput{Session: "PM", FavoritesOnly: true}, 0}, {mcpSearchInput{Query: "unknown"}, 0},
	} {
		output, err := s.mcpSearch(ctx, User{Sub: "alice"}, test.input)
		if err != nil || output.Total != test.want || len(output.Companies) != test.want {
			t.Fatalf("filtered %+v ->%+v %v", test.input, output, err)
		}
	}
	other, problem := s.mcpSearch(ctx, User{Sub: "bob"}, mcpSearchInput{FavoritesOnly: true})
	if problem != nil || other.Total != 0 {
		t.Fatal("cross-account favorites exposed")
	}
	page, problem := s.mcpSearch(ctx, User{Sub: "alice"}, mcpSearchInput{Limit: 2})
	if problem != nil || page.NextOffset == nil || *page.NextOffset != 2 || len(page.Companies) != 2 {
		t.Fatal("pagination first page invalid")
	}
	last, problem := s.mcpSearch(ctx, User{Sub: "alice"}, mcpSearchInput{Offset: 2, Limit: 2})
	if problem != nil || last.NextOffset != nil || len(last.Companies) != 2 {
		t.Fatal("pagination last page invalid")
	}
	empty, problem := s.mcpSearch(ctx, User{Sub: "alice"}, mcpSearchInput{Offset: 5})
	if problem != nil || empty.Total != 4 || len(empty.Companies) != 0 || empty.NextOffset != nil {
		t.Fatal("out-of-range page fabricated results")
	}
	for _, input := range []mcpSearchInput{{Limit: -1}, {Limit: 51}, {Offset: -1}, {Offset: 5001}, {Session: "ALL"}, {Query: strings.Repeat("あ", 121)}, {Query: string([]byte{255})}, {Industries: make([]string, 17)}, {Industries: []string{" "}}, {Industries: []string{strings.Repeat("あ", 121)}}, {Industries: []string{string([]byte{255})}}} {
		if _, problem := s.mcpSearch(ctx, User{Sub: "alice"}, input); problem == nil || problem.status != 400 {
			t.Fatalf("invalid search accepted: %+v", input)
		}
	}
	f.errorBookmark = errors.New("synthetic bookmark store unavailable")
	if _, problem := s.mcpSearch(ctx, User{Sub: "alice"}, mcpSearchInput{}); problem == nil || problem.status != 503 {
		t.Fatal("bookmark error silently became no favorites")
	}
}

func TestMCPCatalogCompanyLookupAndPrivateFields(t *testing.T) {
	s, f := catalogFixture(t)
	ctx := context.Background()
	found, problem := s.mcpCompany(ctx, User{Sub: "alice"}, mcpCompanyInput{CompanyID: "AM-2"})
	if problem != nil || !found.Company.Favorite || found.Company.Name != "Beta Cloud" {
		t.Fatal("company lookup failed")
	}
	encoded, _ := json.Marshal(found)
	for _, secret := range []string{"file_name", "assignments", "private.example", "secret"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("private field %s leaked", secret)
		}
	}
	if _, problem := s.mcpCompany(ctx, User{Sub: "alice"}, mcpCompanyInput{CompanyID: "../other"}); problem == nil || problem.status != 400 {
		t.Fatal("invalid ID accepted")
	}
	if _, problem := s.mcpCompany(ctx, User{Sub: "alice"}, mcpCompanyInput{CompanyID: "missing"}); problem == nil || problem.status != 404 {
		t.Fatal("unknown company not rejected")
	}
	f.errorBookmark = errors.New("offline")
	if _, problem := s.mcpCompany(ctx, User{Sub: "alice"}, mcpCompanyInput{CompanyID: "AM-1"}); problem == nil || problem.status != 503 {
		t.Fatal("lookup hid storage outage")
	}
	s.store = mcpStoreWithoutBookmarks{Store: f}
	if _, problem := s.mcpCompany(ctx, User{Sub: "alice"}, mcpCompanyInput{CompanyID: "AM-1"}); problem == nil || problem.status != 503 {
		t.Fatal("missing bookmark capability not rejected")
	}
}

type mcpStoreWithoutBookmarks struct{ Store }

func TestMCPCatalogPersonalAssignmentsHaveNoInventedCompletion(t *testing.T) {
	s, f := catalogFixture(t)
	ctx := context.Background()
	alice, problem := s.mcpMyGuidance(ctx, User{Sub: "alice"})
	if problem != nil || !alice.RosterConfigured || len(alice.Visits) != 1 || alice.Visits[0].CompanyID != "AM-1" {
		t.Fatalf("own assignment=%+v %v", alice, problem)
	}
	if len(alice.Schedule) != 2 || alice.Schedule[1].RequiredGrades == nil || alice.URL != s.config.UIOrigin+"/schedule/" {
		t.Fatal("schedule reference not normalized")
	}
	encoded, _ := json.Marshal(alice)
	for _, forbidden := range []string{"completed", "taskly_url", "assignmentScope", "assignment_scope", "\"company_id\":\"PM-1\"", "\"number\":8"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("reference output exposed %s", forbidden)
		}
	}
	bob, problem := s.mcpMyGuidance(ctx, User{Sub: "bob"})
	if problem != nil || len(bob.Visits) != 1 || bob.Visits[0].CompanyID != "PM-1" {
		t.Fatal("second account not independently scoped")
	}
	none, problem := s.mcpMyGuidance(ctx, User{Sub: "unconfigured"})
	if problem != nil || none.RosterConfigured || len(none.Visits) != 0 || none.Visits == nil {
		t.Fatal("unconfigured roster invented assignment")
	}
	f.errorPreference = errors.New("preference unavailable")
	if _, problem := s.mcpMyGuidance(ctx, User{Sub: "alice"}); problem == nil || problem.status != 503 {
		t.Fatal("preferences outage invented assignment")
	}
}

func TestMCPCatalogDocumentsUseOnlyStableApplicationLinks(t *testing.T) {
	s, f := catalogFixture(t)
	ctx := context.Background()
	result, problem := s.mcpDocuments(ctx)
	if problem != nil || len(result.Documents) != 2 {
		t.Fatalf("documents %+v %v", result, problem)
	}
	for _, document := range result.Documents {
		if document.URL != s.config.UIOrigin+"/documents/" {
			t.Fatal("document link not stable UI route")
		}
	}
	encoded, _ := json.Marshal(result)
	for _, forbidden := range []string{"file_name", "private-source.pdf", "private.example", "token="} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatal("signed URL or raw storage path exposed")
		}
	}
	for _, change := range []func(map[string]any){
		func(data map[string]any) { data["documents"].([]any)[0].(map[string]any)["id"] = "../secret" },
		func(data map[string]any) { data["documents"].([]any)[0].(map[string]any)["mime_type"] = "text/html" },
		func(data map[string]any) { data["documents"].([]any)[0].(map[string]any)["source_page"] = float64(-1) },
		func(data map[string]any) {
			data["documents"].([]any)[0].(map[string]any)["title"] = strings.Repeat("a", 501)
		},
		func(data map[string]any) {
			data["documents"].([]any)[0].(map[string]any)["kind"] = strings.Repeat("a", 129)
		},
		func(data map[string]any) { data["documents"].([]any)[1].(map[string]any)["id"] = "guide" },
	} {
		var data map[string]any
		json.Unmarshal([]byte(mcpCatalogFixtureJSON), &data)
		change(data)
		f.dataset, _ = json.Marshal(data)
		if _, problem := s.mcpDocuments(ctx); problem == nil || problem.status != 503 {
			t.Fatal("invalid document catalog accepted")
		}
	}
}

func TestMCPCatalogRejectsMalformedOrUnboundedRuntimeData(t *testing.T) {
	s, f := catalogFixture(t)
	ctx := context.Background()
	original := append([]byte(nil), f.dataset...)
	f.errorDataset = errors.New("SQL offline")
	if _, problem := s.mcpSearch(ctx, User{Sub: "alice"}, mcpSearchInput{}); problem == nil || problem.status != 503 {
		t.Fatal("SQL outage ignored")
	}
	f.errorDataset = nil
	for _, raw := range []string{"not-json", "null", "{}", strings.Repeat(" ", 8<<20+1)} {
		f.dataset = json.RawMessage(raw)
		if _, problem := s.mcpDocuments(ctx); problem == nil || problem.status != 503 {
			t.Fatal("invalid payload accepted")
		}
	}
	for _, change := range []func(map[string]any){
		func(data map[string]any) {
			company := data["companies"].([]any)[0]
			values := make([]any, 5001)
			for i := range values {
				values[i] = company
			}
			data["companies"] = values
		},
		func(data map[string]any) { data["schedule"] = make([]any, 101) }, func(data map[string]any) { data["documents"] = make([]any, 101) },
		func(data map[string]any) { data["event"].(map[string]any)["title"] = " " }, func(data map[string]any) { data["event"].(map[string]any)["description"] = strings.Repeat("x", 10001) },
		func(data map[string]any) { data["companies"].([]any)[0].(map[string]any)["id"] = "../private" }, func(data map[string]any) { data["companies"].([]any)[1].(map[string]any)["id"] = "AM-1" },
		func(data map[string]any) { data["companies"].([]any)[0].(map[string]any)["name"] = "" }, func(data map[string]any) {
			data["companies"].([]any)[0].(map[string]any)["name"] = strings.Repeat("x", 501)
		},
		func(data map[string]any) { data["companies"].([]any)[0].(map[string]any)["session"] = "UNKNOWN" }, func(data map[string]any) { data["companies"].([]any)[0].(map[string]any)["booth"] = float64(0) },
		func(data map[string]any) {
			data["companies"].([]any)[0].(map[string]any)["industries"] = make([]string, 65)
		}, func(data map[string]any) {
			data["companies"].([]any)[0].(map[string]any)["industries"] = []string{strings.Repeat("x", 121)}
		},
		func(data map[string]any) { data["schedule"].([]any)[0].(map[string]any)["term"] = float64(0) }, func(data map[string]any) { data["schedule"].([]any)[0].(map[string]any)["required_grades"] = []int{0} },
		func(data map[string]any) {
			data["schedule"].([]any)[0].(map[string]any)["title"] = strings.Repeat("x", 501)
		},
	} {
		var data map[string]any
		json.Unmarshal(original, &data)
		change(data)
		f.dataset, _ = json.Marshal(data)
		if _, problem := s.mcpSearch(ctx, User{Sub: "alice"}, mcpSearchInput{}); problem == nil || problem.status != 503 {
			t.Fatal("unbounded or malformed catalog accepted")
		}
	}
	f.dataset = original
	var data map[string]any
	json.Unmarshal(original, &data)
	data["companies"].([]any)[0].(map[string]any)["industries"] = nil
	f.dataset, _ = json.Marshal(data)
	result, problem := s.mcpSearch(ctx, User{Sub: "alice"}, mcpSearchInput{})
	if problem != nil || result.Companies[0].Industries == nil {
		t.Fatal("missing industry list not normalized")
	}
	if _, problem := s.mcpMyGuidance(ctx, User{Sub: "alice"}); problem != nil {
		t.Fatal(fmt.Sprint(problem))
	}
}
