"""Team lookup endpoints — stats, highest stage, head-to-head."""
from typing import Optional
from fastapi import APIRouter, HTTPException
from ..services import team_service

router = APIRouter()


@router.get("/{team_number}/stats")
async def team_stats(team_number: int, year: Optional[int] = None):
    try:
        return await team_service.get_team_stats(team_number, year)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/head-to-head/{team_a}/{team_b}")
async def head_to_head(team_a: int, team_b: int, year: Optional[int] = None):
    try:
        return await team_service.get_head_to_head(team_a, team_b, year)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
