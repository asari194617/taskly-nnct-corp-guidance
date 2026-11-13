package server

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

type fakeSession struct {
	encrypted []byte
	expiry    time.Time
}
type fakeStore struct {
	mu                                                                           sync.Mutex
	flows                                                                        map[string][]byte
	sessions                                                                     map[string]fakeSession
	dataset                                                                      json.RawMessage
	documents                                                                    map[string]Document
	bookmarks                                                                    map[string]map[string]bool
	preferences                                                                  map[string]int
	pingErr, errorFlow, errorSession, errorDataset, errorDocument, errorBookmark error
	errorPreference                                                              error
}

func newFakeStore() *fakeStore {
	return &fakeStore{flows: map[string][]byte{}, sessions: map[string]fakeSession{}, dataset: json.RawMessage(`{"event":{"title":"Synthetic event"},"companies":[{"id":"AM-1","name":"Example company","session":"AM","booth":1,"industries":[]}],"documents":[]}`), documents: map[string]Document{}, bookmarks: map[string]map[string]bool{}, preferences: map[string]int{}}
}
func (f *fakeStore) Ping(context.Context) error { return f.pingErr }
func (f *fakeStore) SaveFlow(_ context.Context, key string, value []byte, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.errorFlow != nil {
		return f.errorFlow
	}
	f.flows[key] = value
	return nil
}
func (f *fakeStore) ConsumeFlow(_ context.Context, key string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.errorFlow != nil {
		return nil, f.errorFlow
	}
	v, ok := f.flows[key]
	if !ok {
		return nil, ErrNotFound
	}
	delete(f.flows, key)
	return v, nil
}
func (f *fakeStore) SaveSession(_ context.Context, key string, value []byte, expiry time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.errorSession != nil {
		return f.errorSession
	}
	f.sessions[key] = fakeSession{value, expiry}
	return nil
}
func (f *fakeStore) Session(_ context.Context, key string) ([]byte, time.Time, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.errorSession != nil {
		return nil, time.Time{}, f.errorSession
	}
	v, ok := f.sessions[key]
	if !ok {
		return nil, time.Time{}, ErrNotFound
	}
	return v.encrypted, v.expiry, nil
}
func (f *fakeStore) DeleteSession(_ context.Context, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.errorSession != nil {
		return f.errorSession
	}
	delete(f.sessions, key)
	return nil
}
func (f *fakeStore) Dataset(context.Context) (json.RawMessage, error) {
	return f.dataset, f.errorDataset
}
func (f *fakeStore) Document(_ context.Context, key string) (Document, error) {
	if f.errorDocument != nil {
		return Document{}, f.errorDocument
	}
	d, ok := f.documents[key]
	if !ok {
		return Document{}, ErrNotFound
	}
	return d, nil
}
func (f *fakeStore) Cleanup(context.Context) error { return nil }
func (f *fakeStore) Preference(_ context.Context, sub string) (*int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.errorPreference != nil {
		return nil, f.errorPreference
	}
	value, ok := f.preferences[sub]
	if !ok {
		return nil, nil
	}
	return &value, nil
}
func (f *fakeStore) SetPreference(_ context.Context, sub string, value int) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.errorPreference != nil {
		return f.errorPreference
	}
	f.preferences[sub] = value
	return nil
}
func (f *fakeStore) Bookmarks(_ context.Context, sub string) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.errorBookmark != nil {
		return nil, f.errorBookmark
	}
	ids := []string{}
	for id := range f.bookmarks[sub] {
		ids = append(ids, id)
	}
	return ids, nil
}
func (f *fakeStore) AddBookmark(_ context.Context, sub, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.errorBookmark != nil {
		return f.errorBookmark
	}
	if f.bookmarks[sub] == nil {
		f.bookmarks[sub] = map[string]bool{}
	}
	f.bookmarks[sub][id] = true
	return nil
}
func (f *fakeStore) RemoveBookmark(_ context.Context, sub, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.errorBookmark != nil {
		return f.errorBookmark
	}
	delete(f.bookmarks[sub], id)
	return nil
}
