package server

import (
	"context"
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
	"unicode/utf8"
)

type mcpSearchInput struct {
	Query         string   `json:"query,omitempty"`
	Session       string   `json:"session,omitempty"`
	Industries    []string `json:"industries,omitempty"`
	FavoritesOnly bool     `json:"favorites_only,omitempty"`
	Limit         int      `json:"limit,omitempty"`
	Offset        int      `json:"offset,omitempty"`
}

type mcpCompanyInput struct {
	CompanyID string `json:"company_id"`
}

type mcpCatalogCompany struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	Session    string   `json:"session"`
	Booth      int      `json:"booth"`
	Industries []string `json:"industries"`
	SourcePage int      `json:"source_page"`
	URL        string   `json:"url"`
	MapURL     string   `json:"map_url"`
	Favorite   bool     `json:"favorite"`
}

type mcpSearchOutput struct {
	Companies  []mcpCatalogCompany `json:"companies"`
	Total      int                 `json:"total"`
	NextOffset *int                `json:"next_offset,omitempty"`
}

type mcpCompanyOutput struct {
	Company mcpCatalogCompany `json:"company"`
}

type mcpCatalogEvent struct {
	Title       string `json:"title"`
	Date        string `json:"date"`
	Venue       string `json:"venue"`
	Description string `json:"description"`
}

type mcpCatalogSlot struct {
	ID             string `json:"id"`
	Session        string `json:"session"`
	Title          string `json:"title"`
	Start          string `json:"start"`
	End            string `json:"end"`
	Term           *int   `json:"term,omitempty"`
	RequiredGrades []int  `json:"required_grades"`
}

// Reference assignments deliberately have no completion fields: only the
// canonical Taskly-backed home tool may describe a visit as completed.
type mcpAssignedVisit struct {
	TaskID    string `json:"task_id"`
	Title     string `json:"title"`
	CompanyID string `json:"company_id"`
	Term      int    `json:"term"`
	URL       string `json:"url"`
	MapURL    string `json:"map_url"`
}

type mcpMyGuidanceOutput struct {
	Event            mcpCatalogEvent    `json:"event"`
	Schedule         []mcpCatalogSlot   `json:"schedule"`
	RosterConfigured bool               `json:"roster_configured"`
	Visits           []mcpAssignedVisit `json:"visits"`
	URL              string             `json:"url"`
}

type mcpCatalogDocument struct {
	ID         string `json:"id"`
	Title      string `json:"title"`
	Kind       string `json:"kind"`
	MIMEType   string `json:"mime_type"`
	SourcePage int    `json:"source_page"`
	URL        string `json:"url"`
}

type mcpDocumentsOutput struct {
	Documents []mcpCatalogDocument `json:"documents"`
}

type mcpCatalogDataset struct {
	Event     mcpCatalogEvent      `json:"event"`
	Companies []mcpCatalogCompany  `json:"companies"`
	Schedule  []mcpCatalogSlot     `json:"schedule"`
	Documents []mcpCatalogDocument `json:"documents"`
}

