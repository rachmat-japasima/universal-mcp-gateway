# Database and Persistence Specification

## 1. Database choice

SQLite via `better-sqlite3`, with versioned SQL migrations and repository abstractions. SQL statements live only in `apps/gateway/src/infrastructure/database/`; no HTTP handler or UI code contains SQL.

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
`0003_runtime_disconnecting.sql` — rebuilds `backend_runtime` to add the `disconnecting` status (Phase 4).
`0004_agent_authentication.sql` — adds credential key id/prefix and agent auth timestamps (Phase 6).
`0005_session_isolation.sql` — adds persistent session binding, status, termination, and indexes (Phase 7).
`0006_operator_identity.sql` — operator tables (Phase 10.0).
`0007_correlation.sql` — adds `activity_events.correlation_id` (Phase 11).
`0008_managed_integrations.sql` — adds `integration_connections`, `integration_credentials`, and `activity_events.connection_id` (Phase 12, ADR-052).
`0009_connection_validation.sql` — adds nullable `integration_connections.validated_at` (Phase 13, ADR-053). Additive only; no table rebuilt, no row moved, no index (nothing filters on it). The upgrade is tested on real Phase 12 bytes: a genuine `0001`–`0008` database opens under `0009` with every row intact and `validated_at` honestly `NULL`.

### `backends`
`id`, `name`, `description`, `transport` (`stdio` | `streamable-http`), `config_json`, `enabled`, `timeout_ms`, `concurrency_mode` (`parallel` | `serialized` | `limited`), `concurrency_limit`, `version`, `created_at`, `updated_at`, `deleted_at`.

- `config_json` holds only the transport-specific body; `transport` has its own column, so the two can never disagree.
- Two `CHECK`s enforce "a limit exists iff the mode is `limited`".
- Deletion is a **tombstone** (`deleted_at`), so activity/audit rows keep a valid reference.
- `version` (migration `0002`) is `INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)`, incremented by every persisted update. The management API sends it back in `WHERE ... AND version = ?` for optimistic concurrency (ADR-028). Existing rows start at `1`; no data migration was needed because it is metadata, not user data.
- The active-name uniqueness index is partial (`WHERE deleted_at IS NULL`), so a name is reusable after a tombstone while the old row survives for history.

### `backend_runtime`
`backend_id` (PK, FK → `backends`, `ON DELETE CASCADE`), `status` (`disconnected` | `connecting` | `connected` | `unhealthy` | `disconnecting` | `error` | `disabled`), `last_connected_at`, `last_health_check_at`, `last_error_code`, `last_error_at`, `last_error_message`, `reconnect_attempts`, `updated_at`.

Configuration existing never implies a connection: a new backend starts `disconnected` (or `disabled`).

- `disconnecting` was added by migration `0003`, which rebuilds the table because SQLite cannot alter a `CHECK`. Every row is copied verbatim; the rebuild runs inside the migration runner's transaction.
- The table holds **only** a truthful status. No pid, command, URL, header, or client object is stored.
- `last_error_code` is constrained to the three codes the column means (`BACKEND_CONNECTION_ERROR`, `BACKEND_TIMEOUT`, `BACKEND_UNAVAILABLE`); `last_error_message` is capped at 500 characters by a `CHECK`.
- `reconnect_attempts` belongs to one reconnect sequence. It is reset on an explicit connect/reconnect and on startup recovery, so it cannot accumulate across process lifetimes.
- Legal transitions are declared in `apps/gateway/src/domain/backend-runtime.ts` (`BACKEND_TRANSITIONS`) and enforced by the lifecycle manager, which refuses to persist an edge the table's history cannot explain.
- **Startup recovery:** a persisted `connected`/`connecting`/`unhealthy`/`disconnecting` is a claim by a process that no longer exists. Recovery rewrites it to `disconnected` (or `disabled`) without reconnecting.

### `agents`
`id`, `name`, `description`, `client_type`, `enabled`, `created_at`, `updated_at`, `last_seen_at`, `last_authenticated_at`, `metadata_json`, `deleted_at`.

No token material. Tombstoned on delete.

