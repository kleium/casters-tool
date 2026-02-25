"""Event-related business logic — teams, rankings, OPRs."""
from __future__ import annotations

import asyncio
from datetime import date
from .tba_client import get_tba_client

# TBA event types to exclude from the season dropdown (off-season, preseason, unlabeled)
_EXCLUDE_TYPES = {99, 100, -1}

# Region groupings for FRC events
_REGION_MAP = {
    # US regions
    "New England": {"NH", "MA", "CT", "RI", "VT", "ME"},
    "Mid-Atlantic": {"NY", "NJ", "PA", "DE", "MD", "DC"},
    "Southeast": {"VA", "NC", "SC", "GA", "FL", "AL", "MS", "TN", "KY", "WV", "LA", "AR"},
    "Midwest": {"OH", "IN", "IL", "MI", "WI", "MN", "IA", "MO", "ND", "SD", "NE", "KS"},
    "Texas": {"TX"},
    "Mountain": {"MT", "WY", "CO", "NM", "AZ", "UT", "ID", "NV"},
    "Pacific": {"WA", "OR", "CA", "HI", "AK"},
    # International
    "Canada": set(),       # matched by country
    "Türkiye": set(),
    "Israel": set(),
    "China": set(),
    "Australia": set(),
    "International": set(),  # catch-all
}


# Pre-district regions that transitioned to a district system.
# Maps the old region name to the current district name.
_REGION_MERGE = {
    "Israel": "FIRST Israel",
    "Texas": "FIRST In Texas",
}


def _resolve_region(country: str, state_prov: str, district: dict | None) -> str:
    """Return a human-readable region string for an event."""
    if district and district.get("abbreviation"):
        return district["display_name"] or district["abbreviation"].upper()

    if country and country not in ("USA", ""):
        # Map known FRC countries
        for label in ("Canada", "Türkiye", "Israel", "China", "Australia"):
            if label.lower() in country.lower() or country.lower() in label.lower():
                return _REGION_MERGE.get(label, label)
        return "International"

    # US state lookup
    for region, states in _REGION_MAP.items():
        if state_prov in states:
            return _REGION_MERGE.get(region, region)
    return "Other"


async def get_season_events(year: int, include_offseason: bool = False) -> list[dict]:
    """Return a lightweight list of events for *year*.

    By default off-season / preseason events are excluded.
    Pass *include_offseason=True* to include event_type 99.
    """
    client = get_tba_client()
    raw = await client.get_events_by_year(year)

    # When including offseason, only exclude truly junk types (-1, 100)
    exclude = {100, -1} if include_offseason else _EXCLUDE_TYPES

    events = []
    for ev in raw:
        etype = ev.get("event_type", -1)
        if etype in exclude:
            continue

        events.append({
            "key": ev["key"],
            "name": ev.get("name", ""),
            "short_name": ev.get("short_name") or ev.get("name", ""),
            "week": ev.get("week"),           # 0-indexed week or None for CMP
            "start_date": ev.get("start_date", ""),
            "end_date": ev.get("end_date", ""),
            "city": ev.get("city", ""),
            "state_prov": ev.get("state_prov", ""),
            "country": ev.get("country", ""),
            "event_type": etype,
            "event_type_string": ev.get("event_type_string", ""),
            "district": ev.get("district"),
            "region": _resolve_region(
                ev.get("country", ""),
                ev.get("state_prov", ""),
                ev.get("district"),
            ),
        })

    events.sort(key=lambda e: (e["name"] or "").lower())
    return events


async def _safe(coro):
    """Await *coro*; return None on any error (rankings/OPRs may not exist yet)."""
    try:
        return await coro
    except Exception:
        return None


def _event_status(start_date: str, end_date: str) -> str:
    """Return 'upcoming', 'ongoing', or 'completed' based on today's date."""
    from datetime import date, timedelta
    today = date.today()
    try:
        sd = date.fromisoformat(start_date)
        ed = date.fromisoformat(end_date)
    except (ValueError, TypeError):
        return "unknown"
    # Give 1 extra day buffer after end_date for late result uploads
    if today > ed + timedelta(days=1):
        return "completed"
    if today >= sd:
        return "ongoing"
    return "upcoming"


async def get_event_info(event_key: str) -> dict:
    client = get_tba_client()
    ev = await client.get_event(event_key)
    start = ev.get("start_date", "")
    end = ev.get("end_date", "")
    etype = ev.get("event_type", -1)
    # CMP Division (3) and Einstein (4) aren't region-specific
    region = "" if etype in (3, 4) else _resolve_region(
        ev.get("country", ""),
        ev.get("state_prov", ""),
        ev.get("district"),
    )
    return {
        "key": ev["key"],
        "name": ev.get("name", ""),
        "year": ev.get("year"),
        "city": ev.get("city", ""),
        "state_prov": ev.get("state_prov", ""),
        "country": ev.get("country", ""),
        "event_type_string": ev.get("event_type_string", ""),
        "event_type": etype,
        "start_date": start,
        "end_date": end,
        "status": _event_status(start, end),
        "region": region,
    }


