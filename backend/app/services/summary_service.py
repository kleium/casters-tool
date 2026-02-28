"""Event Summary — demographics, Hall of Fame, prior connections, top scorers."""
from __future__ import annotations

import asyncio
from datetime import date
from .region_service import _load_region_stats, get_event_history
from .tba_client import get_tba_client


# ── Static HoF / Impact lookup (built once from region_stats.json) ───
_HOF_BY_NUM: dict[int, dict] | None = None
_IMPACT_BY_NUM: dict[int, dict] | None = None


def _ensure_award_lookups():
    """Flatten region_stats.json into dicts keyed by team_number."""
    global _HOF_BY_NUM, _IMPACT_BY_NUM
    if _HOF_BY_NUM is not None:
        return
    _HOF_BY_NUM = {}
    _IMPACT_BY_NUM = {}
    for _region, data in _load_region_stats().items():
        for entry in data.get("hof_teams", []):
            num = entry["team_number"]
            if num not in _HOF_BY_NUM:
                _HOF_BY_NUM[num] = entry
            else:
                # merge years from another region listing
                existing = _HOF_BY_NUM[num]
                existing["years"] = sorted(set(existing["years"]) | set(entry.get("years", [])))
        for entry in data.get("impact_finalists", []):
            num = entry["team_number"]
            if num not in _IMPACT_BY_NUM:
                _IMPACT_BY_NUM[num] = entry
            else:
                existing = _IMPACT_BY_NUM[num]
                existing["years"] = sorted(set(existing["years"]) | set(entry.get("years", [])))


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

    # ── Hall of Fame & Impact Award (instant lookup from region_stats.json) ─
    _ensure_award_lookups()
    hof_teams = []
    impact_finalists = []
    for t in teams:
        num = t.get("team_number")
        info = {
            "team_number": num,
            "nickname": t.get("nickname", ""),
            "city": t.get("city", ""),
            "state_prov": t.get("state_prov", ""),
            "country": t.get("country", ""),
        }
        if num in _HOF_BY_NUM:
            hof_teams.append({**info, "impact_years": _HOF_BY_NUM[num].get("years", [])})
        elif num in _IMPACT_BY_NUM:
            impact_finalists.append({**info, "impact_years": _IMPACT_BY_NUM[num].get("years", [])})

    # ── Top 3 OPR contributors ──────────────────────────────
    top_scorers = _compute_top_scorers(teams, oprs, rankings)

    return {
        "event_key": event_key,
        "demographics": demographics,
        "hall_of_fame": hof_teams,
        "impact_finalists": impact_finalists,
        "top_scorers": top_scorers,
    }


async def get_event_summary_awards(event_key: str) -> dict:
    """Deferred summary data — event history champions & previous-season awards.

    This is intentionally separated from the main summary so the UI can
    render the lightweight demographics / HoF / OPR data immediately and
    lazy-load this heavier section in the background.
    """
    client = get_tba_client()
    year = int(event_key[:4])

    # Parallel: event history + team list (teams needed for cross-reference)
    event_history, teams = await asyncio.gather(
        _safe(get_event_history(event_key)),
        client.get_event_teams_full(event_key),
    )

    if not teams:
        return {"past_event_champions": [], "past_season_awards": []}

    # Returning event champions & finalists (from event history)
    past_event_champions = _extract_past_event_champions(event_history, teams, year)

    # Previous season awards for all teams
    prev_year = year - 1
    prev_award_results = await asyncio.gather(
        *[_safe(client.get_team_awards_year(f"frc{t['team_number']}", prev_year))
          for t in teams]
    )
    past_season_awards = await _build_past_season_awards(
        client, teams, prev_award_results, prev_year,
    )

    return {
        "past_event_champions": past_event_champions,
        "past_season_awards": past_season_awards,
    }


# ── Helpers for past-event and past-season award data ───────

def _extract_past_event_champions(
    event_history: dict | None, teams: list[dict], current_year: int,
) -> list[dict]:
    """Cross-reference the event's historical timeline with the current
    participant list to find teams that previously won / were finalists here."""
    if not event_history or not event_history.get("timeline"):
        return []

    team_nums = {t["team_number"] for t in teams}
    name_map = {t["team_number"]: t.get("nickname", "") for t in teams}

    champ_map: dict[int, dict] = {}  # team_number -> {years_won, years_finalist}

    for yr_data in event_history["timeline"]:
        yr = yr_data["year"]
        if yr >= current_year:
            continue

        for w in yr_data.get("winners", []):
            num = w["team_number"]
            if num in team_nums:
                champ_map.setdefault(num, {"years_won": [], "years_finalist": []})
                champ_map[num]["years_won"].append(yr)

        for f in yr_data.get("finalists", []):
            num = f["team_number"]
            if num in team_nums:
                champ_map.setdefault(num, {"years_won": [], "years_finalist": []})
                champ_map[num]["years_finalist"].append(yr)

    result = []
    for num in sorted(champ_map):
        d = champ_map[num]
        result.append({
            "team_number": num,
            "nickname": name_map.get(num, ""),
            "years_won": sorted(d["years_won"]),
            "years_finalist": sorted(d["years_finalist"]),
        })
    return result


