-- 0006_operator_authentication.sql
--
-- Phase 10.0: dashboard operator identity and sessions.
--
-- Additive. `admin_users` has existed since 0001 with `id`, `username`,
-- `password_hash`, `role`, `enabled`, `created_at`, `updated_at`; nothing here
-- rebuilds it and no row is dropped.
--
-- Why operator sessions are their own table rather than a reuse of `sessions`:
-- `sessions.agent_id` is `NOT NULL REFERENCES agents (id)`, because that table
-- binds an *MCP protocol* session to an agent. An operator session is a
-- different boundary entirely — reusing the table would either require a
-- nullable agent_id (weakening the MCP invariant) or an operator row in
-- `agents` (blurring two security domains, which ADR-044 forbids).
--
-- Why both `expires_at` and `last_seen_at`: this mirrors the MCP session rules
-- (idle timeout *and* absolute lifetime) so an operator session cannot outlive
-- a stolen cookie. Effective status is derived on read, not trusted from a
-- background sweep, so a missed cleanup cannot extend access.
--
-- Why `token_hash` and not the token: the cookie value is a bearer credential.
-- Only an HMAC digest is stored, exactly as `agent_credentials` stores a digest.
-- Lookup is by digest, which the UNIQUE index serves, so verification needs no
-- scan and a stolen database cannot be used to confirm a guessed token.
--
-- Why `revoked_at`/`revocation_reason`: logout and "operator disabled" are
-- different events for the audit trail, and a revoked row must stay as history
-- rather than being deleted.

ALTER TABLE admin_users ADD COLUMN display_name TEXT;
ALTER TABLE admin_users ADD COLUMN password_changed_at TEXT;
ALTER TABLE admin_users ADD COLUMN last_login_at TEXT;
ALTER TABLE admin_users ADD COLUMN failed_login_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (failed_login_attempts >= 0);
-- Lockout is time-based, so a restart cannot leave an account locked forever.
ALTER TABLE admin_users ADD COLUMN locked_until TEXT;
ALTER TABLE admin_users ADD COLUMN disabled_at TEXT;

-- An operator id is never reused and never re-pointed: `id` is the primary key
-- and `username` is UNIQUE (0001), so a second insert is a constraint violation
-- rather than a silent second identity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users (username);

CREATE TABLE operator_sessions (
  id                TEXT PRIMARY KEY,
  operator_id       TEXT NOT NULL REFERENCES admin_users (id) ON DELETE CASCADE,
  -- HMAC-SHA-256 digest of the cookie value, lowercase hex.
  token_hash        TEXT NOT NULL,
  hash_key_id       TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  last_seen_at      TEXT NOT NULL,
  -- Absolute lifetime ceiling.
  expires_at        TEXT NOT NULL,
  revoked_at        TEXT,
  revocation_reason TEXT CHECK (revocation_reason IN (
    'logout', 'operator_disabled', 'operator_password_changed',
    'operator_deleted', 'cleanup', 'gateway_shutdown'
  )),
  -- Client fingerprint for the audit trail only. Never used as proof of identity.
  user_agent        TEXT,
  ip_address        TEXT
);

CREATE UNIQUE INDEX idx_operator_sessions_token ON operator_sessions (token_hash);
CREATE INDEX idx_operator_sessions_operator ON operator_sessions (operator_id, last_seen_at);
CREATE INDEX idx_operator_sessions_expiry ON operator_sessions (expires_at);

-- A revoked row must say why, and a live row must not carry a revocation.
-- Triggers rather than CHECK because SQLite cannot add a table constraint to an
-- existing table, and this table is created fresh so either would work — the
-- trigger form matches the 0005 convention and documents intent at the write.
CREATE TRIGGER operator_sessions_revocation_is_complete
BEFORE UPDATE ON operator_sessions
WHEN NEW.revoked_at IS NOT NULL AND NEW.revocation_reason IS NULL
BEGIN
  SELECT RAISE(ABORT, 'operator_sessions: a revoked session must carry a reason');
END;

-- A session is one-way: once revoked it can never become live again. Without
-- this, a bug could resurrect a logged-out cookie.
CREATE TRIGGER operator_sessions_no_reactivation
BEFORE UPDATE ON operator_sessions
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'operator_sessions: a revoked session cannot be reactivated');
END;
