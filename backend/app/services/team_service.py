"""Team stats — highest stage of play, head-to-head playoff history."""
from __future__ import annotations

import asyncio
from datetime import date
from typing import Optional
from .tba_client import get_tba_client


COMP_LEVEL_ORDER = {"qm": 0, "ef": 1, "qf": 2, "sf": 3, "f": 4}
COMP_LEVEL_LABELS = {
    "qm": "Qualifications",
    "ef": "Round 1",
    "qf": "Round 2",
    "sf": "Round 3",
    "f": "Finals",
}

EVENT_TYPE_ORDER = {99: 0, 6: 0, 0: 1, 1: 1, 5: 2, 2: 3, 3: 4, 4: 5}
EVENT_TYPE_LABELS = {
    0: "Regional",
    1: "District",
    2: "District Championship",
    3: "FIRST Championship Division",
    4: "FIRST Championship (Einstein)",
    5: "District Championship Division",
    99: "Offseason",
    6: "Festival of Champions",
}


async def _safe(coro):
    try:
        return await coro
    except Exception:
        return None


# ── Team Stats ──────────────────────────────────────────────


async def get_team_stats(team_number: int, year: Optional[int] = None) -> dict:
    """Comprehensive stats for a single team in a given year."""
    client = get_tba_client()
    team_key = f"frc{team_number}"
    include_history = year is None
    if year is None:
        year = date.today().year

    team_info, years, events, media, all_awards, all_events_simple = await asyncio.gather(
        client.get_team(team_key),
        _safe(client.get_team_years_participated(team_key)),
        client.get_team_events(team_key, year),
        _safe(client.get_team_media(team_key, year)),
        _safe(client.get_team_awards(team_key)),
        _safe(client.get_team_events_simple(team_key)),
    )

    # Build event_key -> event_name lookup
    event_name_map: dict[str, str] = {}
    event_type_map: dict[str, int] = {}   # event_key -> TBA event_type
    if all_events_simple:
        for ev in all_events_simple:
            event_name_map[ev["key"]] = ev.get("name", ev["key"])
            event_type_map[ev["key"]] = ev.get("event_type", -1)

    # Extract avatar (base64-encoded PNG from TBA)
    avatar_base64 = None
    if media:
        for item in media:
            if item.get("type") == "avatar":
                b64 = (item.get("details") or {}).get("base64Image")
                if b64:
                    avatar_base64 = f"data:image/png;base64,{b64}"
                    break

    statuses = await _safe(client.get_team_events_statuses(team_key, year)) or {}

    # Walk every event this year to find highest stage reached
    highest_comp_rank = -1
    highest_comp_et_rank = -1
    highest_comp_label = "N/A — No events yet"
    highest_event_type_rank = -1
    highest_event_type = 99
    event_results = []

    # Map event types to short labels for winner annotation
    WINNER_LABELS = {
        0: "Regional",
        1: "District",
        2: "District Championship",
        3: "FIRST Championship Division",
        4: "Championship",
        5: "District Championship Division",
    }

    for ev in events:
        ek = ev["key"]
        et = ev.get("event_type", 99)
        et_rank = EVENT_TYPE_ORDER.get(et, 0)

        status = statuses.get(ek, {}) if isinstance(statuses, dict) else {}
        playoff = status.get("playoff") if status else None
        qual = status.get("qual") if status else None

        # Determine comp-level reached
        ev_comp_level = "qm"
        ev_playoff_status = ""
        if playoff:
            level = playoff.get("level", "qm")
            ev_comp_level = level
            ev_playoff_status = playoff.get("status", "")
            if ev_playoff_status == "won":
                ev_comp_level = "winner"

        comp_rank = (
            5 if ev_comp_level == "winner"
            else COMP_LEVEL_ORDER.get(ev_comp_level, 0)
        )

        # Use (comp_rank, et_rank) so a Championship winner outranks a Regional winner
        if comp_rank > highest_comp_rank or (comp_rank == highest_comp_rank and et_rank > highest_comp_et_rank):
            highest_comp_rank = comp_rank
            highest_comp_et_rank = et_rank
            if ev_comp_level == "winner":
                winner_ctx = WINNER_LABELS.get(et, "")
                highest_comp_label = f"Event Winner ({winner_ctx})" if winner_ctx else "Event Winner"
            else:
                highest_comp_label = COMP_LEVEL_LABELS.get(ev_comp_level, "Qualifications")

        if et_rank > highest_event_type_rank:
            highest_event_type_rank = et_rank
            highest_event_type = et

        qual_ranking = (qual.get("ranking") or {}) if qual else {}
        qual_record = qual_ranking.get("record", {})

        event_results.append({
            "event_key": ek,
            "event_name": ev.get("name", ek),
            "event_type": EVENT_TYPE_LABELS.get(et, "Other"),
            "qual_rank": qual_ranking.get("rank", "-"),
            "qual_record": f'{qual_record.get("wins", 0)}-{qual_record.get("losses", 0)}-{qual_record.get("ties", 0)}',
            "playoff_level": COMP_LEVEL_LABELS.get(ev_comp_level, ev_comp_level)
                             if ev_comp_level != "winner" else "Finals",
            "playoff_status": ev_playoff_status or "-",
        })

    # ── Process awards ──────────────────────────────────────
    blue_banners = []
    awards_by_year: dict[int, list[dict]] = {}
    # TBA blue-banner award types:
    #   0 = Chairman's Award / FIRST Impact Award
    #   1 = Regional/District Event Winner
    #   3 = Woodie Flowers Finalist Award
    # Note: type 71 is Autonomous Award (NOT district winner) — excluded.
    BLUE_BANNER_TYPES = {0, 1, 3}
    # Offseason / preseason events don't grant real blue banners
    _OFFSEASON_TYPES = {99, 100, -1}
    if all_awards:
        for aw in all_awards:
            aw_type = aw.get("award_type")
            aw_year = aw.get("year")
            aw_name = aw.get("name", "")
            aw_event = aw.get("event_key", "")
            entry = {
                "award_type": aw_type,
                "name": aw_name,
                "year": aw_year,
                "event_key": aw_event,
                "event_name": event_name_map.get(aw_event, aw_event),
            }
            if aw_type in BLUE_BANNER_TYPES:
                # Skip offseason events — they don't award real blue banners
                if event_type_map.get(aw_event, -1) not in _OFFSEASON_TYPES:
                    blue_banners.append(entry)
            awards_by_year.setdefault(aw_year, []).append(entry)

    # Build a flat sorted list (newest first) for the response
    awards_list = []
    for y in sorted(awards_by_year.keys(), reverse=True):
        for aw in awards_by_year[y]:
            awards_list.append(aw)

    result = {
        "team_number": team_number,
        "team_key": team_key,
        "nickname": team_info.get("nickname", ""),
        "city": team_info.get("city", ""),
        "state_prov": team_info.get("state_prov", ""),
        "country": team_info.get("country", ""),
        "rookie_year": team_info.get("rookie_year"),
        "years_active": len(years) if years else 0,
        "highest_stage_of_play": highest_comp_label,
        "highest_event_level": EVENT_TYPE_LABELS.get(highest_event_type, "Unknown"),
        "events_this_year": event_results,
        "year": year,
        "season_achievements": None,
        "avatar": avatar_base64,
        "blue_banners": blue_banners,
        "blue_banner_count": len(blue_banners),
        "awards": awards_list,
    }

    # If no explicit year was given, compute per-season achievements
    if include_history and years:
        result["season_achievements"] = await _get_season_achievements(
            client, team_key, sorted(years)
        )

    return result