_AWARD_TYPE_IMPACT = 0
_AWARD_TYPE_WINNER = 1
_AWARD_TYPE_FINALIST = 2
_CHAMPIONSHIP_EVENT_TYPES = {3, 4}  # Championship Division / Finals


async def _build_past_season_awards(
    client, teams: list[dict], prev_award_results: list, prev_year: int,
) -> list[dict]:
    """Given per-team award results for the previous season, return a list
    of teams that earned Impact / Winner / Finalist at a regional or
    district event."""
    name_map = {t["team_number"]: t.get("nickname", "") for t in teams}
    team_award_map: dict[int, list[dict]] = {}
    award_event_keys: set[str] = set()

    for t, awards in zip(teams, prev_award_results):
        if not awards:
            continue
        num = t["team_number"]
        for a in awards:
            atype = a.get("award_type")
            if atype not in (_AWARD_TYPE_IMPACT, _AWARD_TYPE_WINNER, _AWARD_TYPE_FINALIST):
                continue
            ek = a.get("event_key", "")
            label = {0: "impact", 1: "winner", 2: "finalist"}.get(atype, "")
            team_award_map.setdefault(num, []).append({"type": label, "event_key": ek})
            award_event_keys.add(ek)

    if not team_award_map:
        return []

    # Batch-fetch event info so we can show friendly names & filter types
    infos = await asyncio.gather(
        *[_safe(client.get_event(ek)) for ek in award_event_keys]
    )
    event_names: dict[str, str] = {}
    event_types: dict[str, int] = {}
    for ek, info in zip(award_event_keys, infos):
        if info:
            event_names[ek] = info.get("short_name") or info.get("name", ek)
            event_types[ek] = info.get("event_type", -1)
        else:
            event_names[ek] = ek
            event_types[ek] = -1

    result = []
    for num in sorted(team_award_map):
        filtered = []
        for a in team_award_map[num]:
            ek = a["event_key"]
            if event_types.get(ek) in _CHAMPIONSHIP_EVENT_TYPES:
                continue
            filtered.append({
                "type": a["type"],
                "event_key": ek,
                "event_name": event_names.get(ek, ek),
            })
        if filtered:
            result.append({
                "team_number": num,
                "nickname": name_map.get(num, ""),
                "awards": filtered,
            })
    return result


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


async def get_event_connections(event_key: str, all_time: bool = False) -> list[dict]:
    """Public entry point to fetch connections with configurable lookback."""
    client = get_tba_client()
    year = int(event_key[:4])
    teams = await client.get_event_teams_full(event_key)
    if not teams:
        return []
    lookback = None if all_time else 3
    return await _find_playoff_connections(teams, event_key, year, lookback_years=lookback)


async def get_match_connections(event_key: str, team_numbers: list[int], all_time: bool = False) -> list[dict]:
    """Fetch prior playoff connections for a specific set of teams (e.g. the 6 on the field)."""
    client = get_tba_client()
    year = int(event_key[:4])
    # Build minimal team dicts from team numbers
    team_keys = [f"frc{n}" for n in team_numbers]
    tasks = [client.get_team(tk) for tk in team_keys]
    raw_teams = await asyncio.gather(*tasks)
    teams = [t for t in raw_teams if t]
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
        # Include current year so earlier events in the same season count
        check_years = list(range(max(2015, year - lookback_years), year + 1))
    else:
        # All-time: go back to the earliest rookie year among the teams
        rookie_years = [t.get("rookie_year", year) for t in teams if t.get("rookie_year")]
        earliest = min(rookie_years) if rookie_years else 2015
        check_years = list(range(max(2000, earliest), year + 1))

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

    # team -> set of event_keys (excluding current and offseason/preseason)
    # Also build event name map from fetched data
    _SKIP_EVENT_TYPES = {99, 100, -1}  # Offseason, Preseason, Unknown
    team_events: dict[str, set[str]] = {}
    event_name_map: dict[str, str] = {}  # event_key -> short/display name
    for tk, _y, events in results:
        if tk not in team_events:
            team_events[tk] = set()
        for ev in events:
            ek = ev["key"]
            if ev.get("event_type", -1) in _SKIP_EVENT_TYPES:
                continue
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

            # Deduplicate per event — keep only the highest stage per event_key
            def _dedup_by_event(events):
                stage_order = {"Alliance": 0, "Playoffs": 0, "Eighths": 1, "Quarters": 2, "Semi-Finals": 3, "Finals": 4}
                best: dict[str, dict] = {}
                for e in events:
                    ek = e["event_key"]
                    if ek not in best or stage_order.get(e["stage"], 0) > stage_order.get(best[ek]["stage"], 0):
                        best[ek] = e
                return sorted(best.values(), key=lambda x: x["year"], reverse=True)

            connections.append({
                "team_a": int(ta.replace("frc", "")),
                "team_a_name": name_map.get(ta, ""),
                "team_b": int(tb.replace("frc", "")),
                "team_b_name": name_map.get(tb, ""),
                "partnered_at": _dedup_by_event(partner_events),
                "opponents_at": _dedup_by_event(opponent_events),
            })

    # Sort by most connections
    connections.sort(
        key=lambda c: len(c["partnered_at"]) + len(c["opponents_at"]),
        reverse=True,
    )
    return connections
