# Database and Persistence Specification

## 1. Database choice

SQLite via `better-sqlite3`, with versioned SQL migrations and repository abstractions. SQL statements live only in `src/infrastructure/database/`; no HTTP handler or UI code contains SQL.

Verified against the installed driver: SQLite 3.54.1, `foreign_keys` ON, WAL available.

## 2. Design rules

- Stable primary keys: application-generated UUIDv4, stored as `TEXT`.
- Foreign keys enforced on **every** connection (`foreign_keys` is per-connection in SQLite, not persisted in the file).
- Timestamps are UTC ISO-8601 `TEXT` (`2026-11-18T02:38:03.398Z`), comparable as strings.
- Booleans are `INTEGER` 0/1 with a `CHECK`.
- JSON columns hold validated, non-secret payloads only. Secrets are references (`secret:<path>`, `env:<VAR>`).
- Separate configuration (`backends`) from ephemeral runtime state (`backend_runtime`). No live transport, process, or MCP client objects are persisted.
- Every schema change goes through a new migration; applied migrations are immutable.
- The initial database is empty. No seed data, no fabricated history (ADR-002).

## 3. Connection settings

`openDatabase()` applies, on every open:

| Pragma | Value | Why |
| --- | --- | --- |
| `foreign_keys` | `ON` | Silent FK bypass is the default otherwise |
| `journal_mode` | `WAL` (file DBs only) | Readers never block the writer |
| `synchronous` | `FULL` | Audit history survives a crash |
| `busy_timeout` | `5000` | Bounded wait instead of instant `SQLITE_BUSY` |
| `trusted_schema` | `OFF` | Reject rows that violate a `CHECK` |

There is exactly **one connection per process** (`openStore()`), created after configuration validation and before the HTTP socket opens.

## 4. Implemented schema

`0001_initial_schema.sql` — 11 tables. `schema_migrations` is created by the runner.
`0002_backend_version.sql` — adds `backends.version` (Phase 3).

### `backends`
`id`, `name`, `description`, `transport` (`stdio` | `streamable-http`), `config_json`, `enabled`, `timeout_ms`, `concurrency_mode` (`parallel` | `serialized` | `limited`), `concurrency_limit`, `version`, `created_at`, `updated_at`, `deleted_at`.

- `config_json` holds only the transport-specific body; `transport` has its own column, so the two can never disagree.
- Two `CHECK`s enforce "a limit exists iff the mode is `limited`".
- Deletion is a **tombstone** (`deleted_at`), so activity/audit rows keep a valid reference.
- `version` (migration `0002`) is `INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)`, incremented by every persisted update. The management API sends it back in `WHERE ... AND version = ?` for optimistic concurrency (ADR-028). Existing rows start at `1`; no data migration was needed because it is metadata, not user data.
- The active-name uniqueness index is partial (`WHERE deleted_at IS NULL`), so a name is reusable after a tombstone while the old row survives for history.

### `backend_runtime`
`backend_id` (PK, FK → `backends`, `ON DELETE CASCADE`), `status` (`disconnected` | `connecting` | `connected` | `unhealthy` | `error` | `disabled`), `last_connected_at`, `last_health_check_at`, `last_error_code`, `last_error_at`, `last_error_message`, `reconnect_attempts`, `updated_at`.

Configuration existing never implies a connection: a new backend starts `disconnected` (or `disabled`).

### `agents`
`id`, `name`, `description`, `client_type`, `enabled`, `created_at`, `updated_at`, `last_seen_at`, `deleted_at`.

No token material. Tombstoned on delete.

### `agent_credentials`
`id`, `agent_id` (FK → `agents`, cascade), `credential_hash`, `label`, `created_at`, `expires_at`, `last_used_at`, `revoked_at`.

- `credential_hash` is a lowercase hex SHA-256 digest (`CHECK length = 64`, unique index). A raw token is never stored.
- No `status` column: status is **derived** from `revoked_at` / `expires_at`, so it cannot contradict them.
- No delete path. Revocation is a timestamp.

### `policies` / `agent_policy_assignments`
`policies`: `id`, `name` (unique), `description`, `priority`, `rules_json`, `created_at`, `updated_at`.
`agent_policy_assignments`: `(agent_id, policy_id)` PK, both FKs `ON DELETE CASCADE`, `created_at`.

Policies are shared objects; assignment does not copy them. Default deny is structural — no matching rule means no access.

### `sessions`
`id`, `agent_id` (FK → `agents`, cascade), `created_at`, `last_activity_at`, `expires_at`, `revoked_at`, `metadata_json`.

Status derived, not stored. Phase 1 serving is stateless per exchange, so no rows are written yet.

### `activity_events` (operational)
`id`, `type`, `request_id`, `agent_id` (FK `ON DELETE SET NULL`), `backend_id` (FK `ON DELETE SET NULL`), `tool_name`, `outcome` (`success` | `failure` | `denied`), `error_code`, `duration_ms`, `created_at`.

Never contains tool arguments or results.

### `audit_events` (administrative/security)
`id`, `actor_type` (`admin` | `agent` | `system`), `actor_id`, `action`, `target_type`, `target_id`, `result`, `request_id`, `metadata_json`, `created_at`.

