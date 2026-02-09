"""Match endpoints — playoffs and play-by-play."""
from __future__ import annotations

import asyncio
from fastapi import APIRouter, HTTPException
from ..services.tba_client import get_tba_client

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
        matches_raw, rankings, oprs, teams_raw = await asyncio.gather(
            client.get_event_matches(event_key),
            _safe(client.get_event_rankings(event_key)),
            _safe(client.get_event_oprs(event_key)),
            client.get_event_teams(event_key),
        )

        # ── Build lookups ──
        team_info: dict[str, dict] = {}
        for t in (teams_raw or []):
            team_info[t["key"]] = {
                "team_number": t["team_number"],
                "nickname": t.get("nickname", ""),
                "city": t.get("city", ""),
                "state_prov": t.get("state_prov", ""),
                "country": t.get("country", ""),
                "school_name": t.get("school_name") or t.get("name", ""),
            }

        rank_map: dict[str, dict] = {}
        if rankings and rankings.get("rankings"):
            for r in rankings["rankings"]:
                rank_map[r["team_key"]] = r

        opr_map: dict[str, float] = {}
        dpr_map: dict[str, float] = {}
        if oprs:
            for tk in oprs.get("oprs", {}):
                opr_map[tk] = round(oprs["oprs"][tk], 2)
            for tk in oprs.get("dprs", {}):
                dpr_map[tk] = round(oprs["dprs"][tk], 2)

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
                "dpr": dpr_map.get(tk, 0),
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
    """Return parsed score breakdown for a single match, with per-robot mapping."""
    try:
        client = get_tba_client()
        match = await client.get_match(match_key)

        sb = match.get("score_breakdown")
        if not sb:
            return {"match_key": match_key, "available": False}

        red_keys = match["alliances"]["red"].get("team_keys", [])
        blue_keys = match["alliances"]["blue"].get("team_keys", [])

        def parse_alliance(data: dict, team_keys: list[str]) -> dict:
            """Parse one alliance's score_breakdown into a structured dict."""
            # Per-robot fields (Robot 1/2/3 → team_keys[0/1/2])
            robots = []
            for i in range(3):
                tk = team_keys[i] if i < len(team_keys) else None
                robots.append({
                    "team_key": tk,
                    "team_number": int(tk.replace("frc", "")) if tk else None,
                    "autoLine": data.get(f"autoLineRobot{i+1}", "No"),
                    "endGame": data.get(f"endGameRobot{i+1}", "None"),
                })

            # Reef grid helper
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
                # Auto
                "autoPoints": data.get("autoPoints", 0),
                "autoMobilityPoints": data.get("autoMobilityPoints", 0),
                "autoCoralCount": data.get("autoCoralCount", 0),
                "autoCoralPoints": data.get("autoCoralPoints", 0),
                "autoBonusAchieved": data.get("autoBonusAchieved", False),
                "autoReef": auto_reef,
                # Teleop
                "teleopPoints": data.get("teleopPoints", 0),
                "teleopCoralCount": data.get("teleopCoralCount", 0),
                "teleopCoralPoints": data.get("teleopCoralPoints", 0),
                "teleopReef": teleop_reef,
                # Algae
                "algaePoints": data.get("algaePoints", 0),
                "netAlgaeCount": data.get("netAlgaeCount", 0),
                "wallAlgaeCount": data.get("wallAlgaeCount", 0),
                # Barge
                "endGameBargePoints": data.get("endGameBargePoints", 0),
                "bargeBonusAchieved": data.get("bargeBonusAchieved", False),
                # Bonuses
                "coralBonusAchieved": data.get("coralBonusAchieved", False),
                "coopertitionCriteriaMet": data.get("coopertitionCriteriaMet", False),
                # Fouls
                "foulCount": data.get("foulCount", 0),
                "techFoulCount": data.get("techFoulCount", 0),
                "foulPoints": data.get("foulPoints", 0),
                # Penalties
                "g206Penalty": data.get("g206Penalty", False),
                "g410Penalty": data.get("g410Penalty", False),
                "g418Penalty": data.get("g418Penalty", False),
                "g428Penalty": data.get("g428Penalty", False),
                # Totals
                "adjustPoints": data.get("adjustPoints", 0),
                "totalPoints": data.get("totalPoints", 0),
                "rp": data.get("rp", 0),
            }

        return {
            "match_key": match_key,
            "available": True,
            "comp_level": match.get("comp_level", ""),
            "match_number": match.get("match_number", 0),
            "set_number": match.get("set_number", 0),
            "red": {
                "score": match["alliances"]["red"].get("score", -1),
                "team_keys": red_keys,
                "breakdown": parse_alliance(sb.get("red", {}), red_keys),
            },
            "blue": {
                "score": match["alliances"]["blue"].get("score", -1),
                "team_keys": blue_keys,
                "breakdown": parse_alliance(sb.get("blue", {}), blue_keys),
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
