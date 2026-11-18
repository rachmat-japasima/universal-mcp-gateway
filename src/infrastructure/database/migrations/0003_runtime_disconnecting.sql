-- 0003_runtime_disconnecting.sql
--
-- Adds the `disconnecting` lifecycle state to backend_runtime.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt. This is a
-- pure schema change: every row is copied verbatim and nothing is dropped from
-- the model. The rebuild is done inside the migration runner's transaction, so
-- a failure leaves 0002's schema untouched.
--
-- Why the state exists at all: teardown is not instantaneous (a child process
-- gets SIGTERM, then a grace period, then SIGKILL), and showing `connected`
-- while the process is being killed would be a lie. A crash mid-disconnect is
-- recovered to `disconnected` at startup, never re-attempted.

CREATE TABLE backend_runtime_new (
  backend_id          TEXT PRIMARY KEY REFERENCES backends (id) ON DELETE CASCADE,
  status              TEXT NOT NULL CHECK (status IN ('disconnected', 'connecting', 'connected', 'unhealthy', 'disconnecting', 'error', 'disabled')),
  last_connected_at   TEXT,
  last_health_check_at TEXT,
  last_error_code     TEXT,
  last_error_at       TEXT,
  last_error_message  TEXT,
  reconnect_attempts  INTEGER NOT NULL DEFAULT 0 CHECK (reconnect_attempts >= 0),
  updated_at          TEXT NOT NULL
);

INSERT INTO backend_runtime_new (
  backend_id, status, last_connected_at, last_health_check_at,
  last_error_code, last_error_at, last_error_message, reconnect_attempts, updated_at
)
SELECT
  backend_id, status, last_connected_at, last_health_check_at,
  last_error_code, last_error_at, last_error_message, reconnect_attempts, updated_at
FROM backend_runtime;

DROP TABLE backend_runtime;
ALTER TABLE backend_runtime_new RENAME TO backend_runtime;

CREATE INDEX idx_backend_runtime_status ON backend_runtime (status);
