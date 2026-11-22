-- 0004_agent_authentication.sql
--
-- Phase 6: agent credentials become real, keyed digests.
--
-- Additive only. Every existing row keeps its values; nothing is dropped or
-- rebuilt. Two nullable columns are enough because:
--
--   * `agent_credentials.credential_hash` already holds a 64-char lowercase hex
--     digest. Phase 2 defined it as SHA-256, Phase 6 fills it with HMAC-SHA-256.
--     The storage shape is identical, so no data migration is possible or needed.
--     A pre-Phase-6 row (issued only by tests) simply never verifies, because the
--     verifier requires a matching key id and those rows have none.
--   * `token_prefix` and `hash_key_id` are metadata for the operator and for key
--     rotation. Both are nullable so the column can be added without a default
--     that would be a lie about rows issued before it existed.
--
-- indexes: none added. Authentication looks a credential up by digest, which the
-- UNIQUE index `idx_agent_credentials_hash` already serves; policy lookup by
-- agent uses the `agent_policy_assignments` primary key `(agent_id, policy_id)`.
-- A new index here would duplicate an existing one.
--
-- The `sessions` table is intentionally untouched: Phase 6 re-authenticates every
-- HTTP exchange and does not persist session-to-agent binding (Phase 7).

ALTER TABLE agent_credentials ADD COLUMN token_prefix TEXT;
ALTER TABLE agent_credentials ADD COLUMN hash_key_id TEXT;

-- Free-form operator annotation (flat primitives, bounded, validated by Zod
-- before it is stored). Nullable because existing rows have none.
ALTER TABLE agents ADD COLUMN metadata_json TEXT;

-- An agent's "last authenticated" instant. Distinct from the (unused)
-- `last_seen_at`: that column was Phase 2 scaffolding and is left in place so
-- this migration stays purely additive, but nothing reads or writes it.
ALTER TABLE agents ADD COLUMN last_authenticated_at TEXT;
