package server

import (
	"encoding/base64"
	"fmt"
	"net/url"
	"os"
	"strings"
)

type Config struct {
	UIOrigin      string
	APIOrigin     string
	AuthIssuer    string
	ClientID      string
	DataDir       string
	EncryptionKey []byte
	SecureCookies bool
}

func ConfigFromEnv() (Config, error) {
	key, err := base64.StdEncoding.DecodeString(os.Getenv("SESSION_ENCRYPTION_KEY"))
	if err != nil {
		return Config{}, fmt.Errorf("SESSION_ENCRYPTION_KEY must be base64")
	}
	c := Config{UIOrigin: os.Getenv("UI_ORIGIN"), APIOrigin: os.Getenv("API_ORIGIN"), AuthIssuer: os.Getenv("AUTH_ISSUER"), ClientID: os.Getenv("AUTH_CLIENT_ID"), DataDir: os.Getenv("DATA_DIR"), EncryptionKey: key}
	if c.ClientID == "" {
		c.ClientID = "nnct-corp-guidance-2026"
	}
	if c.DataDir == "" {
		c.DataDir = "/data"
	}
	if err := c.Validate(); err != nil {
		return Config{}, err
	}
	c.SecureCookies = strings.HasPrefix(c.APIOrigin, "https://")
	return c, nil
}
func (c Config) Validate() error {
	if len(c.EncryptionKey) != 32 {
		return fmt.Errorf("SESSION_ENCRYPTION_KEY must decode to 32 bytes")
	}
	for name, value := range map[string]string{"UI_ORIGIN": c.UIOrigin, "API_ORIGIN": c.APIOrigin, "AUTH_ISSUER": c.AuthIssuer} {
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
	return nil
}
