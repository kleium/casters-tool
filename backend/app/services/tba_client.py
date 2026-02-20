"""The Blue Alliance API v3 async client with in-memory caching."""
from __future__ import annotations

import time
from typing import Any, Optional

import httpx

from ..config import BLUE_ALLIANCE_API_KEY

TBA_BASE = "https://www.thebluealliance.com/api/v3"
CACHE_TTL = 300  # seconds


class TBAClient:
    """Thin async wrapper around TBA REST API with TTL cache."""

    def __init__(self) -> None:
        self.headers = {"X-TBA-Auth-Key": BLUE_ALLIANCE_API_KEY}
        self._cache: dict[str, tuple[float, Any]] = {}
        self._http: Optional[httpx.AsyncClient] = None

    def _client(self) -> httpx.AsyncClient:
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(
                base_url=TBA_BASE,
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

    def clear_cache_for(self, *endpoints: str) -> None:
        """Remove specific endpoints from the cache."""
        for ep in endpoints:
            self._cache.pop(ep, None)

    # ── Event endpoints ─────────────────────────────────────
    async def get_events_by_year(self, year: int):
        return await self.get(f"/events/{year}")

    async def get_event(self, event_key: str):
        return await self.get(f"/event/{event_key}")

    async def get_event_teams(self, event_key: str):
        return await self.get(f"/event/{event_key}/teams/simple")

    async def get_event_teams_full(self, event_key: str):
        return await self.get(f"/event/{event_key}/teams")

    async def get_event_rankings(self, event_key: str):
        return await self.get(f"/event/{event_key}/rankings")

    async def get_event_oprs(self, event_key: str):
        return await self.get(f"/event/{event_key}/oprs")

    async def get_event_matches(self, event_key: str):
        return await self.get(f"/event/{event_key}/matches")

    async def get_event_alliances(self, event_key: str):
        return await self.get(f"/event/{event_key}/alliances")

    # ── Team endpoints ──────────────────────────────────────
    async def get_team(self, team_key: str):
        return await self.get(f"/team/{team_key}")

    async def get_team_events(self, team_key: str, year: int):
        return await self.get(f"/team/{team_key}/events/{year}")

    async def get_team_events_statuses(self, team_key: str, year: int):
        return await self.get(f"/team/{team_key}/events/{year}/statuses")

    async def get_team_event_matches(self, team_key: str, event_key: str):
        return await self.get(f"/team/{team_key}/event/{event_key}/matches")

    async def get_team_event_status(self, team_key: str, event_key: str):
        return await self.get(f"/team/{team_key}/event/{event_key}/status")

    async def get_team_years_participated(self, team_key: str):
        return await self.get(f"/team/{team_key}/years_participated")

    async def get_team_awards(self, team_key: str):
        return await self.get(f"/team/{team_key}/awards")

    async def get_team_media(self, team_key: str, year: int):
        return await self.get(f"/team/{team_key}/media/{year}")

    # ── Match endpoints ─────────────────────────────────────
    async def get_match(self, match_key: str):
        return await self.get(f"/match/{match_key}")


# ── Singleton ───────────────────────────────────────────────
_client: Optional[TBAClient] = None


def get_tba_client() -> TBAClient:
    global _client
    if _client is None:
        _client = TBAClient()
    return _client
