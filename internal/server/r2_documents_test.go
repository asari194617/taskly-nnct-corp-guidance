package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// Independently verify the AWS SDK's URL at the object-service boundary. This
// test-only verifier has no access to the API's encrypted sessions or cookies.
func validTestR2Signature(r *http.Request, accessKey, secret string, now time.Time) bool {
	query := r.URL.Query()
	if query.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" || query.Get("X-Amz-SignedHeaders") != "host" {
		return false
	}
	credential := strings.Split(query.Get("X-Amz-Credential"), "/")
	if len(credential) != 5 || credential[0] != accessKey || credential[2] != "auto" || credential[3] != "s3" || credential[4] != "aws4_request" {
		return false
	}
	issued, err := time.Parse("20060102T150405Z", query.Get("X-Amz-Date"))
	seconds, expireErr := strconv.ParseInt(query.Get("X-Amz-Expires"), 10, 64)
	if err != nil || expireErr != nil || seconds < 1 || seconds > 300 || now.Before(issued) || !now.Before(issued.Add(time.Duration(seconds)*time.Second)) {
		return false
	}
	signature := query.Get("X-Amz-Signature")
	query.Del("X-Amz-Signature")
	canonicalQuery := strings.ReplaceAll(query.Encode(), "+", "%20")
	canonical := r.Method + "\n" + r.URL.EscapedPath() + "\n" + canonicalQuery + "\nhost:" + r.Host + "\n\nhost\nUNSIGNED-PAYLOAD"
	canonicalHash := sha256.Sum256([]byte(canonical))
	scope := strings.Join(credential[1:], "/")
	message := "AWS4-HMAC-SHA256\n" + query.Get("X-Amz-Date") + "\n" + scope + "\n" + hex.EncodeToString(canonicalHash[:])
	hash := func(key []byte, message string) []byte {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(message))
		return mac.Sum(nil)
	}
	key := hash([]byte("AWS4"+secret), credential[1])
	key = hash(key, "auto")
	key = hash(key, "s3")
	key = hash(key, "aws4_request")
	expected := hex.EncodeToString(hash(key, message))
	return hmac.Equal([]byte(signature), []byte(expected))
}

func TestR2PresignIsDirectBoundedAndBoundToMethodObjectAndHeaders(t *testing.T) {
	s, _, cookie, _ := signedDocumentFixture(t)
	link, expiry := issueDocumentURL(t, s, cookie)
	if link.Host == strings.TrimPrefix(s.config.APIOrigin, "https://") || strings.Contains(link.String(), s.config.R2SecretKey) || strings.Contains(link.String(), cookie.Value) {
		t.Fatal("presigned URL is not a direct credential-safe object URL")
	}
	if link.Query().Get("response-cache-control") != "no-store" || link.Query().Get("response-content-type") != "application/pdf" || link.Query().Get("response-content-disposition") != `inline; filename="guide.pdf"` {
		t.Fatal("presigned response metadata changed")
	}
	get, _ := http.NewRequest("GET", link.String(), nil)
	if !validTestR2Signature(get, s.config.R2AccessKeyID, s.config.R2SecretKey, time.Now()) {
		t.Fatal("signature did not independently verify")
	}
	for _, mode := range []string{"method", "object", "expiry", "content type", "secret", "expired"} {
		t.Run(mode, func(t *testing.T) {
			target := *link
			method, secret, now := "GET", s.config.R2SecretKey, time.Now()
			q := target.Query()
			switch mode {
			case "method":
				method = "HEAD"
			case "object":
				target.Path = "/" + s.config.R2Bucket + "/other.pdf"
			case "expiry":
				q.Set("X-Amz-Expires", "604800")
			case "content type":
				q.Set("response-content-type", "text/html")
			case "secret":
				secret = "different-credential"
			case "expired":
				now = expiry.Add(time.Second)
			}
			target.RawQuery = q.Encode()
			req, _ := http.NewRequest(method, target.String(), nil)
			if validTestR2Signature(req, s.config.R2AccessKeyID, secret, now) {
				t.Fatal("modified presigned request authorized")
			}
		})
	}
	get.Header.Set("Range", "bytes=0-4")
	if !validTestR2Signature(get, s.config.R2AccessKeyID, s.config.R2SecretKey, time.Now()) {
		t.Fatal("unsigned Range header prevented a PDF range request")
	}
}