- `last_authenticated_at` (Phase 6) is written on every successful credential verification. It is separate from `last_seen_at`, which remains Phase 2 scaffolding and is not read or written by anything.
- `metadata_json` (Phase 6) is a flat primitive map, validated by Zod and bounded like audit metadata. It is operator annotation, never an authorization input.

### `agent_credentials`
`id`, `agent_id` (FK → `agents`, cascade), `credential_hash`, `token_prefix`, `hash_key_id`, `label`, `created_at`, `expires_at`, `last_used_at`, `revoked_at`.

- `credential_hash` is a lowercase hex digest (`CHECK length = 64`, unique index). A raw token is never stored. Phase 2 defined the column as SHA-256; Phase 6 fills it with **HMAC-SHA-256**, which has the same 64-hex shape, so no data migration was needed or possible.
- `token_prefix` (Phase 6) is the first 12 characters of the token, for operator recognition only. It is not sufficient to authenticate and is never compared against anything.
- `hash_key_id` (Phase 6) names the key that produced the digest. A credential whose key id the running process does not hold is refused rather than verified on the digest alone. Rows written before Phase 6 have `NULL` and can never authenticate.
- No `status` column: status is **derived** from `revoked_at` / `expires_at`, so it cannot contradict them.
- No delete path. Revocation is a timestamp.

### `policies` / `agent_policy_assignments`
`policies`: `id`, `name` (unique), `description`, `priority`, `rules_json`, `created_at`, `updated_at`.
`agent_policy_assignments`: `(agent_id, policy_id)` PK, both FKs `ON DELETE CASCADE`, `created_at`.

Policies are shared objects; assignment does not copy them. Default deny is structural — no matching rule means no access.

Precedence lives in `apps/gateway/src/domain/policy.ts` and is not encoded in SQL: system restrictions → highest `priority` → deny over allow at equal priority → policy id → rule index. `priority` is copied into the comparator explicitly so an operator's ordering beats the deny preference, and ties are order-independent.

`GET /api/v1/policies?backendId=` is answered in SQL, not after slicing a page: `EXISTS (SELECT 1 FROM json_each(rules_json) …)` matches a `backend` rule targeting that id or `*`. `json_valid` guards a hand-edited row. Doing it in the query is what keeps `pagination.total` honest.

### `sessions`
`id`, `agent_id` (FK → `agents`, cascade), `created_at`, `last_activity_at`, `expires_at`, `revoked_at`, `metadata_json`, plus (Phase 7) `mcp_session_id`, `credential_id` (FK → `agent_credentials`, `ON DELETE SET NULL`), `status`, `terminated_at`, `termination_reason`.

Two identifiers, deliberately distinct:

| Column | Meaning |
| --- | --- |
| `id` | the gateway's internal handle. Never sent to an MCP client; used by the management API and the audit trail. |
| `mcp_session_id` | the protocol id the SDK issued at initialization and the client echoes in `mcp-session-id`. `UNIQUE` where not null, so one protocol session cannot belong to two agents. |

- `status` is `active` \| `expired` \| `terminated` \| `invalidated`, written explicitly. A terminal status is authoritative: it cannot be overridden by a clock. A lapsed `expires_at` or idle deadline still reads and behaves as `expired` before the sweep writes it back (`sessionStatus()` in `apps/gateway/src/domain/session.ts`).
- `credential_id` records *which* credential opened the session. A revocation ends exactly those sessions rather than every session the agent has.
- Identity columns (`id`, `agent_id`, `credential_id`, `mcp_session_id`, `created_at`) are immutable. `0005` enforces this with a `BEFORE UPDATE` trigger, so no code path — including another gateway process — can move a session to a different agent.
- `sessions_no_reactivation` refuses any update that would turn a finished session back into `active`.
- `sessions_terminal_is_complete` (insert and update) requires a finished row to carry both `terminated_at` and `termination_reason`, and an active row to carry neither. SQLite cannot add a table-level `CHECK` with `ALTER TABLE`, so this is a trigger.
- Rows are never deleted, including by cleanup: the audit trail must still resolve. `metadata_json` holds client type/version, protocol version, and remote address — never a token, header, or transport object.
- `revoked_at` is kept from `0001` (additive rule) and was back-filled into `status = 'invalidated'` with `terminated_at = revoked_at` on upgrade.