Append-only: the repository interface exposes no update or delete.

### `admin_users`
`id`, `username` (unique), `password_hash`, `role` (`owner` | `admin` | `viewer`), `enabled`, `created_at`, `updated_at`.

Table only; dashboard authentication is a later phase.

## 5. Indexes

- `backends`: unique `name` where `deleted_at IS NULL`; `enabled` where active. No index on `version`: it is only ever compared alongside the primary key. Sorting on `name`/`created_at`/`updated_at` uses the existing indexes plus an `id` tie-break; the registry is small enough that a filtered scan with a bound `LIMIT` is the right trade-off.
- `backend_runtime`: `status`.
- `agents`: unique `name` where active; `enabled`; `last_seen_at`.
- `agent_credentials`: unique `credential_hash`; `(agent_id, revoked_at)`; `expires_at`.
- `policies`: unique `name`. Assignments: `policy_id`.
- `sessions`: `agent_id`, `expires_at`, `revoked_at`.
- `activity_events`: `created_at`, `(agent_id, created_at)`, `(backend_id, created_at)`, `(tool_name, created_at)`, `request_id`.
- `audit_events`: `created_at`, `(actor_id, created_at)`, `(action, created_at)`, `(target_id, created_at)`.

Partial unique indexes (`WHERE deleted_at IS NULL`) allow a name to be reused after a tombstone while keeping the old row.

## 6. Migration strategy

`src/infrastructure/database/migration-runner.ts`:

- Files are `NNNN_name.sql`, loaded from disk at module load and sorted by version. Duplicate or malformed versions refuse startup.
- Each migration and its `schema_migrations` row commit in **one transaction**, so a failure leaves no half-applied schema and no ledger entry.
- A SHA-256 checksum is recorded. If an already-applied file changes, startup fails: the ledger would describe a schema nobody has.
- Migrations are additive. Existing tables and data are never dropped or reset; an existing database is opened, not recreated.
- Re-running is a no-op (`skipped`), which is what makes restart safe.

`.sql` files are not TypeScript output, so `pnpm build` runs `build:migrations` to copy them next to the compiled runner.

## 7. Repository interfaces

Declared in `src/domain/repositories.ts` in domain terms — no SQL, no driver types, no transaction handles. Implementations live in `src/infrastructure/database/repositories/`.

| Interface | Implemented operations |
| --- | --- |
| `BackendRepository` | create, findById, findByName, list, query, update, softDelete, countActive |
| `BackendRuntimeRepository` | upsert, findByBackendId |
| `AgentRepository` | create, findById, list, update, softDelete, countActive |
| `CredentialRepository` | create, findById, findByHash, listByAgentId, revoke, touch |
| `PolicyRepository` | create, findById, list, update, delete, assign, unassign, listPoliciesForAgent |
| `SessionRepository` | create, findById, listByAgentId, revoke, count |
| `ActivityRepository` | append, list, count |
| `AuditRepository` | append, list, count |

`query(criteria)` is the only listing method that filters and paginates. Every value is a bound parameter; the sort column and direction are interpolated only from a fixed whitelist (`SORT_COLUMNS`) because SQLite cannot parameterize identifiers. Ordering always tie-breaks on `id` so equal names or timestamps cannot produce unstable pages, and `total` is a separate `COUNT(*)` over the same `WHERE` before `LIMIT`.

Search uses `instr(lower(column), lower(?)) > 0` rather than `LIKE`, so `%` and `_` in user input stay literal characters instead of acting as wildcards.

`update(id, input, now, expectedVersion?)` performs a compare-and-set: with `expectedVersion` set, the statement is `UPDATE ... WHERE id = ? AND deleted_at IS NULL AND version = ?`. Zero changed rows on an existing row can only mean a stale version, which surfaces as `RESOURCE_CONFLICT`. The check and the write are the same statement, so no writer can slip between them.

Cross-cutting behavior:

- Domain schemas validate input **and** re-validate rows on read, so a malformed row is an explicit `DATABASE_ERROR`.
- Unique violations map to `RESOURCE_CONFLICT`; missing rows to `RESOURCE_NOT_FOUND`; FK/CHECK violations to `VALIDATION_ERROR`.
- Raw SQLite messages become the `cause` of an `AppError`, never the client-facing message.
- `undefined` leaves a field untouched; `null` clears a nullable one.
- `openStore().transaction(work)` commits or rolls back every write in one unit.

## 8. Retention

Not implemented. Activity and audit retention must be bounded, observable, separately authorized, and configured independently — audit kept longer. `docs/DECISIONS.md` records the append-only constraint.

Phase 3 writes audit rows for every administrative backend change and for failed configuration validation. There is no pruning job and no `DELETE`/`UPDATE` path on `audit_events`, so history grows monotonically; this is deliberate until retention is designed. Deleting a backend does not delete its audit rows (ADR-024).

## 9. Backup and recovery

- Back up with a SQLite-safe mechanism (`.backup` or `VACUUM INTO`), never by copying a live WAL database.
- Test a restore on a copy before replacing the active file.
- Backups must not contain unencrypted secrets; today no secret values are stored, only references.
