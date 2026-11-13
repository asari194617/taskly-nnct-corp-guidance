package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
	guidancedata "github.com/asari194617/taskly-nnct-corp-guidance/internal/guidance"
)

func fixture(t *testing.T) ([]byte, string) {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "fixture.pdf"), []byte("%PDF-1.7 synthetic fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	payload := []byte(`{
		"event":{"title":"Example event","date":"2030-01-02","venue":"Example venue"},
		"companies":[{"id":"AM-1","name":"Example A","session":"AM","booth":1},{"id":"PM-1","name":"Example B","session":"PM","booth":1}],
		"schedule":[{"term":1},{"term":2},{"term":3},{"term":4},{"term":5},{"term":6},{"term":7},{"term":8}],
		"assignments":[{"department":"Example department","grade":3,"number":1,"visits":[{"term":1,"company_id":"AM-1"},{"term":3,"company_id":"AM-1"},{"term":5,"company_id":"PM-1"},{"term":6,"company_id":"PM-1"}]}],
		"documents":[{"id":"fixture","file_name":"fixture.pdf","mime_type":"application/pdf","title":"Example document"}]
	}`)
	return payload, directory
}

func TestValidateDataset(t *testing.T) {
	payload, directory := fixture(t)
	if _, err := validateDataset(payload, directory); err != nil {
		t.Fatal(err)
	}
	for _, payload := range [][]byte{[]byte("invalid"), append(append([]byte{}, payload...), []byte(" {}")...)} {
		if _, err := validateDataset(payload, directory); err == nil {
			t.Fatal("accepted malformed or multiple JSON objects")
		}
	}
	cases := map[string]func(*dataset){
		"missing event":             func(d *dataset) { d.Event.Title = "" },
		"invalid date":              func(d *dataset) { d.Event.Date = "tomorrow" },
		"company wrong ID":          func(d *dataset) { d.Companies[0].ID = "PM-1" },
		"company wrong session":     func(d *dataset) { d.Companies[0].Session = "EVENING" },
		"duplicate company":         func(d *dataset) { d.Companies = append(d.Companies, d.Companies[0]) },
		"no companies":              func(d *dataset) { d.Companies = nil },
		"no documents":              func(d *dataset) { d.Documents = nil },
		"missing schedule terms":    func(d *dataset) { d.Schedule = nil },
		"duplicate schedule terms":  func(d *dataset) { d.Schedule[0].Term = d.Schedule[1].Term },
		"out of range term":         func(d *dataset) { term := 9; d.Schedule[0].Term = &term },
		"duplicate student":         func(d *dataset) { d.Assignments = append(d.Assignments, d.Assignments[0]) },
		"invalid student grade":     func(d *dataset) { d.Assignments[0].Grade = 9 },
		"incomplete visits":         func(d *dataset) { d.Assignments[0].Visits = d.Assignments[0].Visits[:1] },
		"unknown company":           func(d *dataset) { d.Assignments[0].Visits[0].CompanyID = "AM-9" },
		"wrong session":             func(d *dataset) { d.Assignments[0].Visits[0].CompanyID = "PM-1" },
		"duplicate visit term":      func(d *dataset) { d.Assignments[0].Visits[0].Term = 3 },
		"document traversal":        func(d *dataset) { d.Documents[0].FileName = "../fixture.pdf" },
		"document absolute path":    func(d *dataset) { d.Documents[0].FileName = "/tmp/fixture.pdf" },
		"document windows path":     func(d *dataset) { d.Documents[0].FileName = `..\fixture.pdf` },
		"document invalid id":       func(d *dataset) { d.Documents[0].ID = "../fixture" },
		"document unsupported type": func(d *dataset) { d.Documents[0].MIMEType = "text/html" },
		"document missing":          func(d *dataset) { d.Documents[0].FileName = "absent.pdf" },
		"duplicate document":        func(d *dataset) { d.Documents = append(d.Documents, d.Documents[0]) },
	}
	for name, modify := range cases {
		t.Run(name, func(t *testing.T) {
			var data dataset
			if err := json.Unmarshal(payload, &data); err != nil {
				t.Fatal(err)
			}
			modify(&data)
			modified, err := json.Marshal(data)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := validateDataset(modified, directory); err == nil {
				t.Fatal("accepted invalid dataset")
			}
		})
	}
}

func TestValidateDocumentRejectsSymlinkAndEmpty(t *testing.T) {
	for _, symlink := range []bool{false, true} {
		payload, directory := fixture(t)
		path := filepath.Join(directory, "fixture.pdf")
		if symlink {
			if err := os.Rename(path, filepath.Join(directory, "target.pdf")); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(directory, "target.pdf"), path); err != nil {
				t.Fatal(err)
			}
		} else if err := os.Truncate(path, 0); err != nil {
			t.Fatal(err)
		}
		if _, err := validateDataset(payload, directory); err == nil {
			t.Fatal("accepted symlink or empty document")
		}
	}
}

func TestImportValidatesTaskActionMetadataWithoutRequiringIt(t *testing.T) {
	payload, directory := fixture(t)
	var data dataset
	if json.Unmarshal(payload, &data) != nil {
		t.Fatal("invalid synthetic fixture")
	}
	data.Event.TaskActions = map[string]guidancedata.TaskAction{
		"visit_survey":     {URL: "https://forms.example.test/visit", DueAt: "2030-01-02T23:59:59+09:00"},
		"overall_survey":   {URL: "https://forms.example.test/overall"},
		"sheet_submission": {DocumentID: "fixture", Page: 2},
	}
	encoded, _ := json.Marshal(data)
	if _, err := validateDataset(encoded, directory); err != nil {
		t.Fatal(err)
	}
	for _, action := range []guidancedata.TaskAction{{URL: "javascript:alert(1)"}, {URL: "https://forms.example.test", DueAt: "tomorrow"}, {DocumentID: "missing", Page: 1}, {DocumentID: "fixture", Page: 0}} {
		kind := "visit_survey"
		if action.DocumentID != "" {
			kind = "sheet_submission"
		}
		current := data.Event.TaskActions[kind]
		data.Event.TaskActions[kind] = action
		encoded, _ = json.Marshal(data)
		if _, err := validateDataset(encoded, directory); err == nil {
			t.Fatal("invalid task action was imported")
		}
		data.Event.TaskActions[kind] = current
	}
	delete(data.Event.TaskActions, "overall_survey")
	encoded, _ = json.Marshal(data)
	if _, err := validateDataset(encoded, directory); err != nil {
		t.Fatal("partially extracted actions blocked the whole catalog")
	}
}

func TestImportTransaction(t *testing.T) {
	for _, failAt := range []string{"begin", "dataset", "delete", "document", "commit", ""} {
		t.Run(failAt, func(t *testing.T) {
			payload, directory := fixture(t)
			data, err := validateDataset(payload, directory)
			if err != nil {
				t.Fatal(err)
			}
			db, mock, err := sqlmock.New()
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			failure := errors.New("synthetic database error")
			begin := mock.ExpectBegin()
			if failAt == "begin" {
				begin.WillReturnError(failure)
			} else {
				insert := mock.ExpectExec("INSERT INTO guidance_dataset").WithArgs(string(payload))
				if failAt == "dataset" {
					insert.WillReturnError(failure)
				} else {
					insert.WillReturnResult(sqlmock.NewResult(1, 1))
					remove := mock.ExpectExec("DELETE FROM guidance_documents")
					if failAt == "delete" {
						remove.WillReturnError(failure)
					} else {
						remove.WillReturnResult(sqlmock.NewResult(0, 1))
						doc := mock.ExpectExec("INSERT INTO guidance_documents").WithArgs("fixture", "fixture.pdf", "application/pdf", "Example document")
						if failAt == "document" {
							doc.WillReturnError(failure)
						} else {
							doc.WillReturnResult(sqlmock.NewResult(1, 1))
							commit := mock.ExpectCommit()
							if failAt == "commit" {
								commit.WillReturnError(failure)
							}
						}
					}
				}
				if failAt != "" && failAt != "commit" {
					mock.ExpectRollback()
				}
			}
			err = importDataset(context.Background(), db, payload, data)
			if (err != nil) != (failAt != "") {
				t.Fatalf("unexpected error: %v", err)
			}
			if err := mock.ExpectationsWereMet(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRunValidationAndConfiguration(t *testing.T) {
	payload, directory := fixture(t)
	source := filepath.Join(directory, "guidance.json")
	if err := os.WriteFile(source, payload, 0600); err != nil {
		t.Fatal(err)
	}
	noOpen := func(string) (*sql.DB, error) { t.Fatal("unexpected database connection"); return nil, nil }
	if err := run([]string{"-input", source, "-check"}, noOpen); err != nil {
		t.Fatal(err)
	}
	t.Setenv("MYSQL_DSN", "")
	for _, args := range [][]string{nil, {"-unknown"}, {"-input", source}, {"-input", filepath.Join(directory, "absent.json")}} {
		if err := run(args, noOpen); err == nil {
			t.Fatal("expected input or configuration error")
		}
	}
	t.Setenv("MYSQL_DSN", "synthetic")
	if err := run([]string{"-input", source}, func(string) (*sql.DB, error) { return nil, errors.New("do not leak credentials") }); err == nil || strings.Contains(err.Error(), "credentials") {
		t.Fatal("expected redacted database configuration error")
	}
	if err := os.WriteFile(source, []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"-input", source}, noOpen); err == nil {
		t.Fatal("expected invalid JSON error")
	}
	if err := os.Truncate(source, (20<<20)+1); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"-input", source}, noOpen); err == nil {
		t.Fatal("expected oversize error")
	}
	if err := os.WriteFile(source, payload, 0600); err != nil {
		t.Fatal(err)
	}
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	mock.ExpectBegin().WillReturnError(errors.New("synthetic begin failure"))
	mock.ExpectClose()
	if err := run([]string{"-input", source}, func(string) (*sql.DB, error) { return db, nil }); err == nil {
		t.Fatal("expected transaction error")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