func TestR2IssuanceFailsClosedAndCapsRedirectAtParentExpiry(t *testing.T) {
	s, f, cookie, _ := signedDocumentFixture(t)
	row := f.sessions[digest(cookie.Value)]
	row.expiry = time.Now().Add(20 * time.Second)
	f.sessions[digest(cookie.Value)] = row
	w := request(s, "GET", "/api/documents/guide", cookie, "")
	requireStatus(t, w, 302)
	location, _ := url.Parse(w.Header().Get("Location"))
	issued, _ := time.Parse("20060102T150405Z", location.Query().Get("X-Amz-Date"))
	seconds, _ := strconv.Atoi(location.Query().Get("X-Amz-Expires"))
	if issued.Add(time.Duration(seconds) * time.Second).After(row.expiry) {
		t.Fatal("redirect capability outlives its session")
	}
	s.documents = s3.NewPresignClient(s3.NewFromConfig(aws.Config{Region: "auto", Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) { return aws.Credentials{}, errors.New("unavailable") })}, func(o *s3.Options) { o.BaseEndpoint = aws.String(s.config.R2Endpoint); o.UsePathStyle = true }))
	requireStatus(t, request(s, "GET", "/api/documents/guide/url", cookie, ""), 503)
	requireStatus(t, request(s, "GET", "/api/documents/guide", cookie, ""), 503)
	if _, _, err := s.presignDocument(context.Background(), f.documents["guide"], "GET", time.Now()); err == nil {
		t.Fatal("expired signing deadline accepted")
	}
}

func TestR2ObjectMetadataAndConfigurationFailClosed(t *testing.T) {
	for _, file := range []string{"", ".", "..", "../guide.pdf", "nested/guide.pdf", `nested\guide.pdf`, "guide.pdf?public=1", "guide.pdf#fragment", "guide.pdf\r\nX-Header: injected"} {
		if allowedDocument(Document{ID: "guide", FileName: file, MIMEType: "application/pdf"}) {
			t.Fatalf("unsafe object key %q accepted", file)
		}
	}
	for _, edit := range []func(*Config){
		func(c *Config) { c.R2Endpoint = "" }, func(c *Config) { c.R2Endpoint = "https://%" }, func(c *Config) { c.R2Endpoint = "https://user:pass@objects.example.test" },
		func(c *Config) { c.R2Endpoint += "/bucket" }, func(c *Config) { c.R2Endpoint += "?x=y" }, func(c *Config) { c.R2Endpoint += "#x" },
		func(c *Config) { c.R2Endpoint = "http://objects.example.test" }, func(c *Config) { c.R2Endpoint = "http://localhost:3373" },
		func(c *Config) { c.R2Bucket = "BadBucket" }, func(c *Config) { c.R2Bucket = "../bucket" }, func(c *Config) { c.R2AccessKeyID = "" }, func(c *Config) { c.R2SecretKey = "" }, func(c *Config) { c.R2SecretKey = " key " },
	} {
		c := validConfig()
		edit(&c)
		if c.Validate() == nil {
			t.Fatal("invalid R2 configuration accepted")
		}
	}
	c := validConfig()
	c.APIOrigin = "http://127.0.0.1:3071"
	c.R2Endpoint = "http://127.0.0.1:3373"
	if c.Validate() != nil {
		t.Fatal("loopback object test endpoint rejected")
	}
	t.Setenv("DOCUMENT_STORAGE", "local")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("local filesystem document mode accepted")
	}
}

func TestR2AlreadyIssuedCapabilitySurvivesLogoutButNewIssuanceDoesNot(t *testing.T) {
	s, _, cookie, _ := signedDocumentFixture(t)
	link, expiry := issueDocumentURL(t, s, cookie)
	requireStatus(t, request(s, "POST", "/auth/logout", cookie, s.config.UIOrigin), 204)
	requireStatus(t, request(s, "GET", "/api/documents/guide/url", cookie, s.config.UIOrigin), 401)
	objectRequest := httptest.NewRequest("GET", link.String(), nil)
	if !validTestR2Signature(objectRequest, s.config.R2AccessKeyID, s.config.R2SecretKey, time.Now()) {
		t.Fatal("issued R2 capability semantics unexpectedly depended on an API cookie")
	}
	if validTestR2Signature(objectRequest, s.config.R2AccessKeyID, s.config.R2SecretKey, expiry) {
		t.Fatal("expired object capability remained authorized")
	}
}