async def _get_season_achievements(
    client, team_key: str, years: list[int]
) -> list[dict]:
    """Return the highest achievement for every season the team competed."""

    WINNER_LABELS = {
        0: "Regional",
        1: "District",
        2: "District Championship",
        3: "FIRST Championship Division",
        4: "Championship",
        5: "District Championship Division",
    }

    # Fetch all season statuses concurrently
    async def _fetch_year(y: int):
        statuses = await _safe(client.get_team_events_statuses(team_key, y))
        events = await _safe(client.get_team_events(team_key, y))
        return (y, statuses, events)

    year_data = await asyncio.gather(*[_fetch_year(y) for y in years])

    achievements = []
    for y, statuses, events in year_data:
        if not statuses or not isinstance(statuses, dict):
            achievements.append({
                "year": y,
                "achievement": "Competed",
                "event_name": "",
            })
            continue

        # Build event info lookup
        ev_info = {}
        if events:
            for ev in events:
                ev_info[ev["key"]] = ev

        best_comp_rank = -1
        best_et_rank = -1
        best_label = "Competed"
        best_event_name = ""

        for ek, status in statuses.items():
            if not isinstance(status, dict):
                continue

            ev = ev_info.get(ek, {})
            et = ev.get("event_type", 99)
            et_rank = EVENT_TYPE_ORDER.get(et, 0)
            playoff = status.get("playoff")

            ev_comp_level = "qm"
            ev_playoff_status = ""
            if playoff:
                level = playoff.get("level", "qm")
                ev_comp_level = level
                ev_playoff_status = playoff.get("status", "")
                if ev_playoff_status == "won":
                    ev_comp_level = "winner"

            comp_rank = (
                5 if ev_comp_level == "winner"
                else COMP_LEVEL_ORDER.get(ev_comp_level, 0)
            )

            if comp_rank > best_comp_rank or (comp_rank == best_comp_rank and et_rank > best_et_rank):
                best_comp_rank = comp_rank
                best_et_rank = et_rank
                best_event_name = ev.get("name", ek)
                if ev_comp_level == "winner":
                    winner_ctx = WINNER_LABELS.get(et, "")
                    best_label = f"Event Winner ({winner_ctx})" if winner_ctx else "Event Winner"
                else:
                    best_label = COMP_LEVEL_LABELS.get(ev_comp_level, "Qualifications")

        achievements.append({
            "year": y,
            "achievement": best_label,
            "event_name": best_event_name,
        })

    return achievements