### `activity_events` (operational)
`id`, `type`, `request_id`, `agent_id` (FK `ON DELETE SET NULL`), `backend_id` (FK `ON DELETE SET NULL`), `connection_id` (plain nullable `TEXT`, migration `0008` — same pattern as `0007`: no FK, no index until a consumer exists), `tool_name`, `outcome` (`success` | `failure` | `denied`), `error_code`, `duration_ms`, `created_at`.

Never contains tool arguments or results.

A row names **one** source: the zod schema refuses a record carrying both `backend_id` and `connection_id`, so a writer bug fails at the read boundary instead of poisoning consumers (ADR-048).

### `audit_events` (administrative/security)
`id`, `actor_type` (`admin` | `agent` | `system`), `actor_id`, `action`, `target_type`, `target_id`, `result`, `request_id`, `metadata_json`, `created_at`.

Append-only: the repository interface exposes no update or delete. Administratively unreachable as well — no REST verb exists on `/api/v1/audit` except `GET`.

`metadata_json` is read by `findById` and omitted by `query`. The list view (`AuditListItem`) has no metadata field at all, so a collection response cannot carry free-form context by accident; reading one record is the deliberate disclosure boundary.

### `admin_users` (Phase 10.0)
`id`, `username` (unique), `display_name`, `password_hash`, `role` (`owner` | `admin` | `viewer`), `enabled`, `created_at`, `updated_at`, `password_changed_at`, `last_login_at`, `failed_login_attempts`, `locked_until`, `disabled_at`.

Created in `0001` as a table only; `0006` extends it additively (no rebuild, no dropped row) and makes it live. Migration `0006` adds the security columns and a unique index on `username`.

`password_hash` is `scrypt$N$r$p$salt$hash` — the cost parameters travel *inside* the stored string, so raising them later applies to new hashes without invalidating old ones. The plaintext password is never stored, and no repository method returns `passwordHash` to an API layer; `toPublicOperator()` strips it.

`failed_login_attempts` + `locked_until` implement lockout (5 failures → 15 minutes). `locked_until` is a timestamp rather than a boolean so a restart cannot leave an account locked forever.

There is one operator in practice. `role` stays `owner`; no RBAC engine exists (ADR-045).

### `operator_sessions` (Phase 10.0)
`id`, `operator_id` → `admin_users`, `token_hash`, `hash_key_id`, `created_at`, `last_seen_at`, `expires_at`, `revoked_at`, `revocation_reason`, `user_agent`, `ip_address`.

**Not a reuse of `sessions`.** That table's `agent_id` is `NOT NULL REFERENCES agents (id)` because it binds an *MCP protocol* session to an agent; an operator session is a different boundary. Sharing it would need either a nullable `agent_id` (weakening the MCP invariant) or an operator row in `agents` (blurring two security domains, which ADR-044 forbids). No foreign key connects the two tables.

`token_hash` is an HMAC-SHA-256 digest of the cookie value, keyed by `CREDENTIAL_HASH_SECRET` with its own `hash_key_id`; the raw token is never stored, never logged, and never a query parameter. `authenticate` rejects a session whose `hash_key_id` differs from the currently issuing key rather than silently accepting an unverifiable one.

Both an idle window (`last_seen_at`) and an absolute ceiling (`expires_at`) are stored and **derived on read**, not trusted from a sweep, so a missed cleanup cannot extend access.

### `integration_connections` (Phases 12–13)
`id` (UUID, caller-supplied), `provider_id`, `name`, `status` (`pending` | `connecting` | `connected` | `disconnected` | `error` | `reauthorization_required` | `disabled`, with a DB `CHECK`), `credential_id` (nullable reference), `metadata_json` (validated non-secret JSON), `validated_at` (nullable `TEXT`, migration `0009`), `created_at`, `updated_at`.

Created in `0008` along with the credential table and `activity_events.connection_id`; `0009` added the validation timestamp. A provider id is a registry concept, not a foreign key: a connection row survives its provider being unregistered, and the API view says so instead of pretending the provider never existed.

