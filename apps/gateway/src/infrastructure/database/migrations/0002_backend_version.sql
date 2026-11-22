-- 0002_backend_version.sql
--
-- Optimistic concurrency for backend configuration edits.
--
-- Two admins (or a double-clicked "Save") can read the same backend and write
-- conflicting changes; last-write-wins silently discards the other edit. A
-- monotonic version lets the management API compare-and-set:
--   UPDATE backends SET ... , version = version + 1 WHERE id = ? AND version = ?
-- A stale caller gets zero changed rows and a RESOURCE_CONFLICT instead of
-- overwriting someone else's work.
--
-- Existing rows start at 1: this is metadata, not user data, so no data
-- migration is needed and no default is meaningful to the operator.

ALTER TABLE backends ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1);
