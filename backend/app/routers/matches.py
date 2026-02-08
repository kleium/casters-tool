"""Playoff match endpoints."""
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
