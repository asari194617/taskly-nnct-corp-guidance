package server

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

var r2BucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)
var documentFilePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$`)

func (c Config) validateR2() error {
	endpoint, err := url.Parse(c.R2Endpoint)
	if err != nil || endpoint.Host == "" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" || endpoint.Path != "" {
		return fmt.Errorf("R2_ENDPOINT must be an origin without a trailing slash")
	}
	loopback := endpoint.Hostname() == "localhost" || endpoint.Hostname() == "127.0.0.1" || endpoint.Hostname() == "::1"
	if endpoint.Scheme != "https" && !(endpoint.Scheme == "http" && loopback && strings.HasPrefix(c.APIOrigin, "http://")) {
		return fmt.Errorf("R2_ENDPOINT requires HTTPS except loopback development")
	}
	if !r2BucketPattern.MatchString(c.R2Bucket) {
		return fmt.Errorf("R2_BUCKET must be a valid bucket name")
	}
	if c.R2AccessKeyID == "" || c.R2SecretKey == "" || strings.TrimSpace(c.R2AccessKeyID) != c.R2AccessKeyID || strings.TrimSpace(c.R2SecretKey) != c.R2SecretKey {
		return fmt.Errorf("R2 access credentials are required")
	}
	return nil
}

func newDocumentPresigner(c Config) *s3.PresignClient {
	// Do not load ambient AWS credentials, instance metadata or a default bucket.
	// These read-only credentials belong exclusively to the private document bucket.
	client := s3.NewFromConfig(aws.Config{
		Region:      "auto",
		Credentials: credentials.NewStaticCredentialsProvider(c.R2AccessKeyID, c.R2SecretKey, ""),
	}, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(c.R2Endpoint)
		options.UsePathStyle = true
	})
	return s3.NewPresignClient(client)
}

func allowedDocument(document Document) bool {
	return documentIDPattern.MatchString(document.ID) && documentFilePattern.MatchString(document.FileName) && !strings.Contains(document.FileName, "..") && allowedDocumentMIME(document.MIMEType)
}

func (s *Server) presignDocument(ctx context.Context, document Document, method string, expiry time.Time) (string, time.Time, error) {
	// Signing uses whole seconds. Reserve one second so the actual S3 signature
	// (whose timestamp is also second-precision) cannot outlive the parent session.
	seconds := int64(time.Until(expiry) / time.Second)
	if seconds > int64(documentURLLifetime/time.Second) {
		seconds = int64(documentURLLifetime / time.Second)
	}
	if seconds < 1 {
		return "", time.Time{}, fmt.Errorf("document link lifetime elapsed")
	}
	options := func(options *s3.PresignOptions) { options.Expires = time.Duration(seconds) * time.Second }
	var link string
	if method == http.MethodHead {
		result, err := s.documents.PresignHeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.config.R2Bucket), Key: aws.String(document.FileName)}, options)
		if err != nil {
			return "", time.Time{}, err
		}
		link = result.URL
	} else {
		result, err := s.documents.PresignGetObject(ctx, &s3.GetObjectInput{
			Bucket:                     aws.String(s.config.R2Bucket),
			Key:                        aws.String(document.FileName),
			ResponseContentType:        aws.String(document.MIMEType),
			ResponseContentDisposition: aws.String(`inline; filename="` + document.ID + documentExtension(document.MIMEType) + `"`),
			ResponseCacheControl:       aws.String("no-store"),
		}, options)
		if err != nil {
			return "", time.Time{}, err
		}
		link = result.URL
	}
	parsed, err := url.Parse(link)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("invalid document URL")
	}
	issued, err := time.Parse("20060102T150405Z", parsed.Query().Get("X-Amz-Date"))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("invalid document URL timestamp")
	}
	signedExpiry := issued.Add(time.Duration(seconds) * time.Second)
	if signedExpiry.After(expiry) {
		return "", time.Time{}, fmt.Errorf("document signing exceeded its parent deadline")
	}
	return link, signedExpiry, nil
}
