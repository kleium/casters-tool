"""Event Summary — demographics, Hall of Fame, prior connections, top scorers."""
from __future__ import annotations

import asyncio
from datetime import date
from .tba_client import get_tba_client


async def _safe(coro):
    try:
        return await coro
    except Exception:
        return None


async def get_event_summary(event_key: str) -> dict:
    """Build the full event summary payload."""
    client = get_tba_client()
    year = int(event_key[:4])
    current_year = date.today().year

    # Parallel fetch: event info, teams (full detail), rankings, OPRs
    event_info, teams, rankings, oprs = await asyncio.gather(
        _safe(client.get_event(event_key)),
        client.get_event_teams_full(event_key),
        _safe(client.get_event_rankings(event_key)),
        _safe(client.get_event_oprs(event_key)),
    )

    if not teams:
        return {"error": "No teams found for this event."}

    # Determine the event's home country for foreign-team detection
    event_country = (event_info or {}).get("country", "") or ""

    # ── Demographics ────────────────────────────────────────
    total = len(teams)
    rookie_count = 0
    veteran_count = 0   # any team older than 1 year
    countries: set[str] = set()
    foreign_count = 0   # teams from a different country than the event
    team_ages: list[int] = []  # years since rookie_year for all teams

    for t in teams:
        ry = t.get("rookie_year")
        country = t.get("country", "") or ""
        if country:
            countries.add(country)
        # "Foreign" = different country from the event's host country
        if event_country and country and country != event_country:
            foreign_count += 1
        if ry:
            team_ages.append(year - ry)
        if ry and ry == year:
            rookie_count += 1
        elif ry and ry < year:
            veteran_count += 1

    avg_team_age = round(sum(team_ages) / len(team_ages), 1) if team_ages else 0

    demographics = {
        "total_teams": total,
        "rookie_count": rookie_count,
        "rookie_pct": round(100 * rookie_count / total, 1) if total else 0,
        "veteran_count": veteran_count,
        "veteran_pct": round(100 * veteran_count / total, 1) if total else 0,
        "avg_team_age": avg_team_age,
        "foreign_count": foreign_count,
        "foreign_pct": round(100 * foreign_count / total, 1) if total else 0,
        "event_country": event_country,
        "country_count": len(countries),
        "countries": sorted(countries),
    }

    # ── Hall of Fame & Impact Award ─────────────────────────
    hof_teams, impact_finalists = await _get_award_teams(client, teams)

    # ── Top 3 OPR contributors ──────────────────────────────
    top_scorers = _compute_top_scorers(teams, oprs, rankings)

    # ── Prior playoff connections (default: last 3 years) ──
    connections = await _find_playoff_connections(teams, event_key, year, lookback_years=3)

    return {
        "event_key": event_key,
        "demographics": demographics,
        "hall_of_fame": hof_teams,
        "impact_finalists": impact_finalists,
        "top_scorers": top_scorers,
        "connections": connections,
    }


async def get_event_summary_stats(event_key: str) -> dict:
    """Lighter refresh — just OPR/rankings-based stats (no history scan)."""
    client = get_tba_client()
    # Clear cache for rankings/OPRs so we get fresh data
    for suffix in ["/rankings", "/oprs"]:
        endpoint = f"/event/{event_key}{suffix}"
        if endpoint in client._cache:
            del client._cache[endpoint]

    teams, rankings, oprs = await asyncio.gather(
        client.get_event_teams(event_key),
        _safe(client.get_event_rankings(event_key)),
        _safe(client.get_event_oprs(event_key)),
    )

    return {
        "top_scorers": _compute_top_scorers(teams, oprs, rankings),
    }


def _compute_top_scorers(teams, oprs, rankings) -> list[dict]:
    """Return top-3 teams by OPR."""
    if not oprs or not oprs.get("oprs"):
        return []

    name_map = {t["key"]: t for t in (teams or [])}
    rank_map: dict[str, int] = {}
    if rankings and rankings.get("rankings"):
        for r in rankings["rankings"]:
            rank_map[r["team_key"]] = r.get("rank", 0)

    scored = []
    for tk, opr_val in oprs["oprs"].items():
        t = name_map.get(tk, {})
        scored.append({
            "team_key": tk,
            "team_number": t.get("team_number", int(tk.replace("frc", ""))),
            "nickname": t.get("nickname", ""),
            "opr": round(opr_val, 2),
            "dpr": round(oprs.get("dprs", {}).get(tk, 0), 2),
            "rank": rank_map.get(tk, "-"),
        })

    scored.sort(key=lambda x: x["opr"], reverse=True)
    return scored[:3]


COMP_LEVEL_LABELS = {
    "qm": "Quals", "ef": "Eighths", "qf": "Quarters",
    "sf": "Semi-Finals", "f": "Finals",
}