async def get_event_teams_with_stats(event_key: str) -> list[dict]:
    """Return every team at the event enriched with rank, record, and OPR."""
    client = get_tba_client()

    # Teams must succeed; rankings/OPRs may be unavailable early in the event
    teams = await client.get_event_teams_full(event_key)

    # Determine the year for media lookups
    year = int(event_key[:4]) if event_key[:4].isdigit() else date.today().year

    rankings, oprs = await asyncio.gather(
        _safe(client.get_event_rankings(event_key)),
        _safe(client.get_event_oprs(event_key)),
    )

    # Fetch avatars for all teams in parallel
    avatar_tasks = {
        t["key"]: _safe(client.get_team_media(t["key"], year))
        for t in teams
    }
    avatar_keys = list(avatar_tasks.keys())
    avatar_results = await asyncio.gather(*avatar_tasks.values())
    avatar_map: dict[str, str | None] = {}
    for tk, media_list in zip(avatar_keys, avatar_results):
        avatar_map[tk] = None
        if media_list:
            for m in media_list:
                if m.get("type") == "avatar":
                    b64 = (m.get("details") or {}).get("base64Image")
                    if b64:
                        avatar_map[tk] = f"data:image/png;base64,{b64}"
                        break

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
                "school_name": t.get("school_name", ""),
                "city": t.get("city", ""),
                "state_prov": t.get("state_prov", ""),
                "country": t.get("country", ""),
                "avatar": avatar_map.get(tk),
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


async def get_team_comparison(event_key: str, teams_csv: str) -> dict:
    """Compare 2-6 teams at an event with detailed stats."""
    team_keys = [t.strip() for t in teams_csv.split(",") if t.strip()]
    if len(team_keys) < 2 or len(team_keys) > 6:
        raise ValueError("Provide between 2 and 6 team keys")

    client = get_tba_client()

    # Fetch all required data in parallel
    matches_raw, rankings, oprs, teams_raw = await asyncio.gather(
        _safe(client.get_event_matches(event_key)),
        _safe(client.get_event_rankings(event_key)),
        _safe(client.get_event_oprs(event_key)),
        _safe(client.get_event_teams_full(event_key)),
    )

    # Build team info lookup
    team_info: dict[str, dict] = {}
    for t in (teams_raw or []):
        team_info[t["key"]] = t

    # Build rank lookup
    rank_map: dict[str, dict] = {}
    if rankings and rankings.get("rankings"):
        for r in rankings["rankings"]:
            rank_map[r["team_key"]] = r

    # Build OPR lookup
    opr_data: dict[str, dict] = {}
    if oprs:
        for tk in oprs.get("oprs", {}):
            opr_data[tk] = {
                "opr": round(oprs["oprs"].get(tk, 0), 2),
                "dpr": round(oprs["dprs"].get(tk, 0), 2),
                "ccwm": round(oprs["ccwms"].get(tk, 0), 2),
            }

    # Compute per-team match stats from qual matches
    team_scores: dict[str, list[int]] = {}
    team_rp: dict[str, list[float]] = {}
    matches_raw = matches_raw or []
    for m in matches_raw:
        if m.get("comp_level") != "qm":
            continue
        for color in ("red", "blue"):
            score = m["alliances"][color].get("score", -1)
            if score < 0:
                continue
            for tk in m["alliances"][color].get("team_keys", []):
                team_scores.setdefault(tk, []).append(score)

    # Build comparison for each requested team
    comparison = []
    for tk in team_keys:
        info = team_info.get(tk, {})
        rk = rank_map.get(tk, {})
        rec = rk.get("record", {})
        o = opr_data.get(tk, {"opr": 0, "dpr": 0, "ccwm": 0})
        scores = team_scores.get(tk, [])

        # Ranking points from sort_orders
        sort_orders = rk.get("sort_orders", [])
        avg_rp = round(sort_orders[0], 2) if sort_orders and isinstance(sort_orders[0], (int, float)) else 0

        comparison.append({
            "team_key": tk,
            "team_number": info.get("team_number", int(tk.replace("frc", ""))),
            "nickname": info.get("nickname", ""),
            "city": info.get("city", ""),
            "state_prov": info.get("state_prov", ""),
            "country": info.get("country", ""),
            "avatar": None,  # Could be populated if needed
            "rank": rk.get("rank", "-"),
            "wins": rec.get("wins", 0),
            "losses": rec.get("losses", 0),
            "ties": rec.get("ties", 0),
            "opr": o["opr"],
            "dpr": o["dpr"],
            "ccwm": o["ccwm"],
            "avg_rp": avg_rp,
            "qual_average": round(sum(scores) / len(scores), 2) if scores else 0,
            "high_score": max(scores) if scores else 0,
            "matches_played": len(scores),
        })

    return {"event_key": event_key, "teams": comparison}
