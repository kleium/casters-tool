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

    # Parallel fetch: teams (full detail), rankings, OPRs
    teams, rankings, oprs = await asyncio.gather(
        client.get_event_teams_full(event_key),
        _safe(client.get_event_rankings(event_key)),
        _safe(client.get_event_oprs(event_key)),
    )

    if not teams:
        return {"error": "No teams found for this event."}

    # ── Demographics ────────────────────────────────────────
    total = len(teams)
    rookie_count = 0
    veteran_count = 0   # 5+ years active
    countries: set[str] = set()
    foreign_count = 0   # non-Turkish for this regional context

    for t in teams:
        ry = t.get("rookie_year")
        country = t.get("country", "") or ""
        if country:
            countries.add(country)
        # "Foreign" = not Turkish (matches the existing highlight feature)
        if country and country not in ("Turkey", "Türkiye", "Turkiye"):
            foreign_count += 1
        if ry and ry == year:
            rookie_count += 1
        elif ry and (year - ry) >= 5:
            veteran_count += 1

    demographics = {
        "total_teams": total,
        "rookie_count": rookie_count,
        "rookie_pct": round(100 * rookie_count / total, 1) if total else 0,
        "veteran_count": veteran_count,
        "veteran_pct": round(100 * veteran_count / total, 1) if total else 0,
        "foreign_count": foreign_count,
        "foreign_pct": round(100 * foreign_count / total, 1) if total else 0,
        "country_count": len(countries),
        "countries": sorted(countries),
    }

    # ── Hall of Fame & Impact Award ─────────────────────────
    hof_teams, impact_finalists = await _get_award_teams(client, teams)

    # ── Top 3 OPR contributors ──────────────────────────────
    top_scorers = _compute_top_scorers(teams, oprs, rankings)

    # ── Prior playoff connections ───────────────────────────
    connections = await _find_playoff_connections(teams, event_key, year)

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
            # HoF = Chairman's/Impact Award (type 0) at Championship
            if atype == 0 and "cmp" in ek:
                is_hof = True
                impact_years.append(yr)
            # Impact finalist (type 69) at Championship only
            if atype == 69 and "cmp" in ek:
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


async def _find_playoff_connections(
    teams: list[dict], event_key: str, year: int
) -> list[dict]:
    """Find pairs of teams at this event who have prior playoff history."""
    client = get_tba_client()
    team_keys = [t["key"] for t in teams]
    name_map = {t["key"]: t.get("nickname", "") for t in teams}

    # Only check last 3 years for performance
    check_years = list(range(max(2015, year - 3), year))

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
    team_events: dict[str, set[str]] = {}
    for tk, _y, events in results:
        if tk not in team_events:
            team_events[tk] = set()
        for ev in events:
            if ev["key"] != event_key:
                team_events[tk].add(ev["key"])

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
            for al in alliance_cache.get(ek, []):
                picks = al.get("picks", [])
                if ta in picks and tb in picks:
                    were_partners = True
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
                    "year": event_year,
                    "stage": COMP_LEVEL_LABELS.get(partner_highest, "Playoffs") if partner_highest else "Alliance",
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
