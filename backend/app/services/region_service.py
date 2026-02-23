"""Region & Event History — static region facts + dynamic per-event history."""
from __future__ import annotations

import asyncio
import json
from collections import Counter, defaultdict
from pathlib import Path

from .tba_client import get_tba_client

# ── Static region data (pre-generated) ──────────────────────
_REGION_STATS: dict | None = None
_REGION_STATS_PATH = Path(__file__).resolve().parent.parent.parent.parent / "docs" / "data" / "region_stats.json"


def _load_region_stats() -> dict:
    global _REGION_STATS
    if _REGION_STATS is None:
        try:
            with open(_REGION_STATS_PATH) as f:
                _REGION_STATS = json.load(f)
        except FileNotFoundError:
            _REGION_STATS = {}
    return _REGION_STATS


def get_region_facts(region_name: str) -> dict | None:
    """Return pre-computed region facts by region name. Instant — no API calls."""
    stats = _load_region_stats()
    return stats.get(region_name)


def list_regions() -> list[str]:
    """Return all known region names."""
    return sorted(_load_region_stats().keys())


# ── Award type constants ────────────────────────────────────
_AWARD_WINNER = 1        # Event Winner
_AWARD_FINALIST = 2      # Event Finalist
_AWARD_IMPACT = 0        # Chairman's / FIRST Impact Award
_AWARD_EI = 9            # Engineering Inspiration Award
_AWARD_RAS = 10          # Rookie All-Star Award
_AWARD_WF = 3            # Woodie Flowers Finalist Award

# ── Event code aliases — maps event lineages that changed codes over the years ──
# Each entry: canonical current code -> set of all historical codes for the same event.
# This handles the ~2012–2013 TBA code migration and other renames.
_EVENT_CODE_ALIASES: dict[str, set[str]] = {
    # Florida
    "flor":  {"fl", "flor"},                              # Orlando / Kennedy Space Center / Florida Regional
    "flwp":  {"sfl", "flbr", "flfo", "flwp"},             # South Florida Regional
    # Ohio
    "ohcl":  {"oh", "ohcl"},                              # Buckeye Regional
    # Louisiana
    "lake":  {"la", "lake"},                               # Bayou Regional
    # South Carolina
    "scmb":  {"sc", "scmb"},                               # Palmetto Regional
    # Georgia / Peachtree
    "gadu":  {"ga", "gadu"},                               # Peachtree Regional
    # California
    "cala":  {"ca", "calb", "capo", "cala"},               # Los Angeles Regional
    "casj":  {"ca2", "sj", "casj"},                        # Silicon Valley Regional
    "cada":  {"sac", "casa", "cada"},                      # Sacramento Regional
    # Pennsylvania
    "paca":  {"papi", "paca"},                             # Greater Pittsburgh Regional
    # Maryland / Chesapeake (Regional era only)
    "mdba":  {"md", "mdba", "mdcp"},                       # Chesapeake Regional
    # Illinois
    "ilch":  {"il", "ilch"},                               # Midwest Regional
    # Michigan
    "gl":    {"mi", "mi1", "gl"},                          # Great Lakes Regional
    # Texas
    "txsa":  {"stx", "txsa"},                              # Alamo Regional
    # New Hampshire
    "nhgrs": {"nh", "nhgrs", "nhsal"},                     # Granite State
    # New York
    "nyro":  {"roc", "nyro"},                              # Finger Lakes Regional
    "nyli2": {"li", "nyli", "nyli2"},                      # Long Island Regional
    "nyny":  {"ny2", "nyny"},                              # New York City Regional
    "nytr":  {"ny", "nyal", "nytr"},                       # New York Tech Valley Regional
    # Massachusetts
    "mabos": {"ma", "mabos"},                              # Boston / Greater Boston
    # Connecticut
    "ctha":  {"ct", "ctha"},                               # Connecticut Regional
    # Colorado
    "code":  {"co", "code"},                               # Colorado Regional
    # Hawaii
    "hiho":  {"hi", "hiho"},                               # Hawaii Regional
    # Utah
    "utwv":  {"ut", "utwv"},                               # Utah Regional
    # Wisconsin
    "wimi":  {"wi", "wimi"},                               # Wisconsin Regional
    # Minnesota
    "mnmi":  {"mn", "mnmi"},                               # Minnesota Regional
    # Oklahoma
    "okok":  {"ok", "okok"},                               # Oklahoma Regional
    # Arkansas
    "arli":  {"arfa", "arli"},                             # Arkansas Regional
    # Arizona
    "azva":  {"az", "azva"},                               # Arizona Regional
    # Waterloo
    "onwat": {"wat", "onwat"},                             # Waterloo Regional
}

