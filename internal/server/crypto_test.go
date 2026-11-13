package server

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"io"
	"testing"
)

func TestTokensAndEncryption(t *testing.T) {
	a, err := randomToken()
	if err != nil {
		t.Fatal(err)
	}
	b, err := randomToken()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := base64.RawURLEncoding.DecodeString(a)
	if err != nil || len(raw) != 32 || a == b {
		t.Fatal("tokens must be independent 256-bit URL-safe values")
	}
	if digest("test") == "test" || len(digest("test")) != 64 || digest("test") != digest("test") {
		t.Fatal("unexpected digest")
	}
	cipher, err := newCipher(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{aead: cipher}
	enc, err := s.encrypt("private access token")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(enc, []byte("private access token")) {
		t.Fatal("token stored in plaintext")
	}
	dec, err := s.decrypt(enc)
	if err != nil || dec != "private access token" {
		t.Fatalf("round trip: %q %v", dec, err)
	}
	enc2, err := s.encrypt("private access token")
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(enc, enc2) {
		t.Fatal("nonce reused")
	}
	enc[len(enc)-1] ^= 1
	if _, err = s.decrypt(enc); err == nil {
		t.Fatal("tampered token accepted")
	}
	if _, err = s.decrypt([]byte("short")); err == nil {
		t.Fatal("truncated token accepted")
	}
	if _, err = newCipher([]byte("short")); err == nil {
		t.Fatal("invalid cipher key accepted")
	}
}

func TestDigestKnownValue(t *testing.T) {
	if got := digest("test"); got != "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08" {
		t.Fatalf("SHA-256 mismatch: %s", got)
	}
}

type failEntropyReader struct{ readCount, failAt int }

func (r *failEntropyReader) Read(b []byte) (int, error) {
	r.readCount++
	if r.readCount == r.failAt {
		return 0, io.ErrUnexpectedEOF
	}
	for i := range b {
		b[i] = byte(i + 1)
	}
	return len(b), nil
}
func replaceEntropy(t *testing.T, failAt int) {
	t.Helper()
	original := rand.Reader
	rand.Reader = &failEntropyReader{failAt: failAt}
	t.Cleanup(func() { rand.Reader = original })
}
func TestEntropyFailuresAreReturned(t *testing.T) {
	replaceEntropy(t, 1)
	if _, err := randomToken(); err == nil {
		t.Fatal("entropy failure ignored")
	}
	cipher, err := newCipher(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{aead: cipher}
	rand.Reader = &failEntropyReader{failAt: 1}
	if _, err = s.encrypt("access"); err == nil {
		t.Fatal("nonce entropy failure ignored")
	}
}
