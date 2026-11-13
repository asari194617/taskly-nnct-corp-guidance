// Command import-guidance atomically imports a private dataset into MySQL.
// Source documents remain in DATA_DIR and are never built into the binary.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	guidancedata "github.com/asari194617/taskly-nnct-corp-guidance/internal/guidance"

	_ "github.com/go-sql-driver/mysql"
)

type document struct {
	ID       string `json:"id"`
	FileName string `json:"file_name"`
	MIMEType string `json:"mime_type"`
	Title    string `json:"title"`
}

type dataset struct {
	Event struct {
		Title       string                             `json:"title"`
		Date        string                             `json:"date"`
		Venue       string                             `json:"venue"`
		TaskActions map[string]guidancedata.TaskAction `json:"task_actions,omitempty"`
	} `json:"event"`
	Companies []struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Session string `json:"session"`
		Booth   int    `json:"booth"`
	} `json:"companies"`
	Schedule []struct {
		Term *int `json:"term"`
	} `json:"schedule"`
	Assignments []struct {
		Department string `json:"department"`
		Grade      int    `json:"grade"`
		Number     int    `json:"number"`
		Visits     []struct {
			Term      int    `json:"term"`
			CompanyID string `json:"company_id"`
		} `json:"visits"`
	} `json:"assignments"`
	Documents []document `json:"documents"`
}

var identifier = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func validateDataset(payload []byte, directory string) (*dataset, error) {
	var data dataset
	decoder := json.NewDecoder(strings.NewReader(string(payload)))
	if err := decoder.Decode(&data); err != nil {
		return nil, errors.New("invalid dataset JSON")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, errors.New("dataset must contain exactly one JSON object")
	}
	if data.Event.Title == "" || data.Event.Venue == "" {
		return nil, errors.New("event title and venue required")
	}
	if _, err := time.Parse("2006-01-02", data.Event.Date); err != nil {
		return nil, errors.New("event date must be YYYY-MM-DD")
	}
	companies := map[string]bool{}
	booths := map[string]bool{}
	for _, company := range data.Companies {
		boothKey := fmt.Sprintf("%s-%d", company.Session, company.Booth)
		if company.ID != boothKey || company.Name == "" || companies[company.ID] || booths[boothKey] || company.Booth < 1 || (company.Session != "AM" && company.Session != "PM") {
			return nil, errors.New("invalid or duplicate company")
		}
		companies[company.ID] = true
		booths[boothKey] = true
	}
	if len(companies) == 0 || len(data.Documents) == 0 {
		return nil, errors.New("companies and documents required")
	}
	terms := map[int]bool{}
	for _, slot := range data.Schedule {
		if slot.Term == nil {
			continue
		}
		if *slot.Term < 1 || *slot.Term > 8 || terms[*slot.Term] {
			return nil, errors.New("invalid or duplicate schedule term")
		}
		terms[*slot.Term] = true
	}
	if len(terms) != 8 {
		return nil, errors.New("eight schedule terms required")
	}
	students := map[string]bool{}
	for _, student := range data.Assignments {
		key := fmt.Sprintf("%s/%d/%d", student.Department, student.Grade, student.Number)
		if students[key] || student.Department == "" || (student.Grade != 3 && student.Grade != 4) || student.Number < 1 || len(student.Visits) != 4 {
			return nil, errors.New("invalid or duplicate student assignment")
		}
		students[key] = true
		visitedTerms := map[int]bool{}
		for _, visit := range student.Visits {
			expectedSession := "AM-"
			if visit.Term > 4 {
				expectedSession = "PM-"
			}
			if !companies[visit.CompanyID] || !terms[visit.Term] || visitedTerms[visit.Term] || !strings.HasPrefix(visit.CompanyID, expectedSession) {
				return nil, errors.New("invalid assignment reference")
			}
			visitedTerms[visit.Term] = true
		}
	}
	documentIDs := map[string]bool{}
	documentMIMEs := map[string]string{}
	for _, doc := range data.Documents {
		if !identifier.MatchString(doc.ID) || documentIDs[doc.ID] || doc.Title == "" || len(doc.Title) > 255 || doc.FileName == "" || len(doc.FileName) > 255 || filepath.Base(doc.FileName) != doc.FileName || strings.ContainsAny(doc.FileName, `/\\`) || doc.FileName == "." || doc.FileName == ".." {
			return nil, errors.New("invalid or duplicate document")
		}
		documentIDs[doc.ID] = true
		documentMIMEs[doc.ID] = doc.MIMEType
		if doc.MIMEType != "application/pdf" && doc.MIMEType != "image/png" {
			return nil, errors.New("unsupported document type")
		}
		info, err := os.Lstat(filepath.Join(directory, doc.FileName))
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return nil, errors.New("document missing, empty, or not a regular file")
		}
	}
	if err := guidancedata.ValidateTaskActions(data.Event.TaskActions, documentMIMEs); err != nil {
		return nil, err
	}
	return &data, nil
}

func run(args []string, openDB func(string) (*sql.DB, error)) error {
	flags := flag.NewFlagSet("import-guidance", flag.ContinueOnError)
	source := flags.String("input", "", "private guidance.json file")
	check := flags.Bool("check", false, "validate data and documents without contacting MySQL")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *source == "" {
		return errors.New("-input required")
	}
	payload, err := os.ReadFile(*source)
	if err != nil {
		return errors.New("cannot read input file")
	}
	if len(payload) > 20<<20 {
		return errors.New("dataset exceeds 20 MiB")
	}
	data, err := validateDataset(payload, filepath.Dir(*source))
	if err != nil {
		return err
	}
	if *check {
		fmt.Printf("Validated: %d companies, %d assignments, %d documents\n", len(data.Companies), len(data.Assignments), len(data.Documents))
		return nil
	}
	dsn := os.Getenv("MYSQL_DSN")
	if dsn == "" {
		return errors.New("MYSQL_DSN required")
	}
	db, err := openDB(dsn)
	if err != nil {
		return errors.New("cannot configure MySQL")
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return importDataset(ctx, db, payload, data)
}

func importDataset(ctx context.Context, db *sql.DB, payload []byte, data *dataset) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return errors.New("cannot start import transaction")
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO guidance_dataset (id,payload) VALUES (1,?) ON DUPLICATE KEY UPDATE payload=VALUES(payload)`, string(payload)); err != nil {
		return errors.New("cannot write guidance dataset")
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM guidance_documents`); err != nil {
		return errors.New("cannot replace document metadata")
	}
	for _, doc := range data.Documents {
		if _, err := tx.ExecContext(ctx, `INSERT INTO guidance_documents (id,file_name,mime_type,title) VALUES (?,?,?,?)`, doc.ID, doc.FileName, doc.MIMEType, doc.Title); err != nil {
			return errors.New("cannot write document metadata")
		}
	}
	if err := tx.Commit(); err != nil {
		return errors.New("cannot commit import")
	}
	fmt.Printf("Imported: %d companies, %d assignments, %d documents\n", len(data.Companies), len(data.Assignments), len(data.Documents))
	return nil
}

func main() {
	if err := run(os.Args[1:], func(dsn string) (*sql.DB, error) { return sql.Open("mysql", dsn) }); err != nil {
		log.Fatal(err)
	}
}
