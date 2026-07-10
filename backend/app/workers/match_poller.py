"""Hot-path worker: polls FRC Events API every 5 seconds for live match
scores and rankings, then upserts changed rows into Supabase.

Only active events (status = 'ongoing') are polled.  The worker is a
single asyncio task started by the FastAPI lifespan.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from ..services.frc_client import get_frc_client
from ..services.tba_client import get_tba_client
from ..services.supabase_client import get_supabase, upsert_rows, merge_event_teams, delete_orphaned_matches
from ..services.circuit_breaker import CircuitOpenError
from .schemas import FRCMatch, FRCRanking, validate_list

log = logging.getLogger(__name__)

POLL_INTERVAL = 5       # seconds between sweeps
RANKINGS_INTERVAL = 15  # seconds between ranking refreshes
ORPHAN_SWEEP_INTERVAL = 300  # seconds between ghost-match purges (per event)

# TBA event_type for offseason events. These are never reported to the FRC
# Events API (it 404s), so they must be polled via TBA instead. TBA's own
# 120s response cache naturally throttles how often we actually hit the
# network even though the poll loop calls in every 5s.
_OFFSEASON_TYPE = 99


def _strip_nulls(d: dict) -> dict:
    """Remove keys whose value is None so JSONB || won't nuke good data."""
    return {k: v for k, v in d.items() if v is not None}


def _invalidate_snapshot(event_key: str) -> None:
    """Invalidate disk-cached summary caches.

    NOTE: We deliberately do NOT delete the event snapshot here anymore.
    The snapshot TTL (30 min) plus stale-while-revalidate is enough for
    cold-loaders, and Realtime push handles live UI updates without
    needing a snapshot rebuild on every 5-second poll. Deleting it on
    every poll caused a steady rebuild loop that wasted TBA quota and
    CPU during championship weekends.
    """
    try:
        from ..services import payload_cache
        payload_cache.invalidate("summary", event_key)
    except Exception:
        pass

# ── State ───────────────────────────────────────────────────
_active_event_keys: set[str] = set()
_watched_event_keys: dict[str, float] = {}   # user-triggered events → last-access timestamp
_WATCHED_TTL = 7200  # 2 hours — prune events not re-requested
_last_rankings_poll: float = 0
_last_orphan_sweep: dict[str, float] = {}   # event_key → last orphan-purge ts
_event_types: dict[str, int] = {}   # event_key → TBA event_type (source-of-truth for FRC vs TBA polling)

def set_active_events(keys: set[str]) -> None:
    """Called by event_sync when it discovers ongoing events."""
    global _active_event_keys
    _active_event_keys = keys


def set_event_types(mapping: dict[str, int]) -> None:
    """Called by event_sync/ingestion with each event's TBA event_type so
    the poller knows whether it can reach the FRC Events API for it."""
    _event_types.update(mapping)


def add_watched_event(event_key: str) -> None:
    """Register a user-loaded event for ongoing polling."""
    import time as _time
    _watched_event_keys[event_key] = _time.time()


def _is_offseason(event_key: str) -> bool:
    """True if this event's data source is TBA-only (never appears in the
    FRC Events API — e.g. offseason events like XXMEL)."""
    return _event_types.get(event_key) == _OFFSEASON_TYPE


def get_active_events() -> set[str]:
    import time as _time
    now = _time.time()
    expired = [k for k, ts in _watched_event_keys.items() if now - ts > _WATCHED_TTL]
    for k in expired:
        del _watched_event_keys[k]
    return _active_event_keys | set(_watched_event_keys)


