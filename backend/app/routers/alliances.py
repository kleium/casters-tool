"""Alliance selection endpoints."""
from fastapi import APIRouter, HTTPException
from ..services import alliance_service

router = APIRouter()


@router.get("/{event_key}")
async def get_alliances(event_key: str):
    try:
        return await alliance_service.get_alliances_with_stats(event_key)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
