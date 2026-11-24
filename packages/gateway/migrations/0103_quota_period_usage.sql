ALTER TABLE user_quotas ADD COLUMN observed_cycle_start INTEGER CHECK (observed_cycle_start >= 0);

CREATE TABLE usage_settlements (
  id TEXT PRIMARY KEY NOT NULL,
  key_id TEXT NOT NULL,
  upstream TEXT,
  timestamp INTEGER NOT NULL CHECK (timestamp >= 0),
  spent_usd TEXT NOT NULL,
  unpriced INTEGER NOT NULL CHECK (unpriced IN (0, 1))
);

CREATE INDEX usage_settlements_key_time ON usage_settlements (key_id, timestamp);
