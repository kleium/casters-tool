"""Event endpoints — info, teams with stats, summary, season list, compare."""
from fastapi import APIRouter, HTTPException, Query
from ..services import event_service
from ..services import summary_service
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