async def _poll_matches(event_key: str) -> None:
    """Fetch latest match data and upsert into Supabase."""
    if _is_offseason(event_key):
        await _poll_matches_tba(event_key)
        return

    frc = get_frc_client()
    year = int(event_key[:4])
    event_code = event_key[4:]

    try:
        raw_matches = await frc.get_matches(year, event_code, bypass_cache=True)
    except CircuitOpenError:
        log.debug("Circuit open for FRC API — skipping match poll for %s", event_key)
        return
    except Exception as e:
        log.warning("Match poll failed for %s: %s", event_key, e)
        return

    if not raw_matches:
        return

    valid_matches = validate_list(FRCMatch, raw_matches, f"frc_matches:{event_key}")
    if not valid_matches:
        return

    rows = []
    for m_model in valid_matches:
        m = m_model.model_dump()
        match_num = m.get("matchNumber", 0)
        level = (m.get("tournamentLevel") or "Qualification").lower()

        # Map FRC API tournament levels to TBA comp_level codes
        if "qual" in level:
            comp_level = "qm"
        elif "playoff" in level or "elim" in level:
            comp_level = "sf"
        elif "final" in level:
            comp_level = "f"
        else:
            comp_level = level[:2]

        match_key = f"{event_key}_{comp_level}{match_num}"

        # Determine match status from score presence
        score_red = m.get("scoreRedFinal")
        score_blue = m.get("scoreBlueFinal")
        if score_red is not None and score_red >= 0:
            status = "completed"
        elif m.get("actualStartTime"):
            status = "in_progress"
        else:
            status = "upcoming"

        # Build alliances jsonb with per-alliance team_keys
        frc_teams = m.get("teams", [])
        red_keys = sorted(
            f"frc{t['teamNumber']}" for t in frc_teams
            if "Red" in (t.get("station") or "")
        )
        blue_keys = sorted(
            f"frc{t['teamNumber']}" for t in frc_teams
            if "Blue" in (t.get("station") or "")
        )
        alliances = {
            "red": {
                "score": score_red if score_red is not None else -1,
                "teams": frc_teams,
                "team_keys": red_keys,
            },
            "blue": {
                "score": score_blue if score_blue is not None else -1,
                "teams": frc_teams,
                "team_keys": blue_keys,
            },
        }

        scheduled = m.get("startTime") or m.get("actualStartTime")

        rows.append({
            "match_key": match_key,
            "event_key": event_key,
            "comp_level": comp_level,
            "match_number": match_num,
            "set_number": m.get("playNumber", 1),
            "status": status,
            "alliances": alliances,
            "score_breakdown": m.get("scoreBreakdown") or {},
            "scheduled_time": scheduled,
            "raw_data": m,
        })

    if rows:
        await _upsert_match_rows(event_key, rows)


async def _upsert_match_rows(event_key: str, rows: list[dict]) -> None:
    try:
        await upsert_rows("matches", rows)
        # Purge ghost matches (deleted from live schedule by event operator).
        # Throttled to once per ORPHAN_SWEEP_INTERVAL per event — schedule
        # regeneration happens at most a few times per event per day, so
        # checking every 5 s wasted ~one Supabase query per active event
        # per tick during championship weekends.
        import time as _t
        now = _t.time()
        last = _last_orphan_sweep.get(event_key, 0.0)
        if now - last >= ORPHAN_SWEEP_INTERVAL:
            _last_orphan_sweep[event_key] = now
            valid_keys = {r["match_key"] for r in rows}
            orphan_count = await delete_orphaned_matches(event_key, valid_keys)
            if orphan_count:
                log.info("Purged %d ghost matches from %s", orphan_count, event_key)
        log.debug("Upserted %d matches for %s", len(rows), event_key)
        _invalidate_snapshot(event_key)
    except Exception as e:
        log.warning("Supabase match upsert failed for %s: %s", event_key, e)


async def _poll_matches_tba(event_key: str) -> None:
    """Fetch latest match data from TBA and upsert into Supabase.

    Used for offseason events that never appear in the FRC Events API.
    TBA's client caches responses for 120s, so this naturally polls at a
    much lower effective rate than the 5s FRC hot-path despite being
    called from the same loop.
    """
    tba = get_tba_client()

    try:
        raw_matches = await tba.get_event_matches(event_key)
    except CircuitOpenError:
        log.debug("Circuit open for TBA — skipping match poll for %s", event_key)
        return
    except Exception as e:
        log.warning("TBA match poll failed for %s: %s", event_key, e)
        return

    if not raw_matches:
        return

    rows = []
    for m in raw_matches:
        match_key = m.get("key", "")
        if not match_key:
            continue

        red = m.get("alliances", {}).get("red", {})
        blue = m.get("alliances", {}).get("blue", {})
        rs = red.get("score")
        bs = blue.get("score")

        if rs is not None and rs >= 0 and bs is not None and bs >= 0:
            status = "completed"
        elif m.get("actual_time"):
            status = "in_progress"
        else:
            status = "upcoming"

        raw_time = m.get("time") or m.get("predicted_time")
        scheduled = None
        if raw_time and isinstance(raw_time, (int, float)):
            scheduled = datetime.fromtimestamp(raw_time, tz=timezone.utc).isoformat()

        rows.append({
            "match_key": match_key,
            "event_key": event_key,
            "comp_level": m.get("comp_level", "qm"),
            "match_number": m.get("match_number", 0),
            "set_number": m.get("set_number", 1),
            "status": status,
            "alliances": {
                "red": {
                    "score": rs if rs is not None else -1,
                    "team_keys": red.get("team_keys", []),
                },
                "blue": {
                    "score": bs if bs is not None else -1,
                    "team_keys": blue.get("team_keys", []),
                },
            },
            "score_breakdown": m.get("score_breakdown") or {},
            "scheduled_time": scheduled,
            "raw_data": m,
        })

    if rows:
        await _upsert_match_rows(event_key, rows)


async def _staggered_poll_matches(event_key: str, delay: float) -> None:
    if delay:
        await asyncio.sleep(delay)
    await _poll_matches(event_key)


