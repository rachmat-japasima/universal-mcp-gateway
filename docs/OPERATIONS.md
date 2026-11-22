# Operations

Phase 18. The runbook for running one gateway: lifecycle, backup and restore,
deployment, and the soak harness. Monitoring is `docs/MONITORING.md`; schema
and migration policy are `docs/DATABASE.md`; security posture is
`docs/SECURITY.md`.

## 1. Lifecycle

- **Start.** `pnpm build && pnpm start` (or `pnpm dev` for development). The
  gateway binds a loopback address only; a non-loopback `HOST` is refused at
  config load.
- **Stop.** `SIGINT` or `SIGTERM`. Shutdown is a **bounded drain**, not an
  indefinite wait:
  1. idle keep-alive connections are reaped immediately — the common case is
     an instant stop;
  2. in-flight requests get ~5 s (`SHUTDOWN_DRAIN_LIMIT_MS` in `apps/gateway/src/index.ts`);
  3. whatever is still open at the deadline is force-closed, with the ordered
     teardown (sessions → transports → store) still completing afterwards.

  The regression that pins this is `apps/gateway/tests/shutdown-drain.test.ts`: a client
  whose request can never finish used to hold `server.close()` open forever.
- **Startup failure** (bad key material, taken port, unwritable database)
  logs the reason and exits 1; it never becomes an unhandled crash with no
  cause.
- **After an unclean shutdown** (kill -9, power loss, `wsl --shutdown`), start
  normally: SQLite's WAL keeps the database crash-safe, and startup recovery
  rewrites any persisted live state to `disconnected`/`disabled` without
  reconnecting anything. Then check `/ready` and
  `/api/v1/monitoring/backends`.

## 2. Backup

```sh
pnpm backup            # → data/backups/gateway-<timestamp>.db
pnpm backup /path/to/snapshot.db
```

The gateway can stay running: the snapshot is taken with `VACUUM INTO` through
the live connection, so committed content still sitting in the WAL is included
and no torn page is possible. The result is verified (`PRAGMA quick_check`)
before it is called a backup, written mode `0600`, and never overwrites an
existing file. A failed run leaves nothing behind.

Sealed integration credentials ride along as **inert ciphertext**
(`docs/SECURITY.md` §6.4): a backup file without `INTEGRATION_MASTER_KEY`
cannot leak them, and cannot restore them either.

## 3. Restore

```sh
pnpm restore <backup-file.db> --confirm
```

Run it **with the gateway stopped**. Restore is a **local CLI only — it is
deliberately not an HTTP surface**, so no authenticated remote caller can ever
replace the database under a running gateway. Refusals come back as exit 2,
failures as exit 1:

- no `--confirm` → refuses, touches nothing;
- a `-wal`/`-shm` file at the target → refuses: after a clean stop those can
  only mean a crashed or still-running process;
- a corrupt or unreadable backup → refuses before touching the target;
- a backup containing an unknown, newer migration version → refuses ("from a
  newer gateway"): restoring it would brick the next startup.

A successful restore **preserves the previous database** as
`gateway.db.pre-restore-<timestamp>` — delete it once the restored state is
confirmed good. A failure at any step rolls the previous database back into
place. The next startup re-verifies migration checksums on open. Test on a
copy first if the stakes are high; the preservation file makes that cheap.

## 4. Deployment

`deployment/` holds the Phase 18 artifacts: `docker/Dockerfile` and
`docker/docker-compose.yml`, a systemd unit example under `systemd/`, and WSL2
notes (`deployment/README.md`). The one fact that
shapes all of them: **the gateway is loopback-only by design**, so containers
run with host networking and standard bridge publishing is refused by
configuration, not by accident. Those artifacts are written against the
verified build but are themselves **NOT VERIFIED** — they have not been built
or run.

## 5. Soak

```sh
pnpm soak --profile=ci
```

Steady bounded load against a real spawned gateway with a **mock stdio
backend** (`apps/gateway/tests/fixtures/mcp-fixture.ts`) — no real provider is ever
contacted. Deliberately **not** part of `pnpm verify`; CI runs it as its own
step. The pass gate is narrow and honest: more than 1% failed calls, a
crashed gateway, or an unclean shutdown fails the run; everything else is
reported as measured numbers, plus an explicit **NOT MEASURED** list (window
length, saturation, backend-failure churn, CPU/event-loop). The CI profile
measured, on one dev machine, ~8.3k calls in 90 s, flat latency
(p50 ≈ 18 ms, p95 ≈ 28 ms), zero failures, clean drain, and RSS growth that
was partially reclaimed at idle — see §7 before quoting it.

## 6. Versioning

The gateway is **0.x on purpose**. The version lives in exactly two places —
`apps/gateway/package.json` and `SERVICE_INFO` (`apps/gateway/src/shared/service.ts`) — and
`apps/gateway/tests/version.test.ts` fails the suite if they drift. The 1.0.0 this
replaced was a placeholder, not an API-stability promise; 1.0.0 means a
compatibility commitment nobody has made yet.

## 7. Known gaps and accepted risks

The honest register — each line is a decision, not an accident:

- **`REQUEST_TIMEOUT_MS` is a displayed-but-unenforced knob.** It validates in
  config and appears in `/settings`, but nothing reads it to bound a request.
  Real request bounds today: `REQUEST_BODY_LIMIT_BYTES`, and the per-tool
  `TOOL_DISCOVERY_TIMEOUT_MS` / `TOOL_CALL_TIMEOUT_MS` at the routing layer.
  Accepted for 0.18; a future phase either wires it or removes it.
- **No TLS, no remote exposure.** Loopback-only is the audited posture; the
  management API is behind an operator session but is not safe to expose
  (`docs/ARCHITECTURE.md` §14).
- **Retention is not implemented.** Activity and audit history grow
  monotonically (`docs/DATABASE.md` §8).
- **Deploy artifacts are NOT VERIFIED** (§4).
- **The soak window is 90 s.** The RSS growth it measured (≈ +150 MB under
  load, roughly a third reclaimed within 5 s of idle, latency flat) is
  consistent with lazy GC and is *unclassified* at longer windows — a
  multi-hour profile is the honest next step, and it does not exist yet.
- **Metrics reset on restart.** Scrape rates, not history
  (`docs/MONITORING.md`).
