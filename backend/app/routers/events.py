"""Event endpoints — info, teams with stats."""
from fastapi import APIRouter, HTTPException
from ..services import event_service
from ..services.tba_client import get_tba_client

router = APIRouter()


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


@router.get("/{event_key}/clear-cache")
async def clear_cache(event_key: str):
    get_tba_client().clear_cache()
    return {"status": "cache cleared"}