`status` transitions are declared as data in `apps/gateway/src/integrations/connection.ts` (`CONNECTION_TRANSITIONS`): every non-terminal status can reach `disabled`, `disabled` is the only terminal, and `error`/`reauthorization_required` exit only through an explicit operator connect. Phase 13 added the `disabled → connecting` edge (operator re-enable, ADR-053) — the DB `CHECK` enumerates statuses, not transitions, so the edge landed in code with no schema change. Anything else fails at the boundary.

`credential_id` is a vault reference only — the schema rejects anything that is not a UUID, so a pasted token string is a validation error, not a stored secret.

### `integration_credentials` (Phase 12)
`id`, `connection_id` → `integration_connections` **`ON DELETE CASCADE`**, `envelope`, `created_at`, `updated_at`.

The only column that holds credential material is `envelope`, and it holds an AES-256-GCM envelope (ADR-051): `{v, keyId, wrappedDek, wrapNonce, wrapTag, nonce, ct, tag}` — ciphertext, tags, and nonces, nothing else. The cascade is structural: a deleted connection cannot leave an orphaned secret, whatever the deletion order. There is no column that could hold plaintext, and the security suite scans the database file bytes to prove the value never appears.

Two triggers enforce the state machine: a revoked row must carry a `revocation_reason`, and a revoked session can never become live again (so a bug cannot resurrect a logged-out cookie).`user_agent`/`ip_address` are for the audit trail only — never proof of identity.

## 5. Indexes

- `backends`: unique `name` where `deleted_at IS NULL`; `enabled` where active. No index on `version`: it is only ever compared alongside the primary key. Sorting on `name`/`created_at`/`updated_at` uses the existing indexes plus an `id` tie-break; the registry is small enough that a filtered scan with a bound `LIMIT` is the right trade-off.
- `backend_runtime`: `status`.
- `agents`: unique `name` where active; `enabled`; `last_seen_at`.
- `agent_credentials`: unique `credential_hash`; `(agent_id, revoked_at)`; `expires_at`. **Phase 6 added no index:** verification looks a credential up by digest, which the unique index already serves, and policy lookup by agent uses the `agent_policy_assignments` primary key.
- `policies`: unique `name`. Assignments: `policy_id`.
- `sessions`: `agent_id`, `expires_at`, `revoked_at` from `0001`; `0005` adds a unique partial index on `mcp_session_id` (so pre-0005 rows with no protocol id stay valid) plus `credential_id`, `status`, and `last_activity_at`. The existing `agent_id`/`expires_at` indexes were not duplicated.
- The effective-status filter (`status=active|expired`) uses the column plus `expires_at` and `last_activity_at`, so both indexes are load-bearing for the API's most common query.
- `activity_events`: `created_at`, `(agent_id, created_at)`, `(backend_id, created_at)`, `(tool_name, created_at)`, `request_id`.
- `audit_events`: `created_at`, `(actor_id, created_at)`, `(action, created_at)`, `(target_id, created_at)`.
- `admin_users`: unique `username` (`0001`; `0006` re-creates it with `IF NOT EXISTS` so a database that predates it is repaired rather than assumed).
- `operator_sessions`: unique `token_hash` (the digest lookup is the only read path, so this index *is* verification); `(operator_id, last_seen_at)` for sweeping one operator; `expires_at` for cleanup.
- `integration_connections` / `integration_credentials` (Phase 12): **none, deliberately.** The listing is a full-table scan over a table that holds one row per operator-created connection (Phase 13 registered the first provider, but no honest deployment grows this table without an operator choosing to); `findById` is the primary key. `activity_events.connection_id` gets no index either — nothing queries by connection id yet, and a write-path index with no reader is amplification. Add each when a consumer exists (the same rule `0007` set for `correlation_id`).

Partial unique indexes (`WHERE deleted_at IS NULL`) allow a name to be reused after a tombstone while keeping the old row.

## 6. Migration strategy

`apps/gateway/src/infrastructure/database/migration-runner.ts`:

- Files are `NNNN_name.sql`, loaded from disk at module load and sorted by version. Duplicate or malformed versions refuse startup.
- Each migration and its `schema_migrations` row commit in **one transaction**, so a failure leaves no half-applied schema and no ledger entry.
- A SHA-256 checksum is recorded. If an already-applied file changes, startup fails: the ledger would describe a schema nobody has.
- Migrations are additive. Existing tables and data are never dropped or reset; an existing database is opened, not recreated.
- Re-running is a no-op (`skipped`), which is what makes restart safe.