# ── Head-to-Head ────────────────────────────────────────────


async def get_head_to_head(
    team_a: int, team_b: int, year: Optional[int] = None,
    all_time: bool = False,
) -> dict:
    """Find every playoff match where two teams faced each other (or allied)."""
    client = get_tba_client()
    key_a, key_b = f"frc{team_a}", f"frc{team_b}"
    if year is None:
        year = date.today().year

    if all_time:
        years_a, years_b = await asyncio.gather(
            _safe(client.get_team_years_participated(key_a)),
            _safe(client.get_team_years_participated(key_b)),
        )
        all_years = sorted(set((years_a or []) + (years_b or [])))
        start_year = min(all_years) if all_years else year - 2
        year_range = list(range(start_year, year + 1))
    else:
        year_range = list(range(year - 2, year + 1))

    results: list[dict] = []

    # Helper to format match code into readable label
    def _match_label(m_key: str, comp_level: str, match_num: int, set_num: int) -> str:
        short = {"ef": "R1", "qf": "R2", "sf": "R3", "f": "F"}
        prefix = short.get(comp_level, comp_level.upper())
        if comp_level == "f":
            return f"Final {match_num}"
        return f"{prefix} {set_num}-{match_num}"

    for check_year in year_range:
        events_a, events_b = await asyncio.gather(
            _safe(client.get_team_events(key_a, check_year)),
            _safe(client.get_team_events(key_b, check_year)),
        )
        if not events_a or not events_b:
            continue

        ek_a = {e["key"]: e for e in events_a}
        ek_b = {e["key"]: e for e in events_b}
        common = set(ek_a.keys()) & set(ek_b.keys())
        # Build event name map
        event_name_map = {}
        for ek_key in common:
            ev = ek_a.get(ek_key) or ek_b.get(ek_key)
            event_name_map[ek_key] = ev.get("name", ek_key) if ev else ek_key

        for ek in common:
            matches = await _safe(client.get_event_matches(ek))
            if not matches:
                continue

            for m in matches:
                if m.get("comp_level") == "qm":
                    continue  # only playoffs

                red = m.get("alliances", {}).get("red", {}).get("team_keys", [])
                blue = m.get("alliances", {}).get("blue", {}).get("team_keys", [])
                a_red, a_blue = key_a in red, key_a in blue
                b_red, b_blue = key_b in red, key_b in blue

                if not (a_red or a_blue) or not (b_red or b_blue):
                    continue

                winner = m.get("winning_alliance", "")

                if (a_red and b_blue) or (a_blue and b_red):
                    a_side = "red" if a_red else "blue"
                    a_won = winner == a_side
                    results.append({
                        "event_key": ek,
                        "event_name": event_name_map.get(ek, ek),
                        "match_key": m["key"],
                        "match_label": _match_label(
                            m["key"], m["comp_level"],
                            m.get("match_number", 0), m.get("set_number", 0)),
                        "comp_level": COMP_LEVEL_LABELS.get(m["comp_level"], m["comp_level"]),
                        "year": check_year,
                        "red_teams": [tk.replace("frc", "") for tk in red],
                        "blue_teams": [tk.replace("frc", "") for tk in blue],
                        "red_score": m["alliances"]["red"].get("score", 0),
                        "blue_score": m["alliances"]["blue"].get("score", 0),
                        "winner": str(team_a) if a_won else (str(team_b) if winner else "tie"),
                        "relationship": "opponents",
                    })
                elif (a_red and b_red) or (a_blue and b_blue):
                    side = "red" if (a_red and b_red) else "blue"
                    results.append({
                        "event_key": ek,
                        "event_name": event_name_map.get(ek, ek),
                        "match_key": m["key"],
                        "match_label": _match_label(
                            m["key"], m["comp_level"],
                            m.get("match_number", 0), m.get("set_number", 0)),
                        "comp_level": COMP_LEVEL_LABELS.get(m["comp_level"], m["comp_level"]),
                        "year": check_year,
                        "red_teams": [tk.replace("frc", "") for tk in red],
                        "blue_teams": [tk.replace("frc", "") for tk in blue],
                        "red_score": m["alliances"]["red"].get("score", 0),
                        "blue_score": m["alliances"]["blue"].get("score", 0),
                        "winner": "both" if winner == side else "neither",
                        "relationship": "allies",
                    })

    # Summarize
    opp = [r for r in results if r["relationship"] == "opponents"]
    ally = [r for r in results if r["relationship"] == "allies"]
    a_wins = sum(1 for r in opp if r["winner"] == str(team_a))
    b_wins = sum(1 for r in opp if r["winner"] == str(team_b))

    # Collect nicknames for all team numbers that appear
    all_nums: set[str] = set()
    for r in results:
        all_nums.update(r["red_teams"])
        all_nums.update(r["blue_teams"])

    async def _nick(num: str):
        info = await _safe(client.get_team(f"frc{num}"))
        return (num, info.get("nickname", "") if info else "")

    nick_results = await asyncio.gather(*[_nick(n) for n in all_nums])
    team_nicknames = {n: nick for n, nick in nick_results if nick}

    return {
        "team_a": team_a,
        "team_b": team_b,
        "opponent_matches": opp,
        "ally_matches": ally,
        "h2h_summary": {
            "total_opponent_matches": len(opp),
            "team_a_wins": a_wins,
            "team_b_wins": b_wins,
            "total_ally_matches": len(ally),
        },
        "years_checked": year_range,
        "all_time": all_time,
        "team_nicknames": team_nicknames,
    }
