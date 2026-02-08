"""FRC Caster's Tool — FastAPI application."""
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pathlib import Path

from .routers import events, matches, alliances, teams

app = FastAPI(title="FRC Caster's Tool", version="1.0.0")

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

# ── Serve frontend ──────────────────────────────────────────
frontend_dir = Path(__file__).resolve().parent.parent.parent / "frontend"
app.mount("/css", StaticFiles(directory=str(frontend_dir / "css")), name="css")
app.mount("/js", StaticFiles(directory=str(frontend_dir / "js")), name="js")


@app.get("/")
async def serve_frontend():
    return FileResponse(str(frontend_dir / "index.html"))


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}
