-- 0009_connection_validation.sql
--
-- Phase 13: the first real managed provider (GitHub, ADR-053).
--
-- Additive only: one nullable column, no table is rebuilt, no row moves.
--
--   * `integration_connections.validated_at` — when the connection last
--     proved its credential against its provider (the transition to
--     `connected`). Nullable by meaning: `pending` and `error` rows have
--     never validated anything. Read by the management API detail view; no
--     index, because nothing filters on it.
--
-- No other change: the connection domain gained a `disabled → connecting`
-- edge in Phase 13 (operator re-enable), but lifecycle edges live in code
-- (`src/integrations/connection.ts`), and the DB CHECK enumerates statuses,
-- not transitions — both were already open enough to hold the new edge.

ALTER TABLE integration_connections ADD COLUMN validated_at TEXT;