func (s *Server) mcpLoadCatalog(ctx context.Context) (mcpCatalogDataset, *mcpProblem) {
	payload, err := s.store.Dataset(ctx)
	if err != nil || len(payload) > 8<<20 {
		return mcpCatalogDataset{}, &mcpProblem{503, "dataset_unavailable"}
	}
	var data mcpCatalogDataset
	if json.Unmarshal(payload, &data) != nil || strings.TrimSpace(data.Event.Title) == "" || utf8.RuneCountInString(data.Event.Title) > 500 || utf8.RuneCountInString(data.Event.Date) > 100 || utf8.RuneCountInString(data.Event.Venue) > 1000 || utf8.RuneCountInString(data.Event.Description) > 10000 || data.Companies == nil || len(data.Companies) > 5000 || len(data.Schedule) > 100 || len(data.Documents) > 100 {
		return mcpCatalogDataset{}, &mcpProblem{503, "dataset_unavailable"}
	}
	ids := map[string]bool{}
	for _, company := range data.Companies {
		if !documentIDPattern.MatchString(company.ID) || ids[company.ID] || strings.TrimSpace(company.Name) == "" || utf8.RuneCountInString(company.Name) > 500 || (company.Session != "AM" && company.Session != "PM") || company.Booth < 1 || company.Booth > 9999 || company.SourcePage < 0 || len(company.Industries) > 64 {
			return mcpCatalogDataset{}, &mcpProblem{503, "dataset_unavailable"}
		}
		for _, industry := range company.Industries {
			if !utf8.ValidString(industry) || utf8.RuneCountInString(industry) > 120 {
				return mcpCatalogDataset{}, &mcpProblem{503, "dataset_unavailable"}
			}
		}
		ids[company.ID] = true
	}
	for _, slot := range data.Schedule {
		if len(slot.ID) > 128 || len(slot.Session) > 128 || utf8.RuneCountInString(slot.Title) > 500 || len(slot.Start) > 128 || len(slot.End) > 128 || len(slot.RequiredGrades) > 16 || (slot.Term != nil && (*slot.Term < 1 || *slot.Term > 99)) {
			return mcpCatalogDataset{}, &mcpProblem{503, "dataset_unavailable"}
		}
		for _, grade := range slot.RequiredGrades {
			if grade < 1 || grade > 99 {
				return mcpCatalogDataset{}, &mcpProblem{503, "dataset_unavailable"}
			}
		}
	}
	return data, nil
}

func (s *Server) mcpCompanyLinks(company mcpCatalogCompany) mcpCatalogCompany {
	company.URL = s.config.UIOrigin + "/?company=" + url.QueryEscape(company.ID)
	company.MapURL = s.config.UIOrigin + "/map/?company=" + url.QueryEscape(company.ID) + "&focus=" + url.QueryEscape(company.ID) + "&session=" + company.Session
	if company.Industries == nil {
		company.Industries = []string{}
	}
	return company
}

func (s *Server) mcpFavorites(ctx context.Context, user User) (map[string]bool, *mcpProblem) {
	store, ok := s.store.(BookmarkStore)
	if !ok {
		return nil, &mcpProblem{503, "bookmarks_unavailable"}
	}
	ids, err := store.Bookmarks(ctx, user.Sub)
	if err != nil {
		return nil, &mcpProblem{503, "bookmarks_unavailable"}
	}
	favorites := make(map[string]bool, len(ids))
	for _, id := range ids {
		favorites[id] = true
	}
	return favorites, nil
}

func (s *Server) mcpSearch(ctx context.Context, user User, input mcpSearchInput) (mcpSearchOutput, *mcpProblem) {
	if input.Limit == 0 {
		input.Limit = 20
	}
	if input.Limit < 1 || input.Limit > 50 || input.Offset < 0 || input.Offset > 5000 || !utf8.ValidString(input.Query) || utf8.RuneCountInString(input.Query) > 120 || len(input.Industries) > 16 || (input.Session != "" && input.Session != "AM" && input.Session != "PM") {
		return mcpSearchOutput{}, &mcpProblem{400, "invalid_search"}
	}
	for _, industry := range input.Industries {
		if !utf8.ValidString(industry) || strings.TrimSpace(industry) == "" || utf8.RuneCountInString(industry) > 120 {
			return mcpSearchOutput{}, &mcpProblem{400, "invalid_search"}
		}
	}
	data, problem := s.mcpLoadCatalog(ctx)
	if problem != nil {
		return mcpSearchOutput{}, problem
	}
	favorites, problem := s.mcpFavorites(ctx, user)
	if problem != nil {
		return mcpSearchOutput{}, problem
	}
	result := mcpSearchOutput{Companies: []mcpCatalogCompany{}}
	query := strings.ToLower(strings.TrimSpace(input.Query))
	for _, company := range data.Companies {
		if input.Session != "" && company.Session != input.Session {
			continue
		}
		if input.FavoritesOnly && !favorites[company.ID] {
			continue
		}
		matchIndustry := len(input.Industries) == 0
		for _, wanted := range input.Industries {
			for _, industry := range company.Industries {
				if strings.EqualFold(strings.TrimSpace(wanted), industry) {
					matchIndustry = true
				}
			}
		}
		if !matchIndustry {
			continue
		}
		searchable := strings.ToLower(company.Name + " " + strings.Join(company.Industries, " ") + " " + strconv.Itoa(company.Booth))
		if query != "" && !strings.Contains(searchable, query) {
			continue
		}
		if result.Total >= input.Offset && len(result.Companies) < input.Limit {
			company = s.mcpCompanyLinks(company)
			company.Favorite = favorites[company.ID]
			result.Companies = append(result.Companies, company)
		}
		result.Total++
	}
	if next := input.Offset + len(result.Companies); next < result.Total {
		result.NextOffset = &next
	}
	return result, nil
}