Migration `0004_agent_authentication.sql` is the Phase 6 example: four `ALTER TABLE ... ADD COLUMN` statements, all nullable, no backfill, no index, no `sessions` change. Nullable was a deliberate choice — a default would have been a claim about rows issued before the column existed. A pre-Phase-6 credential row therefore has `hash_key_id = NULL` and can never authenticate, which is the honest outcome.

Migration `0005_session_isolation.sql` is the Phase 7 example, and it is the shape to copy when a phase genuinely needs new invariants:

- five `ALTER TABLE sessions ADD COLUMN` statements, no table rebuild, existing rows copied by SQLite in place;
- `status` defaults to `'active'` — the only defensible default, since a pre-0005 row that was not revoked was active;
- one `UPDATE` back-fills revoked rows to `invalidated` with `terminated_at = revoked_at`, so an upgraded database means the same thing it did before;
- four indexes and four triggers. Triggers are used because SQLite cannot add a table-level `CHECK`, and because the invariants they encode (immutability, no reactivation, a complete terminal row) must hold for *every* writer, not just this process.

`/tmp/opencode/verify-0005.ts` is the upgrade check that was actually run: it seeds a real 0004 database with raw SQL (the current repositories write Phase-7 columns, so using them would prove nothing), upgrades, and asserts data preservation, the back-fill, every index and trigger, and that a second open is a no-op.

`.sql` files are not TypeScript output, so `pnpm build` runs `build:migrations` to copy them next to the compiled runner.

Migration `0006_operator_authentication.sql` is the Phase 10.0 example, and it is purely additive on top of an existing table:

- seven `ALTER TABLE admin_users ADD COLUMN` statements — five nullable, one `NOT NULL DEFAULT 0` (`failed_login_attempts`, whose default is the honest reading of "no recorded failures"), one nullable time (`locked_until`);
- one unique index on `admin_users (username)` created with `IF NOT EXISTS`, so a database that predates the index is repaired rather than assumed;
- one new table, `operator_sessions`, with a unique `token_hash` index and two indexes for sweeping and cleanup;
- two triggers: a revoked row must carry a reason, and a revoked session can never become live again.

No `sessions` change, no table rebuild, and no row dropped. The `operator_sessions` table is separate from `sessions` because `sessions.agent_id` is `NOT NULL REFERENCES agents (id)` — see §4.

`apps/gateway/tests/database.test.ts` asserts the applied version reaches `0006` and that `operator_sessions` exists.

Migration `0007_activity_correlation.sql` is the Phase 11 example — one
statement, the smallest kind:

- one `ALTER TABLE activity_events ADD COLUMN correlation_id TEXT` — nullable,
  no default, no index. It is a log-correlation join key, not a filter
  column: reads locate rows by `after`/`before` ranges or by request id, and
  a correlation-id index would be write-amplification for a lookup nobody
  performs.

No other table changes; audit deliberately does not gain the column — the
security trail records who did what under the gateway's own request id, not
the caller's trace id. `apps/gateway/tests/database.test.ts` asserts the applied version
reaches `0007`.

## 7. Repository interfaces

Declared in `apps/gateway/src/domain/repositories.ts` in domain terms — no SQL, no driver types, no transaction handles. Implementations live in `apps/gateway/src/infrastructure/database/repositories/`.

