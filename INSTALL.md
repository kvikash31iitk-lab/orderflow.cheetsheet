# Installation Guide (Windows)

Two ways to run it: **Docker** (recommended, one command) or **manual** (more control).

---

## Option A — Docker (recommended)

### Prerequisites
- [Docker Desktop for Windows](https://www.docker.com/products/docker-desktop/)
  (WSL2 backend). Make sure it is **running** before you start.

### Steps
```powershell
# from the project root
copy .env.example .env          # trial TrueData creds are already filled in
docker compose up --build
```

First boot will:
1. start **PostgreSQL** (applies `backend/app/storage/schema.sql` automatically),
2. start **Redis**,
3. build + start the **backend** (FastAPI on :8000),
4. build + start the **frontend** (Vite dev server on :5173).

Open:
- App UI → <http://localhost:5173>
- API docs → <http://localhost:8000/docs>

Stop with `Ctrl+C`, then `docker compose down` (add `-v` to wipe DB volumes).

---

## Option B — Manual (no Docker)

### Prerequisites
- **Python 3.11+**
- **Node.js 20+**
- **PostgreSQL 16** and **Redis 7** running locally
  (or set `POSTGRES_*` / `REDIS_*` in `.env` to point elsewhere).
  > The backend still runs without them — it just disables durable storage and
  > caching and logs a warning.

### 1. Database
Create the DB and load the schema:
```powershell
psql -U postgres -c "CREATE USER orderflow WITH PASSWORD 'orderflow_pw';"
psql -U postgres -c "CREATE DATABASE orderflow OWNER orderflow;"
psql -U orderflow -d orderflow -f backend\app\storage\schema.sql
```

### 2. Backend
```powershell
copy .env.example .env
# edit .env: set POSTGRES_HOST=localhost and REDIS_HOST=localhost
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### 3. Frontend
```powershell
cd frontend
npm install
npm run dev
```
Vite serves on <http://localhost:5173> and talks to the backend at
`http://localhost:8000` (override with `VITE_API_URL` / `VITE_WS_URL`).

---

## Offline / market-closed development

The trial data feed only streams during market hours. To work any time, set in `.env`:
```
FORCE_SIMULATOR=true
```
The backend then generates a realistic synthetic tick stream for all configured
symbols — footprint, delta, signals, alerts, scanner and replay all work.

---

## Verifying the install

```powershell
# backend tests (pure-python, no DB needed)
cd backend
pip install numpy pydantic pydantic-settings pytest pytest-asyncio
python -m pytest                       # 19 passing

# throughput benchmark
python -m scripts.benchmark 200000 1 2m

# frontend typecheck + build
cd ..\frontend
npm run typecheck
npm run build
```

---

## Troubleshooting

| Symptom | Fix |
|--------|-----|
| `truedata_ws` import warning, source = simulator | Expected off-hours or if creds expired (trial expires 18/06/2026). |
| Backend logs "PostgreSQL unavailable" | DB not running / wrong `POSTGRES_HOST`. App still runs degraded. |
| Frontend can't reach API | Check `VITE_API_URL`/`VITE_WS_URL` and CORS `CORS_ORIGINS` in `.env`. |
| Port already in use | Change `API_PORT` (.env) or the published ports in `docker-compose.yml`. |
| Chart empty | Wait for the first candle to form (e.g. up to 2 min on the 2m timeframe) or use a faster timeframe / simulator. |
