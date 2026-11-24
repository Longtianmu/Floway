CREATE TABLE user_quotas (
  id TEXT PRIMARY KEY NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upstream_id TEXT CHECK (upstream_id <> ''),
  limit_usd TEXT NOT NULL,
  enforce INTEGER NOT NULL CHECK (enforce IN (0, 1)),
  reset_json TEXT NOT NULL CHECK (json_valid(reset_json)),
  starts_at INTEGER NOT NULL CHECK (starts_at >= 0),
  spent_usd TEXT NOT NULL,
  unpriced INTEGER NOT NULL CHECK (unpriced IN (0, 1)),
  revision TEXT NOT NULL
);

CREATE UNIQUE INDEX user_quotas_scope ON user_quotas (user_id, COALESCE(upstream_id, ''));
