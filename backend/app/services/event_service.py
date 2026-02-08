"""Event-related business logic — teams, rankings, OPRs."""
from __future__ import annotations

import asyncio
from .tba_client import get_tba_client


async def _safe(coro):
    """Await *coro*; return None on any error (rankings/OPRs may not exist yet)."""
    try:
        return await coro
    except Exception:
        return None


async def get_event_info(event_key: str) -> dict:
    client = get_tba_client()
    ev = await client.get_event(event_key)
    return {
        "key": ev["key"],
        "name": ev.get("name", ""),
        "year": ev.get("year"),
        "city": ev.get("city", ""),
        "state_prov": ev.get("state_prov", ""),
        "event_type_string": ev.get("event_type_string", ""),
        "start_date": ev.get("start_date", ""),
        "end_date": ev.get("end_date", ""),
    }


async def get_event_teams_with_stats(event_key: str) -> list[dict]:
    """Return every team at the event enriched with rank, record, and OPR."""
    client = get_tba_client()

    # Teams must succeed; rankings/OPRs may be unavailable early in the event
    teams = await client.get_event_teams(event_key)
    rankings, oprs = await asyncio.gather(
        _safe(client.get_event_rankings(event_key)),
        _safe(client.get_event_oprs(event_key)),
    )

    # Build fast lookups
    rank_map: dict[str, dict] = {}
    if rankings and rankings.get("rankings"):
        for r in rankings["rankings"]:
            rank_map[r["team_key"]] = r

    opr_map: dict[str, dict] = {}
    if oprs:
        for tk in oprs.get("oprs", {}):
            opr_map[tk] = {
                "opr": round(oprs["oprs"].get(tk, 0), 2),
                "dpr": round(oprs["dprs"].get(tk, 0), 2),
                "ccwm": round(oprs["ccwms"].get(tk, 0), 2),
            }

    result = []
    for t in teams:
        tk = t["key"]
        r = rank_map.get(tk, {})
        rec = r.get("record", {})
        o = opr_map.get(tk, {"opr": 0, "dpr": 0, "ccwm": 0})
        result.append(
            {
                "team_key": tk,
                "team_number": t["team_number"],
                "nickname": t.get("nickname", ""),
                "city": t.get("city", ""),
                "state_prov": t.get("state_prov", ""),
                "rank": r.get("rank", "-"),
                "wins": rec.get("wins", 0),
                "losses": rec.get("losses", 0),
                "ties": rec.get("ties", 0),
                "qual_average": r.get("qual_average", 0),
                "opr": o["opr"],
                "dpr": o["dpr"],
                "ccwm": o["ccwm"],
            }
        )

    result.sort(key=lambda x: x["rank"] if isinstance(x["rank"], int) else 999)
    return result
