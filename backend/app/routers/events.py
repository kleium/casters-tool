"""Event endpoints — info, teams with stats, summary, season list."""
from fastapi import APIRouter, HTTPException
from ..services import event_service
from ..services import summary_service
from ..services.tba_client import get_tba_client

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
