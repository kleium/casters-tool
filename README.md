# Caster's Tool

A read-only **FIRST Robotics Competition (FRC)** event dashboard, built for broadcasters, commentators and FIRST Community. Displays team stats, alliance breakdowns, playoff brackets, play-by-play data, and historical context. All a caster needs at a glance!

Built by **Gürsel & [Team 9020](https://www.thebluealliance.com/team/9020)** for the community.

---

## Features

| Tab | Function |
|-----|---------------|
| **Events** | Season event picker with region & week filters, manual entry, and saved events |
| **History** | Full event lineage: past winners, finalists, awards timeline dating back to 1992 |
| **Rankings** | Live team rankings from an event with record, OPR, DPR, CCWM |
| **Summary** | Event demographics, Hall of Fame teams, Impact finalists, connections graph, top scorers |
| **Play by Play** | Match-by-match view with per-team stats and inline team comparison |
| **Breakdown** | Detailed score breakdowns per match (supports 2025 REEFSCAPE for demo & 2026 game REBUILT) |
| **Alliances** | Alliance selection cards with partnership history |
| **Playoffs** | Double-elimination bracket visualization (new format) |
| **Team Lookup** | Individual team stats, awards, season achievements & head-to-head playoff history |

Additional UI: team comparison table (up to 6 teams), international-team highlighting, dark/light theme toggle, API status indicators.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Frontend (Single-Page App)                     │
│  docs/index.html + docs/js/app.js               │
│  IndexedDB cache for instant event loading       │
└───────────────────┬─────────────────────────────┘
                    │  REST / JSON
┌───────────────────▼─────────────────────────────┐
│  Backend (FastAPI + Uvicorn)                     │
│  Async throughout — httpx + asyncio.gather       │
│  In-memory TTL caches (300s TBA, 120s FRC)       │
│  Disk snapshots in data/saved_events/            │
└──────┬────────────────────────┬─────────────────┘
       │                        │
 ┌─────▼──────┐          ┌──────▼──────┐
 │  TBA API   │          │  FRC Events │
 │  v3        │          │  API v3     │
 └────────────┘          └─────────────┘
```

**Two external data sources:**

- **The Blue Alliance (TBA) API v3** — event lists, team info, rankings, OPRs, matches, alliances, awards, media
- **FIRST FRC Events API v3** — score breakdowns, per-robot match performance, school names, avatars

**Caching strategy:**

| Layer | Mechanism | TTL |
|-------|-----------|-----|
| Backend — TBA responses | In-memory dict | 300 s |
| Backend — FRC API responses | In-memory dict | 120 s |
| Backend — Event snapshots | JSON files on disk (`data/saved_events/`) | Permanent until cleared |
| Frontend — Full event data | IndexedDB (`casters-tool-cache`) | Session-persistent |

**Pre-computed data:**

- `docs/data/region_stats.json` — region/district statistics, HoF teams, Impact finalists (generated offline by `scripts/generate_region_stats.py` scanning 1992–2026)
- `docs/data/season_2026.json` — cached season event list for fast initial load

---

## Prerequisites

- **Python 3.10+**
- A **[TBA API key](https://www.thebluealliance.com/account)** (required)
- A **FIRST FRC Events API token** (optional — enables score breakdowns, per-robot stats, school names)

---

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/kleium/casters-tool.git
cd casters-tool
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

Dependencies: `fastapi`, `uvicorn[standard]`, `httpx`, `python-dotenv`

### 3. Configure environment variables

Create a `.env` file in the project root:

```env
TBA_API_KEY=your_tba_api_key_here
FRC_EVENTS_API_TOKEN=your_base64_encoded_token_here
```

| Variable | Required | Description |
|----------|----------|-------------|
| `TBA_API_KEY` | **Yes** | Your The Blue Alliance read API key |
| `FRC_EVENTS_API_TOKEN` | No | Base64-encoded `username:authkey` for the FIRST FRC Events API v3. Without this, score breakdowns and some team details will be unavailable. |

### 4. Run the server

```bash
python run.py
```

The app starts at **http://localhost:8000**. Hot-reload is enabled by default.

---

## API Reference

All endpoints return JSON. The backend serves both the API and the static frontend.

### Health & Status

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Returns `{"status": "ok"}` |
| `GET` | `/api/status` | Checks TBA and FRC API connectivity → `{"tba": bool, "frc": bool}` |

### Events — `/api/events`

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| `GET` | `/season/{year}` | `include_offseason: bool = false` | List events for a season |
| `GET` | `/{event_key}/info` | — | Event metadata (name, city, dates, status, region) |
| `GET` | `/{event_key}/teams` | — | Teams at event with rank, record, OPR, avatar |
| `GET` | `/{event_key}/summary` | — | Demographics, HoF teams, Impact finalists, top scorers |
| `GET` | `/{event_key}/summary/refresh-stats` | — | Lighter refresh of OPR/rankings-based stats |
| `GET` | `/{event_key}/summary/connections` | `all_time: bool`, `teams: str (CSV)` | Prior playoff connections between teams |
| `GET` | `/{event_key}/compare` | `teams: str (CSV, required)` | Compare 2–6 teams (avg scores, high scores, avg RP) |
| `GET` | `/{event_key}/history` | — | Full event history with awards timeline |
| `GET` | `/{event_key}/clear-cache` | — | Clear in-memory TBA cache |
| `GET` | `/{event_key}/refresh-rankings` | — | Force-refresh rankings/OPRs/teams |
| `GET` | `/region/{region_name}/facts` | — | Pre-computed region statistics |
| `GET` | `/regions/list` | — | All known region names |

### Teams — `/api/teams`

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| `GET` | `/{team_number}/stats` | `year: int (optional)` | Full team profile: awards, banners, HoF status, season achievements, events |
| `GET` | `/head-to-head/{team_a}/{team_b}` | `year: int`, `all_time: bool` | Playoff head-to-head history between two teams |

### Matches — `/api/matches`

| Method | Path | Params | Description |
|--------|------|--------|-------------|
| `GET` | `/{event_key}/all` | — | All matches with per-team stats (play-by-play) |
| `GET` | `/{event_key}/playoffs` | — | Playoff matches with double-elimination bracket mapping |
| `GET` | `/match/{match_key}/breakdown` | — | Parsed score breakdown for a single match |
| `GET` | `/team-perf/{event_key}/{team_number}` | — | Per-match robot performance stats (FRC Events API) |

### Alliances — `/api/alliances`

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/{event_key}` | Alliance selections with per-team stats, first-time-partner detection, and partnership history |

---

## Project Structure

```
casters-tool/
├── run.py                          # Entry point — starts Uvicorn on port 8000
├── requirements.txt                # Python dependencies
├── .env                            # API keys (not committed)
│
├── backend/
│   └── app/
│       ├── main.py                 # FastAPI app, CORS, routers, static serving
│       ├── config.py               # Environment variable loading
│       ├── routers/
│       │   ├── events.py           # /api/events/* endpoints
│       │   ├── teams.py            # /api/teams/* endpoints
│       │   ├── matches.py          # /api/matches/* endpoints
│       │   └── alliances.py        # /api/alliances/* endpoints
│       └── services/
│           ├── tba_client.py       # The Blue Alliance API client (async, cached)
│           ├── frc_client.py       # FIRST FRC Events API client (async, cached)
│           ├── event_service.py    # Event listing, info, team stats, comparison
│           ├── team_service.py     # Team profiles, awards, achievements, H2H
│           ├── alliance_service.py # Alliance stats, partnership history
│           ├── summary_service.py  # Event demographics, connections, top scorers
│           ├── region_service.py   # Region facts, event history/lineage
│           └── cache_service.py    # Disk-based event snapshot persistence
│
├── docs/                           # Frontend (served as static files)
│   ├── index.html                  # Single-page app shell
│   ├── css/styles.css              # Full stylesheet (dark/light themes)
│   ├── js/
│   │   ├── app.js                  # UI controller (~4,000 lines)
│   │   ├── api.js                  # Backend API wrapper
│   │   └── cache.js                # IndexedDB event cache
│   └── data/
│       ├── region_stats.json       # Pre-computed region statistics
│       └── season_2026.json        # Cached season event list
│
├── data/
│   └── saved_events/               # Disk-persisted event snapshots (JSON)
│
└── scripts/
    └── generate_region_stats.py    # Offline script to rebuild region_stats.json
```

---

## Scripts

### `scripts/generate_region_stats.py`

Rebuilds `docs/data/region_stats.json` by scanning **all FRC events from 1992 to the current year** via TBA. Tracks:

- Total teams, rookies, HoF inductees, Impact/Chairman's Award finalists per region
- Einstein appearances per region
- International visitor patterns

Run manually when you need to refresh historical data:

```bash
TBA_API_KEY=your_key python scripts/generate_region_stats.py
```

---

## Development

The server runs with **hot-reload enabled** — edit any backend file and it restarts automatically. Frontend files are served statically from `docs/`, so changes to HTML/CSS/JS are picked up on browser refresh.

### Key design decisions

- **Fully async**: All API calls use `httpx.AsyncClient` with `asyncio.gather` for parallel fetching
- **Game-year aware**: Score breakdown parsing detects the season and applies the correct field mappings (2025 REEFSCAPE, 2026+)
- **Event code aliases**: Extensive mapping handles TBA event code migrations since 1992, so event history tracks correctly even when codes change
- **Region resolution**: Events are assigned to regions via district affiliation → country → US state grouping, with pre-district era merging (e.g., Israel events merge into "FIRST Israel")

---

## License

This project is intended for use by the FIRST Robotics Competition community.
