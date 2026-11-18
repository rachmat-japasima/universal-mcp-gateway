-- 0005_session_isolation.sql
--
-- Phase 7: persistent MCP session isolation.
--
-- Additive. The `sessions` table from 0001 is extended, not rebuilt, so any row
-- written by an earlier build keeps its identity, timestamps and metadata.
--
-- Why each column:
--
--   * `mcp_session_id` — the protocol id the SDK issues at initialization and the
--     client echoes in `mcp-session-id`. Distinct from `sessions.id`, which is
--     the gateway's internal handle and is never sent to a client. UNIQUE so two
--     agents can never be bound to one protocol session; partial so legacy rows
--     (and any future sessionless mode) stay valid.
--   * `credential_id` — which credential opened the session. A revocation must
--     be able to invalidate exactly the sessions that credential authorized.
--     ON DELETE SET NULL: credentials are revoked with a timestamp, never
--     deleted, but a hard delete must not destroy the session row.
--   * `status` — explicit lifecycle state. Before this phase status was derived
--     from `revoked_at`/`expires_at`, which cannot express "terminated by an
--     operator" separately from "invalidated by a security event".
--   * `terminated_at` / `termination_reason` — when and why a session stopped.
--     A closed enum, so the audit trail can be aggregated.
--
-- `revoked_at` is kept (additive rule) and back-filled into `status`, so a
-- pre-0005 revoked row keeps meaning what it meant.
--
-- Indexes: UNIQUE on the protocol id (also serves lookup), plus agent,
-- credential, status, expiry and last activity. `idx_sessions_agent` and
-- `idx_sessions_expiry` already exist from 0001 and are not duplicated.

ALTER TABLE sessions ADD COLUMN mcp_session_id TEXT;
ALTER TABLE sessions ADD COLUMN credential_id TEXT REFERENCES agent_credentials (id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'expired', 'terminated', 'invalidated'));
ALTER TABLE sessions ADD COLUMN terminated_at TEXT;
ALTER TABLE sessions ADD COLUMN termination_reason TEXT CHECK (termination_reason IN (
  'operator_terminated', 'client_deleted', 'idle_timeout', 'max_lifetime',
  'agent_disabled', 'agent_deleted', 'credential_revoked', 'credential_rotated',
  'gateway_shutdown', 'transport_lost', 'cleanup'
));

-- Back-fill: a row revoked before this phase is a security invalidation.
UPDATE sessions
   SET status = 'invalidated',
       terminated_at = COALESCE(terminated_at, revoked_at),
       termination_reason = COALESCE(termination_reason, 'operator_terminated')
 WHERE revoked_at IS NOT NULL AND status = 'active';

CREATE UNIQUE INDEX idx_sessions_mcp_id ON sessions (mcp_session_id) WHERE mcp_session_id IS NOT NULL;
CREATE INDEX idx_sessions_credential ON sessions (credential_id);
CREATE INDEX idx_sessions_status ON sessions (status);
CREATE INDEX idx_sessions_last_activity ON sessions (last_activity_at);

-- Ownership is immutable. Application code never updates these columns, but a
-- single mistaken UPDATE would silently move a session to another agent — the
-- exact bug this phase exists to prevent. The trigger makes it impossible, at
-- the database level, for any writer (including another gateway process).
CREATE TRIGGER sessions_identity_immutable
BEFORE UPDATE OF id, agent_id, credential_id, mcp_session_id, created_at ON sessions
FOR EACH ROW
WHEN OLD.id IS NOT NEW.id
  OR OLD.agent_id IS NOT NEW.agent_id
  OR OLD.credential_id IS NOT NEW.credential_id
  OR OLD.mcp_session_id IS NOT NEW.mcp_session_id
  OR OLD.created_at IS NOT NEW.created_at
BEGIN
  SELECT RAISE(ABORT, 'session identity is immutable');
END;

-- A session is either active with no recorded end, or finished with both an end
-- timestamp and a reason. A finished row with no timestamp would be
-- unauditable, and an active row that carries a termination would be a lie.
-- SQLite cannot add a table-level CHECK with ALTER TABLE, so this is a trigger.
CREATE TRIGGER sessions_terminal_is_complete
BEFORE INSERT ON sessions
FOR EACH ROW
WHEN (NEW.status = 'active' AND (NEW.terminated_at IS NOT NULL OR NEW.termination_reason IS NOT NULL))
  OR (NEW.status <> 'active' AND (NEW.terminated_at IS NULL OR NEW.termination_reason IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'a session end needs a timestamp and a reason, and an active session has neither');
END;

CREATE TRIGGER sessions_terminal_is_complete_on_update
BEFORE UPDATE ON sessions
FOR EACH ROW
WHEN (NEW.status = 'active' AND (NEW.terminated_at IS NOT NULL OR NEW.termination_reason IS NOT NULL))
  OR (NEW.status <> 'active' AND (NEW.terminated_at IS NULL OR NEW.termination_reason IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'a session end needs a timestamp and a reason, and an active session has neither');
END;

-- A terminated session cannot be reactivated. Without this, any UPDATE that
-- forgot a `WHERE status = 'active'` would resurrect a session that an operator
-- or a revocation had already killed.
CREATE TRIGGER sessions_no_reactivation
BEFORE UPDATE OF status ON sessions
FOR EACH ROW
WHEN OLD.status <> 'active' AND NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'a finished session cannot be reactivated');
END;
