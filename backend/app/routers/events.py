"""Event endpoints — info, teams with stats, summary, season list, compare."""
import asyncio
from fastapi import APIRouter, HTTPException, Query, Body
from ..services import event_service
from ..services import summary_service
from ..services import cache_service
from ..services import region_service
from ..services.tba_client import get_tba_client
from ..services.alliance_service import get_alliances_with_stats

router = APIRouter()


@router.get("/season/{year}")
async def season_events(year: int):
    try:
        return await event_service.get_season_events(year)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{event_key}/info")
async def event_info(event_key: str):
    try:
        return await event_service.get_event_info(event_key)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{event_key}/teams")
async def event_teams(event_key: str):
    try:
        return await event_service.get_event_teams_with_stats(event_key)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{event_key}/summary")
async def event_summary(event_key: str):
    try:
        return await summary_service.get_event_summary(event_key)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{event_key}/summary/refresh-stats")
async def event_summary_refresh_stats(event_key: str):
    try:
        return await summary_service.get_event_summary_stats(event_key)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{event_key}/summary/connections")
async def event_connections(
    event_key: str,
    all_time: bool = Query(False, description="Search all-time instead of last 3 years"),
):
    try:
        return await summary_service.get_event_connections(event_key, all_time=all_time)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{event_key}/clear-cache")
async def clear_cache(event_key: str):
    get_tba_client().clear_cache()
    return {"status": "cache cleared"}


@router.get("/{event_key}/refresh-rankings")
async def refresh_rankings(event_key: str):
    """Clear cached rankings/OPRs/teams for an event, then return fresh data."""
    client = get_tba_client()
    client.clear_cache_for(
        f"/event/{event_key}/rankings",
        f"/event/{event_key}/oprs",
        f"/event/{event_key}/teams",
    )
    return await event_service.get_event_teams_with_stats(event_key)


@router.get("/{event_key}/compare")
async def compare_teams(
    event_key: str,
    teams: str = Query(..., description="Comma-separated team keys, e.g. frc254,frc1678"),
):
    """Compare 2-6 teams at an event with enriched stats."""
    try:
        return await event_service.get_team_comparison(event_key, teams)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ═══════════════════════════════════════════════════════════
#  Region / Event History
# ═══════════════════════════════════════════════════════════

@router.get("/region/{region_name}/facts")
async def region_facts(region_name: str):
    """Return pre-computed region/district facts (instant, from static JSON)."""
    data = region_service.get_region_facts(region_name)
    if not data:
        raise HTTPException(status_code=404, detail=f"No data for region: {region_name}")
    return data


@router.get("/regions/list")
async def regions_list():
    """Return all known region names."""
    return region_service.list_regions()


@router.get("/{event_key}/history")
async def event_history(event_key: str):
    """Return the full history of a recurring event (awards, winners, timeline)."""
    try:
        return await region_service.get_event_history(event_key)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


# ═══════════════════════════════════════════════════════════
#  Save / Load event snapshots
# ═══════════════════════════════════════════════════════════

@router.get("/saved/list")
async def list_saved():
    """List all saved event snapshots (metadata only)."""
    return cache_service.list_saved_events()


@router.post("/{event_key}/save")
async def save_event(event_key: str, prefetched: dict | None = Body(None)):
    """Save event snapshot. Accepts optional pre-loaded data from frontend to skip redundant fetches."""
    try:
        pre = prefetched or {}

        # Build list of what we still need to fetch
        coros = {}
        if "info" not in pre:       coros["info"] = event_service.get_event_info(event_key)
        if "teams" not in pre:      coros["teams"] = event_service.get_event_teams_with_stats(event_key)
        if "summary" not in pre:    coros["summary"] = summary_service.get_event_summary(event_key)
        if "alliances" not in pre:  coros["alliances"] = _safe_async(get_alliances_with_stats(event_key))
        if "matches" not in pre:    coros["matches"] = _safe_async(_get_all_matches(event_key))
        if "playoffs" not in pre:   coros["playoffs"] = _safe_async(_get_playoffs(event_key))
        # connections: summary already contains past-3 connections, so only fetch all-time if missing
        if "connections_alltime" not in pre:
            coros["connections_alltime"] = _safe_async(
                summary_service.get_event_connections(event_key, all_time=True)
            )

        # Fetch only what's missing
        keys = list(coros.keys())
        values = await asyncio.gather(*coros.values()) if coros else []
        fetched = dict(zip(keys, values))

        # Merge: prefer pre-loaded, fill gaps from fetched
        info    = pre.get("info")    or fetched.get("info")
        teams   = pre.get("teams")   or fetched.get("teams")
        summary = pre.get("summary") or fetched.get("summary")

        snapshot = {
            "info":       info,
            "teams":      teams,
            "summary":    summary,
            "alliances":  pre.get("alliances")  or fetched.get("alliances"),
            "matches":    pre.get("matches")    or fetched.get("matches"),
            "playoffs":   pre.get("playoffs")   or fetched.get("playoffs"),
            "connections": pre.get("connections") or (summary or {}).get("connections"),
            "connections_alltime": pre.get("connections_alltime") or fetched.get("connections_alltime"),
        }

        meta = cache_service.save_event(event_key, snapshot)
        return {**meta, "data": snapshot}

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/{event_key}/saved")
async def load_saved_event(event_key: str):
    """Load a previously saved event snapshot from disk."""
    result = cache_service.load_event(event_key)
    if not result:
        raise HTTPException(status_code=404, detail="No saved data for this event")
    return result


@router.delete("/{event_key}/saved")
async def delete_saved_event(event_key: str):
    """Delete a saved event snapshot."""
    if cache_service.delete_event(event_key):
        return {"status": "deleted", "event_key": event_key}
    raise HTTPException(status_code=404, detail="No saved data for this event")


async def _safe_async(coro):
    """Await coroutine; return None on error."""
    try:
        return await coro
    except Exception:
        return None


async def _get_all_matches(event_key: str):
    """Re-use the matches router logic by importing & calling directly."""
    from .matches import get_all_matches
    return await get_all_matches(event_key)


async def _get_playoffs(event_key: str):
    """Re-use the matches router logic for playoffs."""
    from .matches import get_playoff_matches
    return await get_playoff_matches(event_key)
