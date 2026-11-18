# Database and Persistence Specification

## 1. Database choice

SQLite using `better-sqlite3` is the agreed local persistence layer. Use schema migrations and repository abstractions. Do not spread SQL statements across HTTP handlers or UI code.

## 2. Design rules

- Stable primary keys.
- Foreign keys enabled.
- Transactional mutations.
- UTC timestamps in a consistent format.
- Explicit indexes for common filters.
- Separate configuration definitions from ephemeral runtime state.
- Do not persist live MCP transport/process objects.
- Avoid storing sensitive tool payloads.
- Version every schema change through migrations.

## 3. Proposed tables

### `backends`
- `id` TEXT PRIMARY KEY
- `name` TEXT NOT NULL
- `description` TEXT
- `transport` TEXT NOT NULL
- `config_json` TEXT NOT NULL (must contain secret references, not plaintext secrets)
- `enabled` INTEGER NOT NULL
- `timeout_ms` INTEGER NOT NULL
- `concurrency_mode` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

### `backend_runtime`
- `backend_id` TEXT PRIMARY KEY REFERENCES backends(id)
- `status` TEXT NOT NULL
- `last_connected_at` TEXT
- `last_health_check_at` TEXT
- `last_error_code` TEXT
- `last_error_at` TEXT
- `reconnect_attempt` INTEGER NOT NULL DEFAULT 0
- `updated_at` TEXT NOT NULL

### `agents`
- `id` TEXT PRIMARY KEY
- `name` TEXT NOT NULL
- `client_type` TEXT
- `description` TEXT
- `status` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL
- `last_seen_at` TEXT

### `agent_credentials`
- `id` TEXT PRIMARY KEY
- `agent_id` TEXT NOT NULL REFERENCES agents(id)
- `token_hash` TEXT NOT NULL
- `label` TEXT
- `created_at` TEXT NOT NULL
- `expires_at` TEXT
- `revoked_at` TEXT

### `admin_users`
- `id` TEXT PRIMARY KEY
- `username` TEXT NOT NULL UNIQUE
- `password_hash` TEXT NOT NULL
- `role` TEXT NOT NULL
- `status` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

### `policies`
- `id` TEXT PRIMARY KEY
- `name` TEXT NOT NULL
- `description` TEXT
- `effect` TEXT NOT NULL
- `rules_json` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

### `agent_policy_assignments`
- `agent_id` TEXT NOT NULL REFERENCES agents(id)
- `policy_id` TEXT NOT NULL REFERENCES policies(id)
- `created_at` TEXT NOT NULL
- PRIMARY KEY (`agent_id`, `policy_id`)

### `sessions`
- `id` TEXT PRIMARY KEY
- `agent_id` TEXT REFERENCES agents(id)
- `started_at` TEXT NOT NULL
- `last_activity_at` TEXT NOT NULL
- `expires_at` TEXT
- `revoked_at` TEXT
- `metadata_json` TEXT

### `activity_events`
- `id` TEXT PRIMARY KEY
- `request_id` TEXT
- `agent_id` TEXT
- `backend_id` TEXT
- `tool_name` TEXT
- `status` TEXT NOT NULL
- `duration_ms` INTEGER
- `error_code` TEXT
- `created_at` TEXT NOT NULL

### `audit_events`
- `id` TEXT PRIMARY KEY
- `actor_type` TEXT NOT NULL
- `actor_id` TEXT
- `action` TEXT NOT NULL
- `target_type` TEXT
- `target_id` TEXT
- `result` TEXT NOT NULL
- `request_id` TEXT
- `metadata_json` TEXT
- `created_at` TEXT NOT NULL

## 4. Indexes

At minimum:
- backends by enabled/status.
- agents by status and last_seen_at.
- credentials by agent_id and revoked_at.
- policy assignments by agent_id and policy_id.
- sessions by agent_id, expires_at, revoked_at.
- activity by created_at, agent_id, backend_id, tool_name, request_id.
- audit by created_at, actor_id, action, target_id.

## 5. Retention

Define configurable retention for activity and operational events. Audit retention should be longer and separately configurable. Do not delete audit data silently. Any cleanup process must be bounded and observable.

## 6. Migration and backup

- Migration files are ordered and immutable once applied.
- Record applied migration version.
- Back up database using a SQLite-safe mechanism.
- Test restore on a copy before replacing active database.
- Do not include unencrypted secrets in backup.
- Document recovery if encryption keys are lost.

## 7. Implementation note

This schema is a logical starting point. The coding agent must review constraints, indexes, uniqueness, deletion semantics, and migration strategy before implementing. Do not create all tables in the first coding milestone.
