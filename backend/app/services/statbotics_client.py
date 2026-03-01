"""Statbotics API async client — EPA (Expected Points Added) data.

Uses the public Statbotics REST API v3 (https://api.statbotics.io/docs).
No API key required.  Be nice to their servers — cache aggressively.
"""
from __future__ import annotations

import time
from typing import Any, Optional

import httpx

STATBOTICS_BASE = "https://api.statbotics.io/v3"
CACHE_TTL = 300  # 5 minutes — same cadence as TBA cache


class StatboticsClient:
    """Thin async wrapper around Statbotics REST API with TTL cache."""

    def __init__(self) -> None:
        self._cache: dict[str, tuple[float, Any]] = {}
        self._http: Optional[httpx.AsyncClient] = None

    def _client(self) -> httpx.AsyncClient:
        if self._http is None or self._http.is_closed:
            self._http = httpx.AsyncClient(
                base_url=STATBOTICS_BASE,
                timeout=15.0,
            )
        return self._http

    async def get(self, endpoint: str, *, bypass_cache: bool = False) -> Any:
        now = time.time()
        if not bypass_cache and endpoint in self._cache:
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

    # ── Convenience methods ─────────────────────────────────

    async def get_team_events_for_event(self, event_key: str) -> list[dict]:
        """Fetch EPA data for every team at an event.

        Returns a list of TeamEvent objects from Statbotics.
        """
        return await self.get(f"/team_events?event={event_key}")

    async def get_team_year(self, team_number: int, year: int) -> dict | None:
        """Fetch season-level EPA for a single team."""
        try:
            return await self.get(f"/team_year/{team_number}/{year}")
        except (httpx.HTTPStatusError, httpx.RequestError):
            return None

    async def get_event_matches(self, event_key: str) -> list[dict]:
        """Fetch all Statbotics match records for an event (includes predictions)."""
        try:
            return await self.get(f"/matches?event={event_key}&limit=500")
        except (httpx.HTTPStatusError, httpx.RequestError):
            return []


# ── Singleton ───────────────────────────────────────────────
_instance: Optional[StatboticsClient] = None


def get_statbotics_client() -> StatboticsClient:
    global _instance
    if _instance is None:
        _instance = StatboticsClient()
    return _instance


# ── Helper: build an EPA lookup map for an event ────────────
async def get_epa_map(event_key: str) -> dict[str, dict]:
    """Return ``{team_key: {epa, epa_auto, epa_teleop, epa_endgame}}`` for an event.

    team_key is in TBA ``frcNNNN`` format.
    Falls back to empty dicts gracefully.
    """
    sb = get_statbotics_client()
    try:
        team_events = await sb.get_team_events_for_event(event_key)
    except Exception:
        return {}

    epa_map: dict[str, dict] = {}
    for te in team_events:
        team_num = te.get("team")
        epa_block = te.get("epa") or {}
        total = epa_block.get("total_points", {})
        breakdown = epa_block.get("breakdown") or {}

        epa_map[f"frc{team_num}"] = {
            "epa": round(total.get("mean", 0), 2),
            "epa_auto": round(breakdown.get("auto_points", 0), 2),
            "epa_teleop": round(breakdown.get("teleop_points", 0), 2),
            "epa_endgame": round(breakdown.get("endgame_points", 0), 2),
        }

    return epa_map


# ── Helper: build a match prediction map for an event ───────
async def get_match_predictions(event_key: str) -> dict[str, dict]:
    """Return ``{match_key: {winner, red_win_prob, red_score, blue_score}}``
    for every match at an event.

    match_key is in TBA format (e.g. ``2024cabe_qm1``).
    Falls back to an empty dict on error.
    """
    sb = get_statbotics_client()
    try:
        matches = await sb.get_event_matches(event_key)
    except Exception:
        return {}

    pred_map: dict[str, dict] = {}
    for m in matches:
        key = m.get("key", "")
        pred = m.get("pred") or {}
        if not pred:
            continue

        red_win = pred.get("red_win_prob")
        pred_map[key] = {
            "winner": pred.get("winner", ""),
            "red_win_prob": round(red_win, 3) if red_win is not None else None,
            "red_score": round(pred.get("red_score", 0), 1),
            "blue_score": round(pred.get("blue_score", 0), 1),
        }

    return pred_map
