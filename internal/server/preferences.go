package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// Ec4 is the initial cohort explicitly selected for this service. The imported
// guide remains the authority for whether a roster number has an assignment.
const defaultDepartment = "電子制御工学科"
const defaultGrade = 4

type PreferencesStore interface {
	Preference(context.Context, string) (*int, error)
	SetPreference(context.Context, string, int) error
}

func (s SQLStore) Preference(ctx context.Context, sub string) (*int, error) {
	var number int
	err := s.DB.QueryRowContext(ctx, `SELECT roster_number FROM guidance_preferences WHERE user_sub=?`, sub).Scan(&number)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &number, nil
}

func (s SQLStore) SetPreference(ctx context.Context, sub string, number int) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO guidance_preferences (user_sub,roster_number) VALUES (?,?) ON DUPLICATE KEY UPDATE roster_number=VALUES(roster_number)`, sub, number)
	return err
}

func preferenceResponse(number *int) map[string]any {
	return map[string]any{"roster_number": number, "department": defaultDepartment, "grade": defaultGrade}
}

func (s *Server) preferences(w http.ResponseWriter, r *http.Request, user User) {
	store, ok := s.store.(PreferencesStore)
	if !ok {
		failure(w, 503, "preferences_unavailable")
		return
	}
	number, err := store.Preference(r.Context(), user.Sub)
	if err != nil {
		failure(w, 503, "preferences_unavailable")
		return
	}
	respond(w, 200, preferenceResponse(number))
}

func (s *Server) setPreferences(w http.ResponseWriter, r *http.Request, user User) {
	var input struct {
		RosterNumber int `json:"roster_number"`
	}
	reader := http.MaxBytesReader(w, r.Body, 1024)
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || decoder.Decode(new(any)) != io.EOF {
		failure(w, 400, "invalid_preferences")
		return
	}
	if input.RosterNumber < 1 || input.RosterNumber > 99 {
		failure(w, 422, "invalid_roster_number")
		return
	}
	payload, err := s.store.Dataset(r.Context())
	if err != nil {
		failure(w, 503, "dataset_unavailable")
		return
	}
	var data struct {
		Assignments []struct {
			Department string `json:"department"`
			Grade      int    `json:"grade"`
			Number     int    `json:"number"`
		} `json:"assignments"`
	}
	if json.Unmarshal(payload, &data) != nil {
		failure(w, 503, "dataset_unavailable")
		return
	}
	found := false
	for _, assignment := range data.Assignments {
		if assignment.Department == defaultDepartment && assignment.Grade == defaultGrade && assignment.Number == input.RosterNumber {
			found = true
			break
		}
	}
	if !found {
		failure(w, 422, "roster_assignment_not_found")
		return
	}
	store, ok := s.store.(PreferencesStore)
	if !ok {
		failure(w, 503, "preferences_unavailable")
		return
	}
	if err := store.SetPreference(r.Context(), user.Sub, input.RosterNumber); err != nil {
		failure(w, 503, "preferences_unavailable")
		return
	}
	respond(w, 200, preferenceResponse(&input.RosterNumber))
}