async def _get_award_teams(client, teams: list[dict]) -> tuple[list[dict], list[dict]]:
    """Fetch awards for every team; return (hof_teams, impact_finalists)."""

    async def _awards_for(t: dict):
        tk = t["key"]
        awards = await _safe(client.get_team_awards(tk))
        return (t, awards or [])

    results = await asyncio.gather(*[_awards_for(t) for t in teams])

    # Collect all event keys where a type 0 or 69 award exists
    candidate_events: set[str] = set()
    for _t, awards in results:
        for a in awards:
            if a.get("award_type") in (0, 69):
                candidate_events.add(a.get("event_key", ""))

    # Batch-fetch event info to determine which are championship-level (type 3 or 4)
    async def _event_type(ek: str):
        ev = await _safe(client.get_event(ek))
        return (ek, (ev or {}).get("event_type"))

    event_types = dict(await asyncio.gather(*[_event_type(ek) for ek in candidate_events if ek]))
    champ_events = {ek for ek, et in event_types.items() if et in (3, 4)}

    hof_teams: list[dict] = []
    impact_finalists: list[dict] = []

    for t, awards in results:
        is_hof = False
        is_finalist = False
        impact_years: list[int] = []

        for a in awards:
            atype = a.get("award_type")
            ek = a.get("event_key", "")
            yr = a.get("year", 0)
            # HoF = Chairman's/Impact Award (type 0) at Championship Division or Finals
            if atype == 0 and ek in champ_events:
                is_hof = True
                impact_years.append(yr)
            # Impact finalist (type 69) at Championship Division or Finals
            if atype == 69 and ek in champ_events:
                is_finalist = True
                impact_years.append(yr)

        info = {
            "team_number": t.get("team_number"),
            "nickname": t.get("nickname", ""),
            "city": t.get("city", ""),
            "state_prov": t.get("state_prov", ""),
            "country": t.get("country", ""),
        }

        if is_hof:
            hof_teams.append({**info, "impact_years": sorted(set(impact_years))})
        elif is_finalist:
            impact_finalists.append({**info, "impact_years": sorted(set(impact_years))})

    hof_teams.sort(key=lambda x: x["team_number"])
    impact_finalists.sort(key=lambda x: x["team_number"])
    return hof_teams, impact_finalists


async def get_event_connections(event_key: str, all_time: bool = False) -> list[dict]:
    """Public entry point to fetch connections with configurable lookback."""
    client = get_tba_client()
    year = int(event_key[:4])
    teams = await client.get_event_teams_full(event_key)
    if not teams:
        return []
    lookback = None if all_time else 3
    return await _find_playoff_connections(teams, event_key, year, lookback_years=lookback)


