"""FIRST FRC Events API v3 async client with in-memory caching."""
from __future__ import annotations

import time
from typing import Any, Optional

import httpx

from ..config import FRC_EVENTS_API_TOKEN

FRC_BASE = "https://frc-api.firstinspires.org/v3.0"
CACHE_TTL = 120  # seconds – fresher than TBA for live events


class FRCClient:
    """Thin async wrapper around the official FIRST FRC Events REST API."""

    def __init__(self) -> None:
        self.headers = {
            "Authorization": f"Basic {FRC_EVENTS_API_TOKEN}",
            "Accept": "application/json",
        }
        self._cache: dict[str, tuple[float, Any]] = {}
        self._http: Optional[httpx.AsyncClient] = None

    def _client(self) -> httpx.AsyncClient:
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(
                base_url=FRC_BASE,
                headers=self.headers,
                timeout=30.0,
            )
        return self._http

    async def get(self, endpoint: str) -> Any:
        now = time.time()
        if endpoint in self._cache:
            ts, data = self._cache[endpoint]
            if now - ts < CACHE_TTL:
                return data

        resp = await self._client().get(endpoint)
        resp.raise_for_status()
        data = resp.json()
        self._cache[endpoint] = (now, data)
        return data

    def clear_cache(self) -> None:
        self._cache.clear()

    # ── Score Details ────────────────────────────────────
    async def get_scores(
        self, season: int, event_code: str, level: str = "Qualification",
        match_number: int | None = None,
    ) -> list[dict]:
        """Return MatchScores array from the score details endpoint."""
        url = f"/{season}/scores/{event_code}/{level}"
        if match_number is not None:
            url += f"?matchNumber={match_number}"
        data = await self.get(url)
        return data.get("MatchScores", [])

    # ── Match Results ────────────────────────────────────
    async def get_matches(
        self, season: int, event_code: str,
        level: str | None = None,
        team_number: int | None = None,
    ) -> list[dict]:
        """Return Matches array from the match results endpoint."""
        url = f"/{season}/matches/{event_code}"
        params = []
        if level:
            params.append(f"tournamentLevel={level}")
        if team_number is not None:
            params.append(f"teamNumber={team_number}")
        if params:
            url += "?" + "&".join(params)
        data = await self.get(url)
        return data.get("Matches", [])

    # ── Events ───────────────────────────────────────────
    async def get_events(self, season: int) -> list[dict]:
        data = await self.get(f"/{season}/events")
        return data.get("Events", [])

    # ── Teams ────────────────────────────────────────────
    async def get_event_teams(
        self, season: int, event_code: str,
    ) -> list[dict]:
        """Return teams at an event with organization/school info."""
        data = await self.get(f"/{season}/teams?eventCode={event_code}")
        return data.get("teams", [])


# ── Singleton ───────────────────────────────────────────────
_client: Optional[FRCClient] = None


def get_frc_client() -> FRCClient:
    global _client
    if _client is None:
        _client = FRCClient()
    return _client
