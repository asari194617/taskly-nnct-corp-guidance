-- Additive migration; preserves all existing event, session and bookmark data.
CREATE TABLE IF NOT EXISTS guidance_preferences (
    user_sub VARCHAR(255) NOT NULL PRIMARY KEY,
    roster_number TINYINT UNSIGNED NOT NULL,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT guidance_preferences_roster CHECK (roster_number BETWEEN 1 AND 99)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