func (s *Server) mcpCompany(ctx context.Context, user User, input mcpCompanyInput) (mcpCompanyOutput, *mcpProblem) {
	if !documentIDPattern.MatchString(input.CompanyID) {
		return mcpCompanyOutput{}, &mcpProblem{400, "invalid_company_id"}
	}
	data, problem := s.mcpLoadCatalog(ctx)
	if problem != nil {
		return mcpCompanyOutput{}, problem
	}
	favorites, problem := s.mcpFavorites(ctx, user)
	if problem != nil {
		return mcpCompanyOutput{}, problem
	}
	for _, company := range data.Companies {
		if company.ID == input.CompanyID {
			company = s.mcpCompanyLinks(company)
			company.Favorite = favorites[company.ID]
			return mcpCompanyOutput{Company: company}, nil
		}
	}
	return mcpCompanyOutput{}, &mcpProblem{404, "company_not_found"}
}

func (s *Server) mcpMyGuidance(ctx context.Context, user User) (mcpMyGuidanceOutput, *mcpProblem) {
	data, problem := s.mcpLoadCatalog(ctx)
	if problem != nil {
		return mcpMyGuidanceOutput{}, problem
	}
	definitions, configured, err := s.homeTaskDefinitions(ctx, user)
	if err != nil {
		return mcpMyGuidanceOutput{}, &mcpProblem{503, "home_tasks_unavailable"}
	}
	result := mcpMyGuidanceOutput{Event: data.Event, Schedule: data.Schedule, RosterConfigured: configured, Visits: []mcpAssignedVisit{}, URL: s.config.UIOrigin + "/schedule/"}
	if result.Schedule == nil {
		result.Schedule = []mcpCatalogSlot{}
	}
	for index := range result.Schedule {
		if result.Schedule[index].RequiredGrades == nil {
			result.Schedule[index].RequiredGrades = []int{}
		}
	}
	companies := make(map[string]mcpCatalogCompany, len(data.Companies))
	for _, company := range data.Companies {
		companies[company.ID] = s.mcpCompanyLinks(company)
	}
	for _, definition := range definitions {
		if definition.Kind == "assigned_visit" {
			company := companies[definition.CompanyID]
			result.Visits = append(result.Visits, mcpAssignedVisit{TaskID: definition.ID, Title: definition.Title, CompanyID: definition.CompanyID, Term: definition.Term, URL: company.URL, MapURL: company.MapURL})
		}
	}
	return result, nil
}

func (s *Server) mcpDocuments(ctx context.Context) (mcpDocumentsOutput, *mcpProblem) {
	data, problem := s.mcpLoadCatalog(ctx)
	if problem != nil {
		return mcpDocumentsOutput{}, problem
	}
	result := mcpDocumentsOutput{Documents: []mcpCatalogDocument{}}
	seen := map[string]bool{}
	for _, document := range data.Documents {
		if !documentIDPattern.MatchString(document.ID) || seen[document.ID] || !allowedDocumentMIME(document.MIMEType) || document.SourcePage < 0 || utf8.RuneCountInString(document.Title) > 500 || len(document.Kind) > 128 {
			return mcpDocumentsOutput{}, &mcpProblem{503, "dataset_unavailable"}
		}
		seen[document.ID] = true
		document.URL = s.config.UIOrigin + "/documents/"
		result.Documents = append(result.Documents, document)
	}
	return result, nil
}
