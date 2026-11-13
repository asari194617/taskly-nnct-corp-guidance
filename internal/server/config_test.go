package server

import (
	"encoding/base64"
	"strings"
	"testing"
)

func validConfig() Config {
	return Config{UIOrigin: "https://ui.example.test", APIOrigin: "https://api.example.test", AuthIssuer: "https://auth.example.test", ClientID: "test-client", DataDir: "/data", EncryptionKey: make([]byte, 32)}
}

func TestConfigValidation(t *testing.T) {
	if err := validConfig().Validate(); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		edit func(*Config)
	}{
		{"short encryption key", func(c *Config) { c.EncryptionKey = []byte("short") }},
		{"missing client", func(c *Config) { c.ClientID = "" }},
		{"long client", func(c *Config) { c.ClientID = strings.Repeat("a", 129) }},
		{"userinfo", func(c *Config) { c.UIOrigin = "https://user:pass@example.test" }},
		{"path", func(c *Config) { c.APIOrigin = "https://api.example.test/path" }},
		{"slash", func(c *Config) { c.UIOrigin += "/" }},
		{"query", func(c *Config) { c.AuthIssuer += "?x=1" }},
		{"fragment", func(c *Config) { c.UIOrigin += "#fragment" }},
		{"missing host", func(c *Config) { c.APIOrigin = "https:" }},
		{"invalid url", func(c *Config) { c.APIOrigin = "https://%" }},
		{"remote http", func(c *Config) { c.AuthIssuer = "http://auth.example.test" }},
		{"unsupported scheme", func(c *Config) { c.UIOrigin = "ftp://ui.example.test" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := validConfig()
			tc.edit(&c)
			if c.Validate() == nil {
				t.Fatal("invalid config accepted")
			}
		})
	}
	for _, origin := range []string{"http://localhost:3000", "http://127.0.0.1:8080", "http://[::1]:8080"} {
		c := validConfig()
		c.UIOrigin = origin
		if err := c.Validate(); err != nil {
			t.Errorf("loopback %s: %v", origin, err)
		}
	}
}

func TestConfigFromEnv(t *testing.T) {
	for k, v := range map[string]string{"UI_ORIGIN": "https://ui.example.test", "API_ORIGIN": "https://api.example.test", "AUTH_ISSUER": "https://auth.example.test", "SESSION_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString(make([]byte, 32)), "AUTH_CLIENT_ID": "", "DATA_DIR": ""} {
		t.Setenv(k, v)
	}
	c, err := ConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if !c.SecureCookies || c.ClientID != "nnct-corp-guidance-2026" || c.DataDir != "/data" {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	t.Setenv("SESSION_ENCRYPTION_KEY", "invalid base64")
	if _, err = ConfigFromEnv(); err == nil {
		t.Fatal("invalid key encoding accepted")
	}
	t.Setenv("SESSION_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString([]byte("short")))
	if _, err = ConfigFromEnv(); err == nil {
		t.Fatal("short decoded key accepted")
	}
	t.Setenv("SESSION_ENCRYPTION_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("API_ORIGIN", "http://localhost:8080")
	t.Setenv("AUTH_CLIENT_ID", "custom")
	t.Setenv("DATA_DIR", "/private")
	c, err = ConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if c.SecureCookies || c.ClientID != "custom" || c.DataDir != "/private" {
		t.Fatalf("overrides ignored: %+v", c)
	}
}
