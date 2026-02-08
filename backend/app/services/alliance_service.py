"""Alliance selection analysis & partnership-history checker."""
from __future__ import annotations

import asyncio
from .tba_client import get_tba_client


async def _safe(coro):
    try:
        return await coro
    except Exception:
        return None


async def get_alliances_with_stats(event_key: str) -> dict:
    """Alliances + per-team qual stats + first-time-partner flags."""
    client = get_tba_client()

    alliances_raw, rankings, oprs, teams_list = await asyncio.gather(
        client.get_event_alliances(event_key),
        _safe(client.get_event_rankings(event_key)),
        _safe(client.get_event_oprs(event_key)),
        _safe(client.get_event_teams(event_key)),
    )

    if not alliances_raw:
        return {"alliances": [], "partnerships": {}}

    # ── Lookups ─────────────────────────────────────────────
    name_map: dict[str, str] = {}
    country_map: dict[str, str] = {}
    if teams_list:
        for t in teams_list:
            name_map[t["key"]] = t.get("nickname", "")
            country_map[t["key"]] = t.get("country", "")

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

    # ── Build alliance cards ────────────────────────────────
    alliances = []
    for idx, alliance in enumerate(alliances_raw):
        picks = alliance.get("picks", [])
        team_details = []
        for tk in picks:
            r = rank_map.get(tk, {})
            rec = r.get("record", {})
            o = opr_map.get(tk, {"opr": 0, "dpr": 0, "ccwm": 0})
            team_details.append(
                {
                    "team_key": tk,
                    "team_number": int(tk.replace("frc", "")),
                    "nickname": name_map.get(tk, ""),
                    "country": country_map.get(tk, ""),
                    "rank": r.get("rank", "-"),
                    "wins": rec.get("wins", 0),
                    "losses": rec.get("losses", 0),
                    "ties": rec.get("ties", 0),
                    "opr": o["opr"],
                    "dpr": o["dpr"],
                    "ccwm": o["ccwm"],
                }
            )
        alliances.append(
            {
                "number": idx + 1,
                "name": alliance.get("name", f"Alliance {idx + 1}"),
                "teams": team_details,
                "picks": picks,
            }
        )

    # ── Partnership history ─────────────────────────────────
    partnerships = await _check_all_partnerships(alliances_raw, event_key)

    return {"alliances": alliances, "partnerships": partnerships}


# ── Partnership history helpers ─────────────────────────────


async def _check_all_partnerships(
    alliances_raw: list[dict], event_key: str
) -> dict:
    """For every pair of alliance partners, check if they shared an
    alliance at a *prior* event across all seasons they've participated in."""
    client = get_tba_client()

    # Collect every team across all alliances
    all_teams: set[str] = set()
    for a in alliances_raw:
        all_teams.update(a.get("picks", []))

    # 1) Fetch years participated for each team
    async def _years_for(tk: str):
        data = await _safe(client.get_team_years_participated(tk))
        return (tk, data or [])

    year_results = await asyncio.gather(*[_years_for(tk) for tk in all_teams])
    team_years: dict[str, list[int]] = {tk: yrs for tk, yrs in year_results}

    # 2) Fetch each team's events for every year they participated
    async def _events_for(tk: str, y: int):
        data = await _safe(client.get_team_events(tk, y))
        return (tk, y, data or [])

    tasks = []
    for tk in all_teams:
        for y in team_years.get(tk, []):
            tasks.append(_events_for(tk, y))
    results = await asyncio.gather(*tasks)

    team_events: dict[str, set[str]] = {}
    for tk, _y, events in results:
        if tk not in team_events:
            team_events[tk] = set()
        for ev in events:
            team_events[tk].add(ev["key"])

    # 3) Identify all common events we'll need alliance data for
    events_to_fetch: set[str] = set()
    for a in alliances_raw:
        picks = a.get("picks", [])
        for i in range(len(picks)):
            for j in range(i + 1, len(picks)):
                common = (
                    team_events.get(picks[i], set())
                    & team_events.get(picks[j], set())
                ) - {event_key}
                events_to_fetch.update(common)

    # 4) Batch-fetch alliance data AND event info for those events
    async def _alliances_for(ek: str):
        data = await _safe(client.get_event_alliances(ek))
        return (ek, data)

    async def _event_info(ek: str):
        data = await _safe(client.get_event(ek))
        return (ek, data)

    alliance_results, event_info_results = await asyncio.gather(
        asyncio.gather(*[_alliances_for(ek) for ek in events_to_fetch]),
        asyncio.gather(*[_event_info(ek) for ek in events_to_fetch]),
    )
    alliance_cache: dict[str, list] = {
        ek: data for ek, data in alliance_results if data
    }
    event_name_cache: dict[str, str] = {
        ek: (info.get("name", ek) if info else ek)
        for ek, info in event_info_results
    }

    # 5) Check each pair
    partnerships: dict[str, dict] = {}
    for a in alliances_raw:
        picks = a.get("picks", [])
        for i in range(len(picks)):
            for j in range(i + 1, len(picks)):
                ta, tb = picks[i], picks[j]
                pair_key = f"{ta}+{tb}"
                common = (
                    team_events.get(ta, set())
                    & team_events.get(tb, set())
                ) - {event_key}

                history = []
                for ek in common:
                    for al in alliance_cache.get(ek, []):
                        ps = al.get("picks", [])
                        if ta in ps and tb in ps:
                            history.append(
                                {
                                    "event_key": ek,
                                    "event_name": event_name_cache.get(ek, ek),
                                    "year": int(ek[:4]),
                                    "alliance_name": al.get("name", ""),
                                }
                            )

                history.sort(key=lambda h: h["event_key"], reverse=True)

                partnerships[pair_key] = {
                    "first_time": len(history) == 0,
                    "history": history,
                }

    return partnerships
