package server

import (
	"context"
	"encoding/json"
	"net/http"
)

type BookmarkStore interface {
	Bookmarks(context.Context, string) ([]string, error)
	AddBookmark(context.Context, string, string) error
	RemoveBookmark(context.Context, string, string) error
}

func (s SQLStore) Bookmarks(ctx context.Context, sub string) ([]string, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT company_id FROM guidance_bookmarks WHERE user_sub=? ORDER BY company_id`, sub)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
func (s SQLStore) AddBookmark(ctx context.Context, sub, id string) error {
	_, err := s.DB.ExecContext(ctx, `INSERT INTO guidance_bookmarks (user_sub,company_id) VALUES (?,?) ON DUPLICATE KEY UPDATE company_id=VALUES(company_id)`, sub, id)
	return err
}
func (s SQLStore) RemoveBookmark(ctx context.Context, sub, id string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM guidance_bookmarks WHERE user_sub=? AND company_id=?`, sub, id)
	return err
}
func (s *Server) bookmarks(w http.ResponseWriter, r *http.Request, user User) {
	store, ok := s.store.(BookmarkStore)
	if !ok {
		failure(w, 503, "bookmarks_unavailable")
		return
	}
	ids, err := store.Bookmarks(r.Context(), user.Sub)
	if err != nil {
		failure(w, 503, "bookmarks_unavailable")
		return
	}
	if ids == nil {
		ids = []string{}
	}
	respond(w, 200, map[string][]string{"company_ids": ids})
}
func (s *Server) companyExists(ctx context.Context, id string) (bool, error) {
	if !documentIDPattern.MatchString(id) {
		return false, nil
	}
	payload, err := s.store.Dataset(ctx)
	if err != nil {
		return false, err
	}
	var data struct {
		Companies []struct {
			ID string `json:"id"`
		} `json:"companies"`
	}
	if err = json.Unmarshal(payload, &data); err != nil {
		return false, err
	}
	for _, company := range data.Companies {
		if company.ID == id {
			return true, nil
		}
	}
	return false, nil
}
func (s *Server) addBookmark(w http.ResponseWriter, r *http.Request, user User) {
	s.mutateBookmark(w, r, user, true)
}
func (s *Server) removeBookmark(w http.ResponseWriter, r *http.Request, user User) {
	s.mutateBookmark(w, r, user, false)
}
func (s *Server) mutateBookmark(w http.ResponseWriter, r *http.Request, user User, add bool) {
	id := r.PathValue("companyID")
	exists, err := s.companyExists(r.Context(), id)
	if err != nil {
		failure(w, 503, "dataset_unavailable")
		return
	}
	if !exists {
		failure(w, 404, "company_not_found")
		return
	}
	store, ok := s.store.(BookmarkStore)
	if !ok {
		failure(w, 503, "bookmarks_unavailable")
		return
	}
	if add {
		err = store.AddBookmark(r.Context(), user.Sub, id)
	} else {
		err = store.RemoveBookmark(r.Context(), user.Sub, id)
	}
	if err != nil {
		failure(w, 503, "bookmarks_unavailable")
		return
	}
	w.WriteHeader(204)
}
