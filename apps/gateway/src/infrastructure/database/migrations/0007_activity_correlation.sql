-- 0007_activity_correlation.sql
--
-- Phase 11: correlation id on activity rows.
--
-- Additive and nullable: rows written before this migration keep `NULL`, and
-- every writer treats the field as optional context, so the column can never
-- fail an insert. No index: nothing queries by correlation id yet (the
-- dashboard filter is deferred with the phase); add one when a consumer
-- exists, so the write path does not pay for an unread index.
--
-- Why activity and not audit: an activity row answers "what did the gateway
-- do" and one client task may span several requests — exactly what a
-- correlation id groups. Audit answers "who changed what" and already persists
-- the per-exchange `request_id`, which is the key accountability needs.

ALTER TABLE activity_events ADD COLUMN correlation_id TEXT;