async def _poll_rankings(event_key: str) -> None:
    """Fetch latest rankings and upsert into event_teams."""
    if _is_offseason(event_key):
        await _poll_rankings_tba(event_key)
        return

    frc = get_frc_client()
    year = int(event_key[:4])
    event_code = event_key[4:]

    try:
        rankings = await frc.get_rankings(year, event_code)
    except CircuitOpenError:
        log.debug("Circuit open for FRC API — skipping ranking poll for %s", event_key)
        return
    except Exception as e:
        log.warning("Rankings poll failed for %s: %s", event_key, e)
        return

    if not rankings:
        return

    valid_rankings = validate_list(FRCRanking, rankings, f"frc_rankings:{event_key}")
    if not valid_rankings:
        return

    rows = []
    for r_model in valid_rankings:
        r = r_model.model_dump()
        team_num = r.get("teamNumber")
        if not team_num:
            continue
        team_key = f"frc{team_num}"

        # FRC Events API returns sortOrder1, sortOrder2, … as individual
        # fields rather than a single sortOrders array.  Build the array
        # from whichever form is present so downstream RP calculation
        # (sort_orders[0] * matches_played) always works.
        sort_orders = r.get("sortOrders")
        if not sort_orders:
            so = []
            for i in range(1, 7):
                v = r.get(f"sortOrder{i}")
                if v is not None:
                    so.append(v)
            sort_orders = so or None

        rows.append({
            "event_key": event_key,
            "team_key": team_key,
            "data": _strip_nulls({
                "rank": r.get("rank"),
                "wins": r.get("wins", 0),
                "losses": r.get("losses", 0),
                "ties": r.get("ties", 0),
                "qual_average": r.get("qualAverage"),
                "sort_orders": sort_orders,
                "matches_played": r.get("matchesPlayed", 0),
                "dq": r.get("dq", 0),
            }),
        })

    if rows:
        await _merge_ranking_rows(event_key, rows)


async def _merge_ranking_rows(event_key: str, rows: list[dict]) -> None:
    try:
        await merge_event_teams(rows)
        log.debug("Merged %d rankings for %s", len(rows), event_key)
        _invalidate_snapshot(event_key)
    except Exception as e:
        log.warning("Supabase rankings upsert failed for %s: %s", event_key, e)


async def _poll_rankings_tba(event_key: str) -> None:
    """Fetch latest rankings from TBA and upsert into event_teams.

    Used for offseason events that never appear in the FRC Events API.
    """
    tba = get_tba_client()

    try:
        raw = await tba.get_event_rankings(event_key)
    except CircuitOpenError:
        log.debug("Circuit open for TBA — skipping ranking poll for %s", event_key)
        return
    except Exception as e:
        log.warning("TBA rankings poll failed for %s: %s", event_key, e)
        return

    rankings = (raw or {}).get("rankings") or []
    if not rankings:
        return

    rows = []
    for r in rankings:
        team_key = r.get("team_key")
        if not team_key:
            continue
        record = r.get("record") or {}
        rows.append({
            "event_key": event_key,
            "team_key": team_key,
            "data": _strip_nulls({
                "rank": r.get("rank"),
                "wins": record.get("wins", 0),
                "losses": record.get("losses", 0),
                "ties": record.get("ties", 0),
                "qual_average": r.get("qual_average"),
                "sort_orders": r.get("sort_orders") or None,
                "matches_played": r.get("matches_played", 0),
                "dq": r.get("dq", 0),
            }),
        })

    if rows:
        await _merge_ranking_rows(event_key, rows)


async def run_match_poller() -> None:
    """Main loop — runs until cancelled."""
    import time

    log.info("Match poller started (interval=%ds, rankings=%ds)", POLL_INTERVAL, RANKINGS_INTERVAL)
    global _last_rankings_poll

    while True:
        try:
            events = list(get_active_events())
            if events:
                # Stagger polls across the interval window to avoid request bursts
                # when many events are active simultaneously (e.g. championship season).
                n = len(events)
                stagger = POLL_INTERVAL / n if n > 1 else 0
                await asyncio.gather(
                    *[_staggered_poll_matches(ek, i * stagger) for i, ek in enumerate(events)],
                    return_exceptions=True,
                )

                # Poll rankings less frequently (serialised to avoid deadlocks)
                now = time.time()
                if now - _last_rankings_poll >= RANKINGS_INTERVAL:
                    _last_rankings_poll = now
                    for ek in events:
                        try:
                            await _poll_rankings(ek)
                        except Exception as e:
                            log.warning("Rankings poll failed for %s: %s", ek, e)
        except Exception as e:
            log.error("Match poller sweep error: %s", e)

        await asyncio.sleep(POLL_INTERVAL)
