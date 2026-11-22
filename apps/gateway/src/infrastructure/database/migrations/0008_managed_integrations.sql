-- 0008_managed_integrations.sql
--
-- Phase 12: managed-integration foundation (ADR-048..ADR-052).
--
-- Additive only: no table is rebuilt, no column is dropped, no row moves.
-- Production stays EMPTY — no provider exists (the registry is code-only and
-- ships zero entries), and the management API exposes no write path yet.
--
-- Two tables plus one activity column:
--
--   * `integration_connections` — the connection domain. Provider ids come
--     from the code registry, not a provider table, which is why there is no
--     providers table to create here (ADR-050).
--   * `integration_credentials` — one vault envelope per stored credential.
--     `envelope` is sealed ciphertext (ADR-051): no plaintext column exists
--     anywhere in this schema, and the CHECK-free `envelope` is validated by
--     the vault on read, where tampering actually fails closed.
--   * `activity_events.connection_id` — additive, nullable, same pattern as
--     0007: a managed call names its connection, an MCP call names its
--     backend, and exactly one of the two is set per row. No index: nothing
--     queries by connection id yet; add one when a consumer exists.
--
-- Credential cleanup is structural: deleting a connection cascades to its
-- credential rows, so a deleted connection can never leave an orphaned
-- secret behind.

CREATE TABLE integration_connections (
  id             TEXT PRIMARY KEY,
  provider_id    TEXT NOT NULL,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'connecting', 'connected', 'disconnected', 'error', 'reauthorization_required', 'disabled')),
  credential_id  TEXT,
  metadata_json  TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE integration_credentials (
  id             TEXT PRIMARY KEY,
  connection_id  TEXT REFERENCES integration_connections (id) ON DELETE CASCADE,
  envelope       TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

ALTER TABLE activity_events ADD COLUMN connection_id TEXT;
