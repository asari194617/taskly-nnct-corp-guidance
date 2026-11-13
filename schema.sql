-- Schema only. Never add event, company, assignment or document data here.
CREATE TABLE IF NOT EXISTS guidance_dataset (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    payload JSON NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT guidance_singleton CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS guidance_documents (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    file_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(128) NOT NULL,
    title VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS guidance_oauth_flows (
    state_hash CHAR(64) NOT NULL PRIMARY KEY,
    verifier_ciphertext BLOB NOT NULL,
    expires_at DATETIME NOT NULL,
    INDEX guidance_flows_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS guidance_sessions (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    access_ciphertext BLOB NOT NULL,
    expires_at DATETIME NOT NULL,
    INDEX guidance_sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS guidance_bookmarks (
    user_sub VARCHAR(255) NOT NULL,
    company_id VARCHAR(64) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_sub, company_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS guidance_preferences (
    user_sub VARCHAR(255) NOT NULL PRIMARY KEY,
    roster_number TINYINT UNSIGNED NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT guidance_preferences_roster CHECK (roster_number BETWEEN 1 AND 99)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
