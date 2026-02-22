#!/usr/bin/env python3
"""
One-time generator: build region_stats.json with pre-computed facts per region/district.

Regions are defined by the event's resolved region (same logic as event_service.py):
  - US district events -> district display_name (e.g. "FIRST in Michigan")
  - US non-district events -> state-based region (e.g. "Pacific", "Texas")
  - International events -> country (e.g. "Türkiye", "Israel")

Teams are attributed to the region where they compete most often.

Usage:
    python scripts/generate_region_stats.py
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.app.services.tba_client import get_tba_client

# ── Same region resolution as event_service.py ──────────────
_REGION_MAP = {
    "New England": {"NH", "MA", "CT", "RI", "VT", "ME"},
    "Mid-Atlantic": {"NY", "NJ", "PA", "DE", "MD", "DC"},
    "Southeast": {"VA", "NC", "SC", "GA", "FL", "AL", "MS", "TN", "KY", "WV", "LA", "AR"},
    "Midwest": {"OH", "IN", "IL", "MI", "WI", "MN", "IA", "MO", "ND", "SD", "NE", "KS"},
    "Texas": {"TX"},
    "Mountain": {"MT", "WY", "CO", "NM", "AZ", "UT", "ID", "NV"},
    "Pacific": {"WA", "OR", "CA", "HI", "AK"},
}

_COUNTRY_LABELS = (
    "Türkiye", "Israel", "Canada", "China", "Australia", "Brazil", "Mexico",
    "Chinese Taipei", "India", "Japan", "Chile", "Colombia", "Egypt", "Poland",
    "Dominican Republic", "Paraguay", "Morocco", "United Kingdom", "Netherlands",
    "Croatia", "Romania", "Kazakhstan", "France", "Germany", "Switzerland",
    "Argentina", "South Korea", "Czech Republic", "Denmark", "Ethiopia",
    "Finland", "Georgia", "Hungary", "Indonesia", "Ireland", "Italy",
    "Jordan", "Kenya", "Lebanon", "Lithuania", "Malaysia", "Malta",
    "New Zealand", "Nigeria", "Norway", "Pakistan", "Peru", "Philippines",
    "Portugal", "Puerto Rico", "Qatar", "Rwanda", "Saudi Arabia", "Singapore",
    "Slovakia", "Slovenia", "South Africa", "Spain", "Sweden", "Taiwan",
    "Thailand", "Tunisia", "Ukraine", "United Arab Emirates", "Vietnam",
    "Kosovo", "Bosnia and Herzegovina", "Serbia", "Montenegro",
    "North Macedonia", "Albania", "Ecuador", "Bolivia", "Guatemala",
    "Honduras", "Nicaragua", "Costa Rica", "Panama", "Cuba", "Bahrain",
    "Oman", "Kuwait", "Korea",
)

_EXCLUDE_TYPES = {99, 100, -1}

# Pre-district regions that transitioned to a district system.
_REGION_MERGE = {
    "Israel": "FIRST Israel",
    "Texas": "FIRST In Texas",
}

_COUNTRY_NORMALIZE = {
    "turkey": "Türkiye", "türkiye": "Türkiye", "turkiye": "Türkiye",
}


def _norm(c: str) -> str:
    return _COUNTRY_NORMALIZE.get(c.lower().strip(), c)


def _resolve_event_region(ev: dict) -> str:
    district = ev.get("district")
    country = _norm(ev.get("country", "") or "")
    state_prov = ev.get("state_prov", "") or ""
    if district and district.get("abbreviation"):
        return district.get("display_name") or district["abbreviation"].upper()
    if country and country not in ("USA", ""):
        for label in _COUNTRY_LABELS:
            if label.lower() in country.lower() or country.lower() in label.lower():
                return _REGION_MERGE.get(label, label)
        return country
    for region, states in _REGION_MAP.items():
        if state_prov in states:
            return _REGION_MERGE.get(region, region)
    return "Other"


async def _safe(coro):
    try:
        return await coro
    except Exception:
        return None


async def generate():
    client = get_tba_client()
    BATCH = 25
    FIRST_YEAR, CURRENT_YEAR = 1992, 2025

    # ── Phase 1 ───────────────────────────────────────────────
    print("Phase 1: Fetching events for all years...")
    all_events: list[dict] = []
    year_events: dict[int, list] = {}
    for year in range(FIRST_YEAR, CURRENT_YEAR + 1):
        raw = await client.get_events_by_year(year)
        official = [e for e in raw if e.get("event_type", -1) not in _EXCLUDE_TYPES]
        year_events[year] = official
        all_events.extend(official)
        print(f"  {year}: {len(official)} events")

    # ── Phase 2: Group events by region ───────────────────────
    print("\nPhase 2: Grouping events by region...")
    region_events: dict[str, list[dict]] = defaultdict(list)
    for ev in all_events:
        region_events[_resolve_event_region(ev)].append(ev)
    print(f"  Found {len(region_events)} distinct regions")

    region_meta: dict[str, dict] = {}
    for region, evs in region_events.items():
        years = sorted({int(e["key"][:4]) for e in evs})
        first_ev = min(evs, key=lambda e: e.get("start_date", "9999"))
        region_meta[region] = {
            "first_event_year": years[0] if years else None,
            "first_event_name": first_ev.get("name", first_ev["key"]),
            "active_years": years,
            "total_events": len(evs),
        }

    # ── Phase 3: Fetch team rosters (4 recent seasons) ────────
    print("\nPhase 3: Fetching team rosters (last 4 seasons)...")
    SAMPLE_YEARS = list(range(2022, CURRENT_YEAR + 1))

    team_info: dict[str, dict] = {}
    team_region_counts: dict[str, Counter] = defaultdict(Counter)
    region_visitors_raw: dict[str, Counter] = defaultdict(Counter)
    active_current_season: set[str] = set()  # team keys active in CURRENT_YEAR

    for year in SAMPLE_YEARS:
        evs = year_events.get(year, [])
        results = await asyncio.gather(
            *[_safe(client.get_event_teams_full(e["key"])) for e in evs]
        )
        for ev, teams in zip(evs, results):
            if not teams:
                continue
            region = _resolve_event_region(ev)
            ev_country = _norm(ev.get("country", "") or "")
            for t in teams:
                tk = t["key"]
                tc = _norm(t.get("country", "") or "")
                if tk not in team_info:
                    team_info[tk] = {
                        "team_number": t.get("team_number"),
                        "nickname": t.get("nickname", ""),
                        "country": tc,
                        "state_prov": t.get("state_prov", ""),
                    }
                team_region_counts[tk][region] += 1
                if year == CURRENT_YEAR:
                    active_current_season.add(tk)
                if ev_country and tc and tc != ev_country:
                    region_visitors_raw[region][tk] += 1
        print(f"  {year}: done ({len(evs)} events)")

    # Resolve home region = most-attended region
    team_home: dict[str, str] = {
        tk: counts.most_common(1)[0][0] for tk, counts in team_region_counts.items()
    }
    region_team_count = Counter(team_home.values())

    # Current-season active teams per home region
    current_season_by_region: Counter = Counter(
        team_home[tk] for tk in active_current_season if tk in team_home
    )

    print(f"  Unique teams: {len(team_info)}, active {CURRENT_YEAR}: {len(active_current_season)}")

    # ── Phase 4: Championship analysis ────────────────────────
    print("\nPhase 4: Championship awards & Einstein...")
    champ_keys = [e["key"] for e in all_events if e.get("event_type") in (3, 4)]
    einstein_keys = [e["key"] for e in all_events if e.get("event_type") == 4]
    print(f"  CMP events: {len(champ_keys)}, Einstein: {len(einstein_keys)}")

    hof_by_team: dict[str, list[int]] = defaultdict(list)
    impact_fin_by_team: dict[str, list[int]] = defaultdict(list)

    print("  Fetching CMP awards...")
    for i in range(0, len(champ_keys), BATCH):
        batch = champ_keys[i:i + BATCH]
        results = await asyncio.gather(
            *[_safe(client.get(f"/event/{ek}/awards")) for ek in batch]
        )
        for ek, awards in zip(batch, results):
            if not awards:
                continue
            yr = int(ek[:4])
            for a in awards:
                at = a.get("award_type")
                for r in a.get("recipient_list", []):
                    tk = r.get("team_key")
                    if not tk:
                        continue
                    if at == 0:
                        hof_by_team[tk].append(yr)
                    elif at == 69:
                        impact_fin_by_team[tk].append(yr)

    einstein_by_team: dict[str, list[int]] = defaultdict(list)
    print("  Fetching Einstein match data (robot appearances only)...")
    results = await asyncio.gather(
        *[_safe(client.get(f"/event/{ek}/matches/simple")) for ek in einstein_keys]
    )
    # Also fetch rosters as fallback for years without match data
    roster_results = await asyncio.gather(
        *[_safe(client.get(f"/event/{ek}/teams/simple")) for ek in einstein_keys]
    )
    for ek, matches, roster in zip(einstein_keys, results, roster_results):
        yr = int(ek[:4])
        teams_in_matches: set[str] = set()
        if matches:
            for m in matches:
                for color in ("red", "blue"):
                    teams_in_matches.update(
                        m.get("alliances", {}).get(color, {}).get("team_keys", [])
                    )
        if teams_in_matches:
            # Use match data — only teams whose robots competed
            for tk in teams_in_matches:
                einstein_by_team[tk].append(yr)
        elif roster:
            # Fallback for older events without match data
            for t in roster:
                einstein_by_team[t["key"]].append(yr)

    print(f"  HoF: {len(hof_by_team)}, Impact fin: {len(impact_fin_by_team)}, Einstein: {len(einstein_by_team)}")

    # ── Phase 5: Fetch missing team info ──────────────────────
    print("\nPhase 5: Fetching additional team info...")
    needed = set(hof_by_team) | set(impact_fin_by_team) | set(einstein_by_team)
    missing = [tk for tk in needed if tk not in team_info]
    print(f"  Missing: {len(missing)}")
    for i in range(0, len(missing), BATCH):
        batch = missing[i:i + BATCH]
        results = await asyncio.gather(
            *[_safe(client.get(f"/team/{tk}")) for tk in batch]
        )
        for tk, info in zip(batch, results):
            if info:
                team_info[tk] = {
                    "team_number": info.get("team_number"),
                    "nickname": info.get("nickname", ""),
                    "country": _norm(info.get("country", "") or ""),
                    "state_prov": info.get("state_prov", ""),
                }

    def _true_home(tk: str) -> str:
        """Resolve a team's home region from their TBA-registered address,
        NOT from which events they attend (avoids crediting visitors)."""
        inf = team_info.get(tk, {})
        c = inf.get("country", "")
        sp = inf.get("state_prov", "")
        result = None
        # International team → match by country label
        if c and c not in ("USA", ""):
            for lab in _COUNTRY_LABELS:
                if lab.lower() in c.lower() or c.lower() in lab.lower():
                    result = lab
                    break
            if result is None:
                result = c
        # US team → check if their state belongs to a district first
        elif sp:
            home = team_home.get(tk)
            if home and home.startswith("FIRST"):
                result = home
            else:
                for reg, sts in _REGION_MAP.items():
                    if sp in sts:
                        result = reg
                        break
        if result is None:
            result = team_home.get(tk, "Other")
        # Apply merge mapping (e.g. "Israel" → "FIRST Israel")
        return _REGION_MERGE.get(result, result)

    # ── Phase 6: Map achievements to regions ──────────────────
    print("\nPhase 6: Mapping achievements to home regions...")
    build = lambda: defaultdict(list)
    r_hof, r_imp, r_ein = build(), build(), build()

    for tk, yrs in hof_by_team.items():
        reg = _true_home(tk)
        inf = team_info.get(tk, {})
        r_hof[reg].append({
            "team_number": inf.get("team_number", int(tk[3:])),
            "nickname": inf.get("nickname", ""),
            "years": sorted(set(yrs)),
        })

    for tk, yrs in impact_fin_by_team.items():
        reg = _true_home(tk)
        inf = team_info.get(tk, {})
        r_imp[reg].append({
            "team_number": inf.get("team_number", int(tk[3:])),
            "nickname": inf.get("nickname", ""),
            "years": sorted(set(yrs)),
        })

    for tk, yrs in einstein_by_team.items():
        reg = _true_home(tk)
        inf = team_info.get(tk, {})
        r_ein[reg].append({
            "team_number": inf.get("team_number", int(tk[3:])),
            "nickname": inf.get("nickname", ""),
            "years": sorted(set(yrs)),
        })

    # ── Phase 7: International visitors ───────────────────────
    print("\nPhase 7: Top international visitors...")
    r_vis: dict[str, list] = {}
    for region, counts in region_visitors_raw.items():
        # Include all visitors with more than 1 appearance
        multi = [(tk, cnt) for tk, cnt in counts.most_common() if cnt > 1]
        items = []
        for tk, cnt in multi:
            inf = team_info.get(tk, {})
            items.append({
                "team_number": inf.get("team_number", int(tk[3:])),
                "nickname": inf.get("nickname", ""),
                "country": inf.get("country", ""),
                "appearances": cnt,
            })
        if items:
            r_vis[region] = items

    # ── Phase 8: Assemble ─────────────────────────────────────
    print("\nPhase 8: Assembling...")
    output = {}
    for rn in sorted(region_events):
        m = region_meta[rn]
        hof = sorted(r_hof.get(rn, []), key=lambda x: x.get("team_number", 0))
        imp = sorted(r_imp.get(rn, []), key=lambda x: x.get("team_number", 0))
        ein = sorted(r_ein.get(rn, []),
                     key=lambda x: (-len(x.get("years", [])), x.get("team_number", 0)))
        output[rn] = {
            "first_event_year": m["first_event_year"],
            "first_event_name": m["first_event_name"],
            "active_years": m["active_years"],
            "total_events": m["total_events"],
            "team_count": region_team_count.get(rn, 0),
            "current_season_teams": current_season_by_region.get(rn, 0),
            "hof_teams": hof,
            "hof_count": len(hof),
            "impact_finalists": imp,
            "impact_count": len(imp),
            "einstein_teams": ein[:25],
            "einstein_count": len(ein),
            "top_international_visitors": r_vis.get(rn, []),
        }

    # ── Phase 8b: Merge pre-district regions into districts ───
    # Regions that transitioned from regionals to a district system
    # get their pre-district event history folded into the district entry.
    _MERGE_INTO = {
        "Israel": "FIRST Israel",      # Israel regionals 2005-2016 → FIS district 2017+
        "Texas": "FIRST In Texas",     # Texas regionals 1998-2018 → FIT district 2019+
    }
    _DROP = {"San Jose"}  # one-off region with 0 teams

    for src, dst in _MERGE_INTO.items():
        if src not in output or dst not in output:
            continue
        s, d = output[src], output[dst]
        print(f"  Merging '{src}' → '{dst}'")

        # Merge first event (take the earlier)
        if (s["first_event_year"] or 9999) < (d["first_event_year"] or 9999):
            d["first_event_year"] = s["first_event_year"]
            d["first_event_name"] = s["first_event_name"]

        # Merge active years + event counts
        d["active_years"] = sorted(set(d["active_years"]) | set(s["active_years"]))
        d["total_events"] += s["total_events"]
        d["team_count"] += s["team_count"]
        d["current_season_teams"] = d.get("current_season_teams", 0) + s.get("current_season_teams", 0)

        # Merge achievement lists (deduplicate by team_number)
        def _merge_list(dst_list, src_list, sort_key):
            seen = {t["team_number"] for t in dst_list}
            for t in src_list:
                if t["team_number"] not in seen:
                    dst_list.append(t)
                    seen.add(t["team_number"])
                else:
                    # Merge years for same team
                    for existing in dst_list:
                        if existing["team_number"] == t["team_number"]:
                            existing["years"] = sorted(set(existing.get("years", [])
                                                           + t.get("years", [])))
                            break
            return sorted(dst_list, key=sort_key)

        d["hof_teams"] = _merge_list(d["hof_teams"], s["hof_teams"],
                                      lambda x: x.get("team_number", 0))
        d["hof_count"] = len(d["hof_teams"])

        d["impact_finalists"] = _merge_list(d["impact_finalists"], s["impact_finalists"],
                                             lambda x: x.get("team_number", 0))
        d["impact_count"] = len(d["impact_finalists"])

        all_ein = list(d.get("einstein_teams", []))
        _merge_list(all_ein, s.get("einstein_teams", []),
                    lambda x: (-len(x.get("years", [])), x.get("team_number", 0)))
        d["einstein_teams"] = all_ein[:25]
        d["einstein_count"] = max(d.get("einstein_count", 0),
                                  len(all_ein))  # true count

        # Merge visitors – combine counts for same team, keep all with appearances > 1
        dst_vis = d.get("top_international_visitors", [])
        src_vis = s.get("top_international_visitors", [])
        by_num = {v["team_number"]: v for v in dst_vis}
        for v in src_vis:
            tn = v["team_number"]
            if tn in by_num:
                by_num[tn]["appearances"] += v["appearances"]
            else:
                by_num[tn] = dict(v)
        merged = sorted(by_num.values(),
                        key=lambda x: (-x["appearances"], x["team_number"]))
        d["top_international_visitors"] = [v for v in merged if v["appearances"] > 1]

        del output[src]

    for drop in _DROP:
        output.pop(drop, None)

    print(f"  Final regions: {len(output)}")

    out_path = Path(__file__).resolve().parent.parent / "frontend" / "data" / "region_stats.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"\nDone! -> {out_path}")
    print(f"Regions: {len(output)}")
    for name, d in sorted(output.items(), key=lambda x: -x[1]["team_count"]):
        print(f"  {name}: {d['team_count']} teams, {d['total_events']} events, "
              f"{d['hof_count']} HoF, {d['einstein_count']} Einstein")


if __name__ == "__main__":
    t0 = time.time()
    asyncio.run(generate())
    print(f"\nTotal: {time.time() - t0:.1f}s")