# Build reverse lookup: any code -> set of all sibling codes
_CODE_TO_FAMILY: dict[str, set[str]] = {}
for _canonical, _aliases in _EVENT_CODE_ALIASES.items():
    for _code in _aliases:
        _CODE_TO_FAMILY[_code] = _aliases


async def _safe(coro):
    try:
        return await coro
    except Exception:
        return None


async def get_event_history(event_key: str) -> dict:
    """
    Build the history for a recurring event.
    Uses event code aliases and name matching to find all past instances,
    then aggregates award data across years.
    """
    client = get_tba_client()

    # Get the current event's info
    event = await client.get_event(event_key)
    if not event:
        return {"error": "Event not found"}

    event_code = event.get("first_event_code", "") or event_key[4:]
    event_country = event.get("country", "") or ""
    event_name = event.get("name", event_key)
    event_short = (event.get("short_name") or "").lower().strip()
    current_year = int(event_key[:4])

    # Determine the full set of codes that belong to this event's lineage
    key_code = event_key[4:]
    alias_codes = _CODE_TO_FAMILY.get(key_code, {key_code})
    if event_code and event_code != key_code:
        alias_codes = alias_codes | _CODE_TO_FAMILY.get(event_code, {event_code})

    # Find all historical instances of this event
    all_instances: list[dict] = []

    # Scan from 1992 (first FRC season) through current year
    year_tasks = []
    for year in range(1992, current_year + 1):
        year_tasks.append((year, client.get_events_by_year(year)))

    year_results = await asyncio.gather(*[t[1] for t in year_tasks])

    # Determine whether we matched via a curated alias map
    used_alias_map = key_code in _CODE_TO_FAMILY

    for (year, _), events in zip(year_tasks, year_results):
        if not events:
            continue
        for ev in events:
            ec = ev.get("first_event_code", "") or ""
            ev_key_code = ev["key"][4:]  # remove year prefix
            # Match by alias family, first_event_code, or direct key code
            if ev_key_code in alias_codes or (ec and ec in alias_codes):
                all_instances.append(ev)

    # Filter out events that reused the same code but are actually different
    # (e.g. tuis3 was Izmir in 2022-2023 then Marmara in 2024-2025).
    # Skip this filter when matches came from a curated alias map — those
    # intentionally span name changes (e.g. "Florida Regional" → "Orlando Regional").
    if not used_alias_map and event_short and len(all_instances) > 1:
        filtered = []
        for ev in all_instances:
            ev_short = (ev.get("short_name") or "").lower().strip()
            if ev_short == event_short:
                filtered.append(ev)
        # Only use the filtered list if it kept at least the current event
        if filtered:
            all_instances = filtered

    if not all_instances:
        # Fallback: at minimum include the current event
        all_instances = [event]

    # Sort by year
    all_instances.sort(key=lambda e: e.get("start_date", ""))

    # Fetch awards for all instances in parallel
    award_tasks = [(ev["key"], _safe(client.get(f"/event/{ev['key']}/awards")))
                   for ev in all_instances]
    award_results = await asyncio.gather(*[t[1] for t in award_tasks])

    # Aggregate stats
    winners: Counter = Counter()       # team_key -> win count
    finalists: Counter = Counter()     # team_key -> finalist count
    impact_winners: Counter = Counter() # team_key -> impact count
    ei_winners: Counter = Counter()    # team_key -> EI count
    ras_winners: Counter = Counter()   # team_key -> RAS count

    # Track team info for display
    team_info_map: dict[str, dict] = {}

    yearly_results: list[dict] = []

    for (ek, _), awards in zip(award_tasks, award_results):
        if not awards:
            continue
        year = int(ek[:4])
        year_data: dict = {"year": year, "event_key": ek, "winners": [], "finalists": [], "impact": None}

        for a in awards:
            atype = a.get("award_type")
            for r in a.get("recipient_list", []):
                tk = r.get("team_key")
                if not tk:
                    continue

                # Store basic info
                if tk not in team_info_map:
                    team_info_map[tk] = {"team_number": int(tk[3:]), "nickname": ""}

                if atype == _AWARD_WINNER:
                    winners[tk] += 1
                    year_data["winners"].append(tk)
                elif atype == _AWARD_FINALIST:
                    finalists[tk] += 1
                    year_data["finalists"].append(tk)
                elif atype == _AWARD_IMPACT:
                    impact_winners[tk] += 1
                    year_data["impact"] = tk
                elif atype == _AWARD_EI:
                    ei_winners[tk] += 1
                elif atype == _AWARD_RAS:
                    ras_winners[tk] += 1

        yearly_results.append(year_data)

    # Fetch team info for top teams (names)
    top_tks = set()
    for counter in [winners, finalists, impact_winners, ei_winners]:
        for tk, _ in counter.most_common(10):
            top_tks.add(tk)

    # Also add all winners/finalists from yearly results
    for yr in yearly_results:
        top_tks.update(yr.get("winners", []))
        top_tks.update(yr.get("finalists", []))
        if yr.get("impact"):
            top_tks.add(yr["impact"])

    # Batch-fetch team descriptions
    missing_tks = [tk for tk in top_tks if team_info_map.get(tk, {}).get("nickname") == ""]
    if missing_tks:
        results = await asyncio.gather(
            *[_safe(client.get(f"/team/{tk}")) for tk in missing_tks]
        )
        for tk, info in zip(missing_tks, results):
            if info:
                team_info_map[tk] = {
                    "team_number": info.get("team_number", int(tk[3:])),
                    "nickname": info.get("nickname", ""),
                }

    def _build_leaderboard(counter: Counter, limit: int = 10) -> list[dict]:
        result = []
        for tk, count in counter.most_common(limit):
            info = team_info_map.get(tk, {})
            result.append({
                "team_number": info.get("team_number", int(tk[3:])),
                "nickname": info.get("nickname", ""),
                "count": count,
            })
        return result

    def _resolve_teams(tks: list[str]) -> list[dict]:
        return [{
            "team_number": team_info_map.get(tk, {}).get("team_number", int(tk[3:])),
            "nickname": team_info_map.get(tk, {}).get("nickname", ""),
        } for tk in tks]

    # Build year-by-year timeline
    timeline = []
    for yr in yearly_results:
        timeline.append({
            "year": yr["year"],
            "event_key": yr["event_key"],
            "winners": _resolve_teams(yr.get("winners", [])),
            "finalists": _resolve_teams(yr.get("finalists", [])),
            "impact": _resolve_teams([yr["impact"]])[0] if yr.get("impact") else None,
        })
    timeline.sort(key=lambda x: x["year"], reverse=True)

    first_instance = all_instances[0]
    first_year = int(first_instance["key"][:4])

    return {
        "event_name": event_name,
        "event_key": event_key,
        "first_held": first_year,
        "editions": len(all_instances),
        "years_held": sorted(int(e["key"][:4]) for e in all_instances),
        "most_wins": _build_leaderboard(winners, 10),
        "most_finalists": _build_leaderboard(finalists, 10),
        "most_impact": _build_leaderboard(impact_winners, 10),
        "most_ei": _build_leaderboard(ei_winners, 5),
        "most_ras": _build_leaderboard(ras_winners, 5),
        "timeline": timeline,
    }
