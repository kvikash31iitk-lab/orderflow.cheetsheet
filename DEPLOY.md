# Production Deployment — orderflow.cheetsheet.tech

**Status: LIVE** at https://orderflow.cheetsheet.tech (Let's Encrypt TLS, auto-renew).

## How it's actually deployed

`orderflow.cheetsheet.tech` runs on the **shared Hostinger box** `srv1700029`
(`93.127.185.243`), which already hosts ~12 other sites behind a **host nginx +
certbot**. So this app does **not** run Caddy and does **not** own ports 80/443.
Instead it slots into the box's existing pattern:

```
browser ──HTTPS:443──> host nginx (certbot TLS, vhost: orderflow.cheetsheet.tech)
                          ├── /            -> 127.0.0.1:8101  (frontend container, Nginx SPA)
                          ├── /api/*       -> 127.0.0.1:8102  (backend container, FastAPI)
                          └── /ws          -> 127.0.0.1:8102  (backend WebSocket)
docker compose (docker-compose.vps.yml): frontend, backend, postgres, redis
```

| Piece | Location |
|---|---|
| App stack | `docker-compose.vps.yml` (frontend+backend on `127.0.0.1:8101/8102`, postgres/redis internal) |
| Code on box | `/root/orderflow` |
| Host nginx vhost | `/etc/nginx/sites-available/orderflow.cheetsheet.tech` (+ certbot-managed `:443`) |
| Repo copy of vhost | `deploy/nginx/orderflow.cheetsheet.tech.conf` |
| TLS cert | `/etc/letsencrypt/live/orderflow.cheetsheet.tech/` (auto-renews) |
| Env / secrets | `/root/orderflow/.env` (gitignored; created from `.env.example`) |

> The `Caddyfile` + `docker-compose.prod.yml` in this repo are the **clean-box**
> variant (Caddy owns 80/443). They are NOT used on this shared box — keep them
> for a dedicated host, but operate this deployment with `docker-compose.vps.yml`.

## Data feed: simulator vs live TrueData

The box currently runs the **synthetic feed** (`FORCE_SIMULATOR=true` in `.env`)
because the market was closed and the TrueData **trial** account allows only one
session (`User Already Connected`). Everything (footprint, delta, VWAP, signals,
broker) works on the synthetic feed.

**To switch to live TrueData** (during market hours, with a free session):
```bash
cd /root/orderflow
nano .env            # set FORCE_SIMULATOR=false  (and live TRUEDATA_USERNAME/PASSWORD)
docker compose -f docker-compose.vps.yml up -d --force-recreate backend
docker compose -f docker-compose.vps.yml logs -f backend   # expect source=truedata
```
`--force-recreate` is required — `restart` does NOT re-read `.env`. If TrueData is
unreachable or the session collides, startup now **falls back to the simulator
after `TRUEDATA_CONNECT_TIMEOUT_S` (20s)** instead of hanging.

## Operating the deployment (run on the VPS)
```bash
cd /root/orderflow
# health
curl -fsS https://orderflow.cheetsheet.tech/api/health
# logs / status
docker compose -f docker-compose.vps.yml logs -f backend
docker compose -f docker-compose.vps.yml ps
# restart one service (keeps env)
docker compose -f docker-compose.vps.yml restart backend
# redeploy after pulling new code
docker compose -f docker-compose.vps.yml up -d --build
# stop (keeps volumes/data); start again
docker compose -f docker-compose.vps.yml down
docker compose -f docker-compose.vps.yml up -d
```

## Redeploy from local (no git on the box)
The code was shipped as a tarball (no `.git` on the box). To push local changes:
```bash
# from the project root on your machine
tar czf /tmp/orderflow.tgz --exclude=node_modules --exclude=dist --exclude=.env \
  --exclude=__pycache__ --exclude=.git .
scp /tmp/orderflow.tgz hostinger-VPS-new:/root/orderflow.tgz
ssh hostinger-VPS-new 'cd /root/orderflow && tar xzf /root/orderflow.tgz \
  && docker compose -f docker-compose.vps.yml up -d --build'
```
(Single files can also just be `scp`'d into `/root/orderflow/...` followed by a
`--build` of the affected service.)

## ⚠️ Frontend-only deploy — ALWAYS use `--no-deps`
When you've changed **only** frontend code and must NOT disturb the live backend (its
in-memory pipeline/broker state, feed connection, and uptime), deploy with `--no-deps`:
```bash
cd /root/orderflow
docker compose -f docker-compose.vps.yml up -d --build --no-deps frontend
```
**Why `--no-deps` is mandatory here:** the `frontend` service declares `depends_on: backend`
in `docker-compose.vps.yml`, so a plain `docker compose up -d --build frontend` pulls the
backend in as a dependency and **recreates (restarts) it** — resetting backend uptime and
in-memory state even though no backend code changed. `--no-deps` builds/recreates ONLY the
named service and leaves its dependencies running untouched. (Confirm afterwards that the
backend uptime is unchanged and `/api/status` is still `connected`.)

For a backend (or backend+frontend) change, a backend restart IS expected — deploy with
`docker compose -f docker-compose.vps.yml up -d --build backend frontend` (or `backend`
alone) and say so explicitly before doing it.

## TLS / cert
Issued via `certbot --nginx -d orderflow.cheetsheet.tech` (HTTP-01). Renewal is a
systemd timer certbot installed automatically; verify with:
```bash
certbot certificates
systemctl list-timers | grep certbot
```

## Gotchas
- **Ports 80/443 belong to host nginx**, shared with other sites. Never point this
  app's compose at them; always go through the vhost. Test nginx changes with
  `nginx -t` before `systemctl reload nginx`.
- **Single backend container** — it holds in-memory pipeline + broker state. Do not
  scale it or run multiple uvicorn workers.
- **`VITE_API_URL`/`VITE_WS_URL` are baked at build time** (build args in
  `docker-compose.vps.yml`) to `https://`/`wss://orderflow.cheetsheet.tech`. To
  change the hostname you must rebuild the frontend, not just restart it.
- Trading is **simulated/paper** — no real orders or money.