async def _find_playoff_connections(
    teams: list[dict], event_key: str, year: int, lookback_years: int | None = 3
) -> list[dict]:
    """Find pairs of teams at this event who have prior playoff history.
    
    lookback_years: number of past seasons to check, or None for all-time (back to rookie year).
    """
    client = get_tba_client()
    team_keys = [t["key"] for t in teams]
    name_map = {t["key"]: t.get("nickname", "") for t in teams}

    if lookback_years is not None:
        check_years = list(range(max(2015, year - lookback_years), year))
    else:
        # All-time: go back to the earliest rookie year among the teams
        rookie_years = [t.get("rookie_year", year) for t in teams if t.get("rookie_year")]
        earliest = min(rookie_years) if rookie_years else 2015
        check_years = list(range(max(2000, earliest), year))

    if not check_years:
        return []

    # Build event lists per team for the check years
    async def _events_for(tk: str, y: int):
        data = await _safe(client.get_team_events(tk, y))
        return (tk, y, data or [])

    tasks = []
    for tk in team_keys:
        for y in check_years:
            tasks.append(_events_for(tk, y))

    results = await asyncio.gather(*tasks)

    # team -> set of event_keys (excluding current)
    # Also build event name map from fetched data
    team_events: dict[str, set[str]] = {}
    event_name_map: dict[str, str] = {}  # event_key -> short/display name
    for tk, _y, events in results:
        if tk not in team_events:
            team_events[tk] = set()
        for ev in events:
            ek = ev["key"]
            if ek != event_key:
                team_events[tk].add(ek)
            if ek not in event_name_map:
                event_name_map[ek] = ev.get("short_name") or ev.get("name", ek)

    # Find pairs with common events
    common_events_to_fetch: set[str] = set()
    pair_common: dict[tuple[str, str], set[str]] = {}
    for i in range(len(team_keys)):
        for j in range(i + 1, len(team_keys)):
            ta, tb = team_keys[i], team_keys[j]
            common = team_events.get(ta, set()) & team_events.get(tb, set())
            if common:
                pair_common[(ta, tb)] = common
                common_events_to_fetch.update(common)

    if not common_events_to_fetch:
        return []

    # Fetch alliance data for those events
    async def _alliances_for(ek: str):
        data = await _safe(client.get_event_alliances(ek))
        return (ek, data)

    alliance_results = await asyncio.gather(
        *[_alliances_for(ek) for ek in common_events_to_fetch]
    )
    alliance_cache = {ek: data for ek, data in alliance_results if data}

    # Also fetch matches to check playoff opponents
    async def _matches_for(ek: str):
        data = await _safe(client.get_event_matches(ek))
        return (ek, data)

    match_results = await asyncio.gather(
        *[_matches_for(ek) for ek in common_events_to_fetch]
    )
    match_cache = {ek: data for ek, data in match_results if data}

    connections = []
    seen_pairs: set[str] = set()

    for (ta, tb), common in pair_common.items():
        pair_id = f"{ta}+{tb}"
        if pair_id in seen_pairs:
            continue

        partner_events = []
        opponent_events = []

        for ek in common:
            event_year = int(ek[:4])

            # Check partnership (same alliance) — find highest stage reached together
            were_partners = False
            alliance_result = None  # "winner", "finalist", or None
            for al in alliance_cache.get(ek, []):
                picks = al.get("picks", [])
                if ta in picks and tb in picks:
                    were_partners = True
                    # Check alliance playoff result
                    status = al.get("status", {})
                    if isinstance(status, dict):
                        s = status.get("status", "")
                        if s == "won":
                            alliance_result = "winner"
                        elif status.get("level", "") == "f":
                            alliance_result = "finalist"
                    break

            if were_partners:
                # Find highest playoff stage they played together
                partner_highest = None
                partner_highest_order = -1
                for m in match_cache.get(ek, []):
                    cl = m.get("comp_level", "qm")
                    if cl == "qm":
                        continue
                    red = m.get("alliances", {}).get("red", {}).get("team_keys", [])
                    blue = m.get("alliances", {}).get("blue", {}).get("team_keys", [])
                    if (ta in red and tb in red) or (ta in blue and tb in blue):
                        cl_order = {"ef": 1, "qf": 2, "sf": 3, "f": 4}.get(cl, 0)
                        if cl_order > partner_highest_order:
                            partner_highest_order = cl_order
                            partner_highest = cl

                partner_events.append({
                    "event_key": ek,
                    "event_name": event_name_map.get(ek, ek),
                    "year": event_year,
                    "stage": COMP_LEVEL_LABELS.get(partner_highest, "Playoffs") if partner_highest else "Alliance",
                    "result": alliance_result,
                })

            # Check playoff opponents — capture highest comp_level
            highest_level = None
            highest_order = -1
            for m in match_cache.get(ek, []):
                cl = m.get("comp_level", "qm")
                if cl == "qm":
                    continue
                red = m.get("alliances", {}).get("red", {}).get("team_keys", [])
                blue = m.get("alliances", {}).get("blue", {}).get("team_keys", [])
                if (ta in red and tb in blue) or (ta in blue and tb in red):
                    cl_order = {"ef": 1, "qf": 2, "sf": 3, "f": 4}.get(cl, 0)
                    if cl_order > highest_order:
                        highest_order = cl_order
                        highest_level = cl

            if highest_level:
                opponent_events.append({
                    "event_key": ek,
                    "event_name": event_name_map.get(ek, ek),
                    "year": event_year,
                    "stage": COMP_LEVEL_LABELS.get(highest_level, highest_level),
                })

        if partner_events or opponent_events:
            seen_pairs.add(pair_id)

            # Deduplicate per year — keep only the highest stage per year
            def _dedup_by_year(events):
                stage_order = {"Alliance": 0, "Playoffs": 0, "Eighths": 1, "Quarters": 2, "Semi-Finals": 3, "Finals": 4}
                best: dict[int, dict] = {}
                for e in events:
                    y = e["year"]
                    if y not in best or stage_order.get(e["stage"], 0) > stage_order.get(best[y]["stage"], 0):
                        best[y] = e
                return sorted(best.values(), key=lambda x: x["year"], reverse=True)

            connections.append({
                "team_a": int(ta.replace("frc", "")),
                "team_a_name": name_map.get(ta, ""),
                "team_b": int(tb.replace("frc", "")),
                "team_b_name": name_map.get(tb, ""),
                "partnered_at": _dedup_by_year(partner_events),
                "opponents_at": _dedup_by_year(opponent_events),
            })

    # Sort by most connections
    connections.sort(
        key=lambda c: len(c["partnered_at"]) + len(c["opponents_at"]),
        reverse=True,
    )
    return connections