| Interface | Implemented operations |
| --- | --- |
| `BackendRepository` | create, findById, findByName, list, query, update, softDelete, countActive, counts |
| `BackendRuntimeRepository` | upsert, findByBackendId |
| `AgentRepository` | create, findById, findByName, list, query, update, touchAuthentication, softDelete, countActive, counts |
| `CredentialRepository` | create, findById, findByHash, listByAgentId, revoke, touch, revokeAllForAgent |
| `PolicyRepository` | create, findById, findByName, list, query, update, delete, assign, unassign, listPoliciesForAgent, unassignAll |
| `SessionRepository` | create, findById, findByMcpSessionId, listByAgentId, query, touch, end, endWhere, expire, count, countByStatus, counts |
| `ActivityRepository` | append, list, findById, query, count, countByType, countByOutcome |
| `AuditRepository` | append, list, findById, query, count, countByResult, countByActorType |
| `OperatorRepository` | create, findById, findByUsername, count, list, setPassword, recordLoginSuccess, recordLoginFailure, disable — and for sessions: createSession, findSessionById, findSessionByTokenHash, touchSession, revokeSession, revokeSessionsForOperator, expireSessions, countActiveSessions |
| `IntegrationConnectionRepository` (Phase 12) | create, findById, list, update, updateStatus, updateCredential, remove |
| `IntegrationCredentialRepository` (Phase 12) | create, findById, remove |

`query(criteria)` is the only listing method that filters and paginates. Every value is a bound parameter; the sort column and direction are interpolated only from a fixed whitelist (`SORT_COLUMNS`) because SQLite cannot parameterize identifiers. Ordering always tie-breaks on `id` so equal names or timestamps cannot produce unstable pages, and `total` is a separate `COUNT(*)` over the same `WHERE` before `LIMIT`.

Search uses `instr(lower(column), lower(?)) > 0` rather than `LIKE`, so `%` and `_` in user input stay literal characters instead of acting as wildcards. (Event log search uses `LIKE ... ESCAPE '\'` with the term escaped, which has the same property.)

### 7.1 Read-only aggregates (Phase 8)

The operations surface needed counts, not rows. Each is one statement, so `/overview` cannot become an N+1 as the registry grows:

| Method | Statement shape |
| --- | --- |
| `backends.counts()` / `agents.counts()` | One `SELECT COUNT(*) + SUM(CASE …)` over `WHERE deleted_at IS NULL`, returning `{ total, enabled, disabled }`. |
| `sessions.counts(now, idleCutoff)` | One scan returning per-status totals, where `active`/`expired` are derived from the same two lifetime rules `query()` filters on — so the breakdown can never contradict the list beside it. |
| `activity.countByType()` / `countByOutcome()` | `GROUP BY` one column. |
| `audit.countByResult()` / `countByActorType()` | `GROUP BY` one column. |

`EventQuery`/`AuditQuery` add filtered listing with `after`/`before` (inclusive, compared as stored ISO strings), `search`, and `order`, with the same bound-parameter and whitelisted-sort-column rules as the other queries. Two details worth knowing:

- **Audit list and detail are different reads.** `query()` returns `AuditListItem`, which has no `metadata` column; `findById()` returns the full `AuditEvent`. The detail endpoint is the disclosure boundary, and the type makes that structural rather than a convention.
- **No migration was needed for Phase 8.** `idx_activity_created`, `idx_audit_created`, and the composite `(agent_id, created_at)` / `(action, created_at)` / `(target_id, created_at)` indexes already cover the new range and filter shapes. A `0006` that only restated them would be a second index on the same column.

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

Implemented as a CLI in Phase 18, Stage B (`apps/gateway/src/cli/backup.ts`,
`apps/gateway/src/cli/restore.ts`; runbook in `docs/OPERATIONS.md`):

- **Backup:** `pnpm backup [destination]` — a `VACUUM INTO` snapshot through
  the live connection, so a running gateway is safe to back up and WAL content
  is included. The result is integrity-verified before it is called a backup,
  written mode `0600`, never overwrites, and defaults to
  `data/backups/gateway-<timestamp>.db`.
- **Restore:** `pnpm restore <file> --confirm`, local CLI only (never an HTTP
  surface), with the gateway stopped. Refuses without `--confirm`, refuses a
  target with `-wal`/`-shm` present (a crashed or live process), refuses a
  corrupt source, and refuses a backup from a newer gateway (unknown migration
  version). The previous database is preserved as
  `gateway.db.pre-restore-<timestamp>`; a failed restore rolls it back. The
  next open re-verifies migration checksums.
- Backups contain sealed integration credentials as inert ciphertext, not
  plaintext secrets: without `INTEGRATION_MASTER_KEY` they cannot leak, and
  cannot be restored either (`docs/SECURITY.md` §6.4).
