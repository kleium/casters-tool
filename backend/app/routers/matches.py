"""Match endpoints — playoffs and play-by-play."""
from __future__ import annotations

import asyncio
import re as _re
from fastapi import APIRouter, HTTPException
from ..services.tba_client import get_tba_client
from ..services.frc_client import get_frc_client
from ..services.statbotics_client import get_epa_map, get_match_predictions

router = APIRouter()

# FRC double-elimination bracket structure (8-alliance, 2023+)
# set_number → (round, bracket)
DOUBLE_ELIM_MAP = {
    1: (1, "upper"), 2: (1, "upper"), 3: (1, "upper"), 4: (1, "upper"),
    5: (2, "lower"), 6: (2, "lower"), 7: (2, "upper"), 8: (2, "upper"),
    9: (3, "lower"), 10: (3, "lower"),
    11: (4, "upper"), 12: (4, "lower"),
    13: (5, "lower"),
}

ROUND_LABELS = {1: "Round 1", 2: "Round 2", 3: "Round 3", 4: "Round 4", 5: "Round 5", 0: "Grand Final"}


COMP_LEVEL_ORDER = {"qm": 0, "ef": 1, "qf": 2, "sf": 3, "f": 4}
COMP_LEVEL_LABELS = {"qm": "Qualification", "ef": "Eighths", "qf": "Quarterfinal", "sf": "Semifinal", "f": "Final"}


