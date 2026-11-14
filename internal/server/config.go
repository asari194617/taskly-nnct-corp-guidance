package server

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	UIOrigin         string
	APIOrigin        string
	AuthIssuer       string
	ClientID         string
	EncryptionKey    []byte
	SecureCookies    bool
	R2Endpoint       string
	R2Bucket         string
	R2AccessKeyID    string
	R2SecretKey      string
	TasklyAPIOrigin  string
	TasklyEventID    string
	MCPEnabled       bool
	MCPBackendSecret string
}

func ConfigFromEnv() (Config, error) {
	if value := os.Getenv("MCP_ENABLED"); value != "" && value != "0" && value != "1" {
		return Config{}, fmt.Errorf("MCP_ENABLED must be 0 or 1")
	}
	if storage := os.Getenv("DOCUMENT_STORAGE"); storage != "" && storage != "r2" {
		return Config{}, fmt.Errorf("DOCUMENT_STORAGE must be r2")
	}
	key, err := base64.StdEncoding.DecodeString(os.Getenv("SESSION_ENCRYPTION_KEY"))
	if err != nil {
		return Config{}, fmt.Errorf("SESSION_ENCRYPTION_KEY must be base64")
	}
	c := Config{UIOrigin: os.Getenv("UI_ORIGIN"), APIOrigin: os.Getenv("API_ORIGIN"), AuthIssuer: os.Getenv("AUTH_ISSUER"), ClientID: os.Getenv("AUTH_CLIENT_ID"), EncryptionKey: key,
		R2Endpoint: os.Getenv("R2_ENDPOINT"), R2Bucket: os.Getenv("R2_BUCKET"), R2AccessKeyID: os.Getenv("R2_ACCESS_KEY_ID"), R2SecretKey: os.Getenv("R2_SECRET_ACCESS_KEY"),
		TasklyAPIOrigin: os.Getenv("TASKLY_API_ORIGIN"), TasklyEventID: os.Getenv("TASKLY_GUIDANCE_EVENT_ID")}
	c.MCPEnabled = os.Getenv("MCP_ENABLED") == "1"
	c.MCPBackendSecret = os.Getenv("MCP_BACKEND_SECRET")
	if c.ClientID == "" {
		c.ClientID = "nnct-corp-guidance-2026"
	}
	if err := c.Validate(); err != nil {
		return Config{}, err
	}
	c.SecureCookies = strings.HasPrefix(c.APIOrigin, "https://")
	return c, nil
}
func (c Config) Validate() error {
	if c.MCPEnabled && (len(c.MCPBackendSecret) < 32 || strings.TrimSpace(c.MCPBackendSecret) != c.MCPBackendSecret || c.TasklyAPIOrigin == "") {
		return fmt.Errorf("MCP requires its dedicated backend secret and Taskly bridge configuration")
	}
	if len(c.EncryptionKey) != 32 {
		return fmt.Errorf("SESSION_ENCRYPTION_KEY must decode to 32 bytes")
	}
	origins := map[string]string{"UI_ORIGIN": c.UIOrigin, "API_ORIGIN": c.APIOrigin, "AUTH_ISSUER": c.AuthIssuer}
	if (c.TasklyAPIOrigin == "") != (c.TasklyEventID == "") {
		return fmt.Errorf("TASKLY_API_ORIGIN and TASKLY_GUIDANCE_EVENT_ID must be configured together")
	}
	if c.TasklyAPIOrigin != "" {
		origins["TASKLY_API_ORIGIN"] = c.TasklyAPIOrigin
		if !tasklyEventPattern.MatchString(c.TasklyEventID) {
			return fmt.Errorf("TASKLY_GUIDANCE_EVENT_ID must be a stable event identifier")
		}
	}
	for name, value := range origins {
		u, err := url.Parse(value)
		if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" {
			return fmt.Errorf("%s must be an origin without a trailing slash", name)
		}
		if u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "::1")) {
			return fmt.Errorf("%s requires HTTPS except loopback development", name)
		}
	}
	if c.ClientID == "" || len(c.ClientID) > 128 {
		return fmt.Errorf("AUTH_CLIENT_ID required")
	}
	if err := c.validateR2(); err != nil {
		return err
	}
	return nil
}
