"""FRC Caster's Tool — FastAPI application."""
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from .routers import events, matches, alliances, teams

app = FastAPI(title="FRC Caster's Tool", version="1.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── API routers ─────────────────────────────────────────────
app.include_router(events.router, prefix="/api/events", tags=["Events"])
app.include_router(matches.router, prefix="/api/matches", tags=["Matches"])
app.include_router(alliances.router, prefix="/api/alliances", tags=["Alliances"])
app.include_router(teams.router, prefix="/api/teams", tags=["Teams"])

# ── No-cache middleware for JS/CSS (prevents stale browser cache) ───
class NoCacheStaticMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response: Response = await call_next(request)
        if request.url.path.endswith(('.js', '.css', '.json')):
            response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
            response.headers['Pragma'] = 'no-cache'
            response.headers['Expires'] = '0'
        return response

app.add_middleware(NoCacheStaticMiddleware)

# ── Serve frontend ──────────────────────────────────────────
frontend_dir = Path(__file__).resolve().parent.parent.parent / "docs"
app.mount("/css", StaticFiles(directory=str(frontend_dir / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(frontend_dir / "js")), name="js")
app.mount("/data", StaticFiles(directory=str(frontend_dir / "data")), name="data")


@app.get("/")
async def serve_frontend():
    return FileResponse(str(frontend_dir / "index.html"))


@app.get("/about")
async def serve_about():
    return FileResponse(str(frontend_dir / "about.html"))


@app.get("/favicon.svg")
async def serve_favicon():
    return FileResponse(str(frontend_dir / "favicon.svg"), media_type="image/svg+xml")


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


@app.get("/api/status")
async def api_status():
    """Check connectivity to TBA, FIRST FRC Events, and Statbotics APIs."""
    import asyncio
    from .services.tba_client import get_tba_client
    from .services.frc_client import get_frc_client
    from .services.statbotics_client import get_statbotics_client

    async def check_tba():
        try:
            client = get_tba_client()
            resp = await client._client().get("/status")
            return resp.status_code == 200
        except Exception:
            return False

    async def check_frc():
        try:
            client = get_frc_client()
            # A lightweight call - just fetch current season
            resp = await client._client().get("/")
            return resp.status_code == 200
        except Exception:
            return False

    async def check_statbotics():
        try:
            client = get_statbotics_client()
            resp = await client._client().get("/")
            return resp.status_code == 200
        except Exception:
            return False

    tba_ok, frc_ok, sb_ok = await asyncio.gather(check_tba(), check_frc(), check_statbotics())
    return {"tba": tba_ok, "frc": frc_ok, "statbotics": sb_ok}