@router.get("/{event_key}/all")
async def get_all_matches(event_key: str):
    """Return every match at the event with per-team stats for play-by-play."""
    try:
        client = get_tba_client()
        frc = get_frc_client()

        # Extract year and event code from event_key (e.g. "2024ismir" → 2024, "ismir")
        year = int(event_key[:4])
        event_code = event_key[4:]

        matches_raw, rankings, oprs, teams_raw, frc_teams_raw, epa_data, pred_data = await asyncio.gather(
            client.get_event_matches(event_key),
            _safe(client.get_event_rankings(event_key)),
            _safe(client.get_event_oprs(event_key)),
            client.get_event_teams(event_key),
            _safe(frc.get_event_teams(year, event_code)),
            _safe(get_epa_map(event_key)),
            _safe(get_match_predictions(event_key)),
        )
        if epa_data is None:
            epa_data = {}
        if pred_data is None:
            pred_data = {}

        # Build FRC Events org-name lookup (teamNumber → schoolOrg)
        frc_org_map: dict[int, str] = {}
        for ft in (frc_teams_raw or []):
            num = ft.get("teamNumber")
            org = ft.get("schoolName") or ft.get("nameShort") or ""
            if num and org:
                frc_org_map[num] = org

        # ── Build lookups ──
        team_info: dict[str, dict] = {}
        for t in (teams_raw or []):
            tnum = t["team_number"]
            team_info[t["key"]] = {
                "team_number": tnum,
                "nickname": t.get("nickname", ""),
                "city": t.get("city", ""),
                "state_prov": t.get("state_prov", ""),
                "country": t.get("country", ""),
                "school_name": frc_org_map.get(tnum, "") or t.get("school_name", ""),
            }

        rank_map: dict[str, dict] = {}
        if rankings and rankings.get("rankings"):
            for r in rankings["rankings"]:
                rank_map[r["team_key"]] = r

        opr_map: dict[str, float] = {}
        if oprs:
            for tk in oprs.get("oprs", {}):
                opr_map[tk] = round(oprs["oprs"][tk], 2)

        # ── Compute per-team running stats from qual matches ──
        team_matches: dict[str, list[int]] = {}  # team_key -> list of scores in their alliance
        for m in matches_raw:
            if m.get("comp_level") != "qm":
                continue
            for color in ("red", "blue"):
                score = m["alliances"][color].get("score", -1)
                if score < 0:
                    continue
                for tk in m["alliances"][color].get("team_keys", []):
                    team_matches.setdefault(tk, []).append(score)

        # Quals high score
        quals_high = {"score": 0, "match": "", "teams": []}
        for m in matches_raw:
            if m.get("comp_level") != "qm":
                continue
            for color in ("red", "blue"):
                s = m["alliances"][color].get("score", 0)
                if s > quals_high["score"]:
                    quals_high = {
                        "score": s,
                        "match": f"Qualification {m.get('match_number', '?')}",
                        "teams": [int(tk.replace('frc', '')) for tk in m["alliances"][color].get("team_keys", [])],
                    }

        def build_team(tk: str) -> dict:
            info = team_info.get(tk, {})
            rk = rank_map.get(tk, {})
            rec = rk.get("record", {})
            scores = team_matches.get(tk, [])
            rp_list = []
            if rankings and rankings.get("rankings"):
                for r in rankings["rankings"]:
                    if r["team_key"] == tk:
                        sort_orders = r.get("sort_orders", [])
                        if sort_orders:
                            rp_list = [sort_orders[0] if isinstance(sort_orders[0], (int, float)) else sort_orders[0].get("value", 0)]
            return {
                "team_key": tk,
                "team_number": info.get("team_number", int(tk.replace("frc", ""))),
                "nickname": info.get("nickname", ""),
                "school_name": info.get("school_name", ""),
                "city": info.get("city", ""),
                "state_prov": info.get("state_prov", ""),
                "country": info.get("country", ""),
                "rank": rk.get("rank", "-"),
                "wins": rec.get("wins", 0),
                "losses": rec.get("losses", 0),
                "ties": rec.get("ties", 0),
                "qual_average": round(sum(scores) / len(scores), 2) if scores else 0,
                "avg_rp": round(rp_list[0], 2) if rp_list else 0,
                "opr": opr_map.get(tk, 0),
                "epa": (epa_data.get(tk) or {}).get("epa"),
                "high_score": max(scores) if scores else 0,
                "high_score_match": "",
            }

        # Find each team's high score match label
        team_high_match: dict[str, str] = {}
        for m in matches_raw:
            if m.get("comp_level") != "qm":
                continue
            for color in ("red", "blue"):
                s = m["alliances"][color].get("score", 0)
                for tk in m["alliances"][color].get("team_keys", []):
                    if s >= (team_matches.get(tk, [0]) and max(team_matches.get(tk, [0]))):
                        team_high_match[tk] = f"Qualification {m.get('match_number', '?')}"

        # ── Build match list ──
        result = []
        for m in matches_raw:
            cl = m.get("comp_level", "qm")
            mn = m.get("match_number", 0)
            sn = m.get("set_number", 0)

            if cl == "qm":
                label = f"Qualification {mn}"
                sort_key = (0, mn, 0)
            elif cl == "f":
                label = f"Final {mn}"
                sort_key = (COMP_LEVEL_ORDER.get(cl, 9), sn, mn)
            else:
                level_name = COMP_LEVEL_LABELS.get(cl, cl)
                label = f"{level_name} {sn}" + (f" (Match {mn})" if mn > 1 else "")
                sort_key = (COMP_LEVEL_ORDER.get(cl, 9), sn, mn)

            red_keys = m["alliances"]["red"].get("team_keys", [])
            blue_keys = m["alliances"]["blue"].get("team_keys", [])

            red_teams = []
            for tk in red_keys:
                t = build_team(tk)
                t["high_score_match"] = team_high_match.get(tk, "")
                red_teams.append(t)

            blue_teams = []
            for tk in blue_keys:
                t = build_team(tk)
                t["high_score_match"] = team_high_match.get(tk, "")
                blue_teams.append(t)

            result.append({
                "key": m["key"],
                "comp_level": cl,
                "match_number": mn,
                "set_number": sn,
                "label": label,
                "sort_key": sort_key,
                "time": m.get("actual_time") or m.get("predicted_time"),
                "has_breakdown": m.get("score_breakdown") is not None,
                "red": {
                    "teams": red_teams,
                    "score": m["alliances"]["red"].get("score", -1),
                    "total_opr": round(sum(opr_map.get(tk, 0) for tk in red_keys), 2),
                },
                "blue": {
                    "teams": blue_teams,
                    "score": m["alliances"]["blue"].get("score", -1),
                    "total_opr": round(sum(opr_map.get(tk, 0) for tk in blue_keys), 2),
                },
                "winning_alliance": m.get("winning_alliance", ""),
                "pred": pred_data.get(m["key"]),
            })

        result.sort(key=lambda x: x["sort_key"])

        # Remove sort_key from output
        for r in result:
            del r["sort_key"]

        return {
            "event_key": event_key,
            "matches": result,
            "quals_high_score": quals_high,
            "total_matches": len(result),
        }

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/match/{match_key}/breakdown")
async def get_match_breakdown(match_key: str):
    """Return parsed score breakdown for a single match, with per-robot mapping.
    Always bypasses cache to get the latest data from TBA."""
    try:
        client = get_tba_client()
        match = await client.get(f"/match/{match_key}", bypass_cache=True)

        sb = match.get("score_breakdown")
        if not sb:
            return {"match_key": match_key, "available": False}

        red_keys = match["alliances"]["red"].get("team_keys", [])
        blue_keys = match["alliances"]["blue"].get("team_keys", [])

        # Detect game year from match key (e.g. "2026week0_qm12" → 2026)
        import re
        year_match = re.match(r"(\d{4})", match_key)
        game_year = int(year_match.group(1)) if year_match else 2025

        def parse_alliance_2026(data: dict, team_keys: list[str]) -> dict:
            """Parse one alliance's 2026 score_breakdown."""
            robots = []
            for i in range(3):
                tk = team_keys[i] if i < len(team_keys) else None
                robots.append({
                    "team_key": tk,
                    "team_number": int(tk.replace("frc", "")) if tk else None,
                    "autoTower": data.get(f"autoTowerRobot{i+1}", "None"),
                    "endGameTower": data.get(f"endGameTowerRobot{i+1}", "None"),
                })

            hub = data.get("hubScore", {})

            return {
                "robots": robots,
                # Auto
                "totalAutoPoints": data.get("totalAutoPoints", 0),
                "autoTowerPoints": data.get("autoTowerPoints", 0),
                "autoFuelCount": hub.get("autoCount", 0),
                "autoFuelPoints": hub.get("autoPoints", 0),
                # Teleop
                "totalTeleopPoints": data.get("totalTeleopPoints", 0),
                "transitionFuelCount": hub.get("transitionCount", 0),
                "transitionFuelPoints": hub.get("transitionPoints", 0),
                "shift1FuelCount": hub.get("shift1Count", 0),
                "shift1FuelPoints": hub.get("shift1Points", 0),
                "shift2FuelCount": hub.get("shift2Count", 0),
                "shift2FuelPoints": hub.get("shift2Points", 0),
                "shift3FuelCount": hub.get("shift3Count", 0),
                "shift3FuelPoints": hub.get("shift3Points", 0),
                "shift4FuelCount": hub.get("shift4Count", 0),
                "shift4FuelPoints": hub.get("shift4Points", 0),
                "endgameFuelCount": hub.get("endgameCount", 0),
                "endgameFuelPoints": hub.get("endgamePoints", 0),
                "teleopFuelCount": hub.get("teleopCount", 0),
                "teleopFuelPoints": hub.get("teleopPoints", 0),
                "totalFuelCount": hub.get("totalCount", 0),
                "totalFuelPoints": hub.get("totalPoints", 0),
                "uncountedFuel": hub.get("uncounted", 0),
                # Tower
                "totalTowerPoints": data.get("totalTowerPoints", 0),
                "endGameTowerPoints": data.get("endGameTowerPoints", 0),
                # Fouls
                "minorFoulCount": data.get("minorFoulCount", 0),
                "majorFoulCount": data.get("majorFoulCount", 0),
                "foulPoints": data.get("foulPoints", 0),
                "penalties": data.get("penalties", "None"),
                "g206Penalty": data.get("g206Penalty", False),
                # RP
                "energizedAchieved": data.get("energizedAchieved", False),
                "superchargedAchieved": data.get("superchargedAchieved", False),
                "traversalAchieved": data.get("traversalAchieved", False),
                # Totals
                "adjustPoints": data.get("adjustPoints", 0),
                "totalPoints": data.get("totalPoints", 0),
                "rp": data.get("rp", 0),
            }

        def parse_alliance_2025(data: dict, team_keys: list[str]) -> dict:
            """Parse one alliance's 2025 REEFSCAPE score_breakdown."""
            robots = []
            for i in range(3):
                tk = team_keys[i] if i < len(team_keys) else None
                robots.append({
                    "team_key": tk,
                    "team_number": int(tk.replace("frc", "")) if tk else None,
                    "autoLine": data.get(f"autoLineRobot{i+1}", "No"),
                    "endGame": data.get(f"endGameRobot{i+1}", "None"),
                })

            def parse_reef(reef: dict) -> dict:
                rows = {}
                for rname in ("topRow", "midRow", "botRow"):
                    row = reef.get(rname, {})
                    rows[rname] = {k: v for k, v in row.items() if k.startswith("node")}
                return {
                    **rows,
                    "trough": reef.get("trough", 0),
                    "tba_botRowCount": reef.get("tba_botRowCount", 0),
                    "tba_midRowCount": reef.get("tba_midRowCount", 0),
                    "tba_topRowCount": reef.get("tba_topRowCount", 0),
                }

            auto_reef = parse_reef(data.get("autoReef", {}))
            teleop_reef = parse_reef(data.get("teleopReef", {}))

            return {
                "robots": robots,
                "autoPoints": data.get("autoPoints", 0),
                "autoMobilityPoints": data.get("autoMobilityPoints", 0),
                "autoCoralCount": data.get("autoCoralCount", 0),
                "autoCoralPoints": data.get("autoCoralPoints", 0),
                "autoBonusAchieved": data.get("autoBonusAchieved", False),
                "autoReef": auto_reef,
                "teleopPoints": data.get("teleopPoints", 0),
                "teleopCoralCount": data.get("teleopCoralCount", 0),
                "teleopCoralPoints": data.get("teleopCoralPoints", 0),
                "teleopReef": teleop_reef,
                "algaePoints": data.get("algaePoints", 0),
                "netAlgaeCount": data.get("netAlgaeCount", 0),
                "wallAlgaeCount": data.get("wallAlgaeCount", 0),
                "endGameBargePoints": data.get("endGameBargePoints", 0),
                "bargeBonusAchieved": data.get("bargeBonusAchieved", False),
                "coralBonusAchieved": data.get("coralBonusAchieved", False),
                "coopertitionCriteriaMet": data.get("coopertitionCriteriaMet", False),
                "foulCount": data.get("foulCount", 0),
                "techFoulCount": data.get("techFoulCount", 0),
                "foulPoints": data.get("foulPoints", 0),
                "g206Penalty": data.get("g206Penalty", False),
                "g410Penalty": data.get("g410Penalty", False),
                "g418Penalty": data.get("g418Penalty", False),
                "g428Penalty": data.get("g428Penalty", False),
                "adjustPoints": data.get("adjustPoints", 0),
                "totalPoints": data.get("totalPoints", 0),
                "rp": data.get("rp", 0),
            }

        parse_fn = parse_alliance_2026 if game_year >= 2026 else parse_alliance_2025

        return {
            "match_key": match_key,
            "available": True,
            "game_year": game_year,
            "comp_level": match.get("comp_level", ""),
            "match_number": match.get("match_number", 0),
            "set_number": match.get("set_number", 0),
            "red": {
                "score": match["alliances"]["red"].get("score", -1),
                "team_keys": red_keys,
                "breakdown": parse_fn(sb.get("red", {}), red_keys),
            },
            "blue": {
                "score": match["alliances"]["blue"].get("score", -1),
                "team_keys": blue_keys,
                "breakdown": parse_fn(sb.get("blue", {}), blue_keys),
            },
            "winning_alliance": match.get("winning_alliance", ""),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


async def _safe(coro):
    """Await *coro*; return None on any error."""
    try:
        return await coro
    except Exception:
        return None


# ═══════════════════════════════════════════════════════════
#  Individual team performance (FRC Events API)
# ═══════════════════════════════════════════════════════════

def _tba_key_to_frc(event_key: str) -> tuple[int, str]:
    """Convert TBA event key like '2026week0' → (2026, 'WEEK0')."""
    m = _re.match(r"(\d{4})(.*)", event_key)
    if not m:
        raise ValueError(f"Bad event key: {event_key}")
    return int(m.group(1)), m.group(2).upper()


@router.get("/team-perf/{event_key}/{team_number}")
async def get_team_performance(event_key: str, team_number: int):
    """Return per-robot individual performance data for a team at an event.

    Combines FRC Events API score details + match results.
    Returns match-by-match individual data and aggregate stats.
    """
    try:
        season, event_code = _tba_key_to_frc(event_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    frc = get_frc_client()

    try:
        # Fetch qual + playoff scores and match results in parallel
        qual_scores, playoff_scores, qual_matches, playoff_matches = await asyncio.gather(
            _safe(frc.get_scores(season, event_code, "Qualification")),
            _safe(frc.get_scores(season, event_code, "Playoff")),
            _safe(frc.get_matches(season, event_code, level="Qualification", team_number=team_number)),
            _safe(frc.get_matches(season, event_code, level="Playoff", team_number=team_number)),
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"FRC Events API error: {exc}")

    all_scores = (qual_scores or []) + (playoff_scores or [])
    all_matches = (qual_matches or []) + (playoff_matches or [])

    # Build a lookup: (level, matchNumber) → match result (with team stations)
    match_lookup: dict[tuple[str, int], dict] = {}
    for mr in all_matches:
        key = (mr.get("tournamentLevel", ""), mr.get("matchNumber", 0))
        match_lookup[key] = mr

    # Build a lookup: (level, matchNumber) → score detail
    score_lookup: dict[tuple[str, int], dict] = {}
    for ms in all_scores:
        key = (ms.get("matchLevel", ""), ms.get("matchNumber", 0))
        score_lookup[key] = ms

    # For each match the team played, extract individual data
    match_entries = []
    auto_tower_levels = []
    end_tower_levels = []
    wins = 0
    losses = 0
    ties = 0
    total_alliance_pts = []

    tower_level_map = {"None": 0, "Level1": 1, "Level2": 2, "Level3": 3}

    for mr in all_matches:
        level = mr.get("tournamentLevel", "")
        mn = mr.get("matchNumber", 0)
        desc = mr.get("description", f"{level} {mn}")

        # Find which station this team is at
        station = None
        alliance_color = None
        for t in mr.get("teams", []):
            if t.get("teamNumber") == team_number:
                station = t.get("station", "")
                alliance_color = "Red" if station.startswith("Red") else "Blue"
                break
        if not station:
            continue

        # Robot index (1, 2, or 3) from station like "Red2" or "Blue1"
        robot_idx = int(station[-1]) if station and station[-1].isdigit() else 0

        # Find the corresponding score detail
        score_key = (level, mn)
        score = score_lookup.get(score_key)

        auto_tower = "N/A"
        end_tower = "N/A"
        alliance_data = None

        if score:
            for a in score.get("alliances", []):
                if a.get("alliance") == alliance_color:
                    alliance_data = a
                    break
            if alliance_data and robot_idx:
                auto_tower = alliance_data.get(f"autoTowerRobot{robot_idx}", "None")
                end_tower = alliance_data.get(f"endGameTowerRobot{robot_idx}", "None")

        # Determine W/L/T
        red_score = mr.get("scoreRedFinal")
        blue_score = mr.get("scoreBlueFinal")
        if red_score is not None and blue_score is not None:
            my_score = red_score if alliance_color == "Red" else blue_score
            opp_score = blue_score if alliance_color == "Red" else red_score
            if my_score > opp_score:
                result = "W"
                wins += 1
            elif my_score < opp_score:
                result = "L"
                losses += 1
            else:
                result = "T"
                ties += 1
            total_alliance_pts.append(my_score)
        else:
            result = "?"
            my_score = None
            opp_score = None

        auto_tower_levels.append(tower_level_map.get(auto_tower, -1))
        end_tower_levels.append(tower_level_map.get(end_tower, -1))

        # Hub contributions (alliance-level, noted as such)
        hub = {}
        if alliance_data:
            hs = alliance_data.get("hubScore", {})
            hub = {
                "autoFuel": hs.get("autoCount", 0),
                "teleopFuel": hs.get("teleopCount", 0),
                "totalFuel": hs.get("totalCount", 0),
            }

        entry = {
            "description": desc,
            "matchLevel": level,
            "matchNumber": mn,
            "station": station,
            "allianceColor": alliance_color,
            "robotIndex": robot_idx,
            "result": result,
            "allianceScore": my_score,
            "opponentScore": opp_score,
            "autoTower": auto_tower,
            "endGameTower": end_tower,
            "allianceHub": hub,
            "dq": False,
        }

        # Check DQ
        for t in mr.get("teams", []):
            if t.get("teamNumber") == team_number:
                entry["dq"] = t.get("dq", False)

        match_entries.append(entry)

    # Sort by level then match number
    level_order = {"Qualification": 0, "Playoff": 1}
    match_entries.sort(key=lambda e: (level_order.get(e["matchLevel"], 9), e["matchNumber"]))

    # Aggregate stats
    valid_auto = [v for v in auto_tower_levels if v >= 0]
    valid_end = [v for v in end_tower_levels if v >= 0]

    def tower_summary(levels: list[int]) -> dict:
        if not levels:
            return {"total": 0, "active": 0, "activeRate": 0, "avgLevel": 0, "maxLevel": 0}
        active = [l for l in levels if l > 0]
        return {
            "total": len(levels),
            "active": len(active),
            "activeRate": round(len(active) / len(levels) * 100) if levels else 0,
            "avgLevel": round(sum(active) / len(active), 1) if active else 0,
            "maxLevel": max(levels) if levels else 0,
        }

    return {
        "team_number": team_number,
        "event_key": event_key,
        "season": season,
        "matches_played": len(match_entries),
        "record": {"wins": wins, "losses": losses, "ties": ties},
        "avg_alliance_score": round(sum(total_alliance_pts) / len(total_alliance_pts), 1) if total_alliance_pts else 0,
        "autoTower": tower_summary(valid_auto),
        "endGameTower": tower_summary(valid_end),
        "matches": match_entries,
    }


@router.get("/{event_key}/playoffs")
async def get_playoff_matches(event_key: str):
    try:
        client = get_tba_client()
        matches, alliances, oprs, teams = await asyncio.gather(
            client.get_event_matches(event_key),
            client.get_event_alliances(event_key),
            client.get_event_oprs(event_key),
            client.get_event_teams(event_key),
        )

        # Team nickname + country lookup
        name_map: dict[str, str] = {}
        country_map: dict[str, str] = {}
        if teams:
            for t in teams:
                name_map[t["key"]] = t.get("nickname", "")
                country_map[t["key"]] = t.get("country", "")

        # OPR lookup
        opr_map: dict[str, float] = {}
        if oprs:
            for tk in oprs.get("oprs", {}):
                opr_map[tk] = round(oprs["oprs"][tk], 2)

        # Alliance-number lookup (team_key → alliance #)
        alliance_lookup: dict[str, int] = {}
        if alliances:
            for idx, a in enumerate(alliances):
                for tk in a.get("picks", []):
                    alliance_lookup[tk] = idx + 1

        # Filter & sort playoff matches
        playoff = [
            m for m in matches if m.get("comp_level") != "qm"
        ]

        result = []
        for m in playoff:
            sn = m.get("set_number", 0)
            cl = m.get("comp_level", "")

            # Determine round and bracket from set_number
            if cl == "f":
                round_num = 0  # Grand Final
                bracket = "final"
            elif sn in DOUBLE_ELIM_MAP:
                round_num, bracket = DOUBLE_ELIM_MAP[sn]
            else:
                round_num = 99
                bracket = "unknown"

            round_label = ROUND_LABELS.get(round_num, f"Round {round_num}")

            red_keys = m["alliances"]["red"].get("team_keys", [])
            blue_keys = m["alliances"]["blue"].get("team_keys", [])

            red_alliance_num = alliance_lookup.get(red_keys[0]) if red_keys else None
            blue_alliance_num = alliance_lookup.get(blue_keys[0]) if blue_keys else None

            result.append(
                {
                    "key": m["key"],
                    "round": round_num,
                    "round_label": round_label,
                    "bracket": bracket,
                    "set_number": sn,
                    "match_number": m.get("match_number", 0),
                    "red": {
                        "team_keys": red_keys,
                        "team_numbers": [
                            int(tk.replace("frc", "")) for tk in red_keys
                        ],
                        "team_names": [
                            name_map.get(tk, "") for tk in red_keys
                        ],
                        "team_countries": [
                            country_map.get(tk, "") for tk in red_keys
                        ],
                        "score": m["alliances"]["red"].get("score", -1),
                        "alliance_number": red_alliance_num,
                        "total_opr": round(
                            sum(opr_map.get(tk, 0) for tk in red_keys), 2
                        ),
                    },
                    "blue": {
                        "team_keys": blue_keys,
                        "team_numbers": [
                            int(tk.replace("frc", "")) for tk in blue_keys
                        ],
                        "team_names": [
                            name_map.get(tk, "") for tk in blue_keys
                        ],
                        "team_countries": [
                            country_map.get(tk, "") for tk in blue_keys
                        ],
                        "score": m["alliances"]["blue"].get("score", -1),
                        "alliance_number": blue_alliance_num,
                        "total_opr": round(
                            sum(opr_map.get(tk, 0) for tk in blue_keys), 2
                        ),
                    },
                    "winning_alliance": m.get("winning_alliance", ""),
                    "score_breakdown": m.get("score_breakdown"),
                    "time": m.get("actual_time") or m.get("predicted_time"),
                }
            )

        # Sort: rounds 1-5 then grand final (0), by set_number, then match_number
        result.sort(
            key=lambda x: (
                x["round"] if x["round"] > 0 else 99,
                x["set_number"],
                x["match_number"],
            )
        )

        return {"event_key": event_key, "matches": result}

    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
