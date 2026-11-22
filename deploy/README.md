# Deploying the Universal MCP Gateway

Phase 18, Stage C artifacts. **Everything here is written against the
repository's real surface (`dist/index.js` was verified locally to boot,
serve, and drain on SIGTERM), but the container and unit files themselves are
NOT VERIFIED — none of them was built, run, or installed in the environment
that produced this repository.** Expect small adjustments on first use.

## The one constraint that shapes everything

The gateway is **loopback-only by design**: configuration refuses any
non-loopback `HOST` at startup, and the management API re-checks the socket
address on every request. It is a local MCP gateway for local agents, not a
network service. Consequences:

- Standard bridge networking with published ports **cannot** serve it — that is
  the security posture working as intended, not a defect.
- Containers must run with host networking (`--network host` /
  `network_mode: host`), which keeps the served surface exactly `127.0.0.1`.

## Files

| File | Purpose |
| --- | --- |
| `Dockerfile` | Container image; `pnpm build` in-image, then `node dist/index.js`. |
| `docker-compose.yml` | Host-networked service, named volume at `/app/data`, node-based healthcheck. |
| `umg-gateway.service` | systemd unit example; copy and edit, nothing is installed for you. |

## Docker

```sh
cd deploy
export CREDENTIAL_HASH_SECRET=$(openssl rand -base64 32)   # required in production
docker compose up -d --build
curl http://127.0.0.1:8787/health
```

Docker Engine on Linux, including inside WSL2, supports host networking.
Docker Desktop on macOS does not — run the gateway directly there instead.

Backups from inside the container use the built CLI:
`docker compose exec umg-gateway node dist/cli/backup-main.js` (NOT VERIFIED —
same code path as the verified `pnpm backup`, but never executed in a
container). Restores must run with the gateway stopped, which in compose means
`docker compose stop` first; see `docs/DATABASE.md` §9.

## systemd

```sh
sudo cp deploy/umg-gateway.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now umg-gateway
```

`systemctl stop` sends SIGTERM; the gateway drains in bounded fashion (idle
connections reaped at once, in-flight requests ~5s, then force-close with the
ordered teardown still completing). `TimeoutStopSec=10` in the unit matches that
bound so systemd never escalates to SIGKILL mid-teardown.

## WSL2

Three ways to run, nothing installed for you:

1. **Plain (recommended):** `pnpm build && pnpm start` from a repository
   checkout. Ctrl+C (SIGINT) and SIGTERM both take the bounded drain path —
   no WSL-specific workaround is needed, which is the point: the drain never
   waits on a socket forever, so shutdowns that used to hang a WSL session
   return promptly.
2. **Docker:** Docker inside WSL2 is a Linux engine; host networking works as
   documented above.
3. **systemd:** only if systemd is enabled in the distro
   (`[boot] systemd=true` in `/etc/wsl.conf`, then `wsl --shutdown` from
   Windows to apply — a user action, not something this repo does).

One WSL2 caveat: `wsl --shutdown` from Windows kills the VM without delivering
signals — no graceful drain. SQLite's WAL keeps the database crash-safe, but
in-flight requests and operator sessions are dropped. Stop the gateway with a
signal first whenever it matters.
