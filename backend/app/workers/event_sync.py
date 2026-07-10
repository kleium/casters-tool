"""Warm-path worker: syncs event metadata, team lists, OPRs, and alliance
selections from TBA every 120 seconds, plus EPA from Statbotics.

Also maintains the set of 'active' (ongoing) events that the hot-path
match poller uses.

This worker runs as a single asyncio task started by the FastAPI lifespan.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import date, timedelta

from ..services.tba_client import get_tba_client
from ..services.frc_client import get_frc_client
from ..services.statbotics_client import get_statbotics_client, get_epa_map
from ..services.supabase_client import upsert_rows, merge_event_teams
from ..services.circuit_breaker import CircuitOpenError
from .schemas import TBAEvent, TBATeam, FRCRanking, validate_list
from .match_poller import set_active_events, set_event_types

log = logging.getLogger(__name__)

SYNC_INTERVAL = 120  # seconds between full sweeps
EPA_STAGGER   =   5  # seconds between per-event EPA calls (avoids Statbotics bursts)


def _strip_nulls(d: dict) -> dict:
    """Remove keys whose value is None so JSONB || won't nuke good data."""
    return {k: v for k, v in d.items() if v is not None}


def _invalidate_snapshot(event_key: str) -> None:
    """Invalidate disk-cached summary/awards caches for an event.

    NOTE: We deliberately do NOT delete the event snapshot here anymore.
    The snapshot TTL (30 min) plus stale-while-revalidate is enough for
    cold-loaders, and Realtime push handles live UI updates without
    needing a snapshot rebuild every time event-sync runs (every 120s).
    """
    try:
        from ..services import payload_cache
        payload_cache.invalidate("summary", event_key)
        payload_cache.invalidate("awards", event_key)
    except Exception:
        pass


def _event_status(start_date: str, end_date: str) -> str:
    """Return 'upcoming', 'ongoing', or 'completed'."""
    today = date.today()
    try:
        sd = date.fromisoformat(start_date)
        ed = date.fromisoformat(end_date)
    except (ValueError, TypeError):
        return "unknown"
    if today > ed + timedelta(days=1):
        return "completed"
    if today >= sd:
        return "ongoing"
    return "upcoming"


async def _sync_event_metadata(year: int) -> set[str]:
    """Fetch all events for *year* from TBA, upsert into Supabase,
    and return the set of ongoing event keys."""
    tba = get_tba_client()

    try:
        raw_events = await tba.get_events_by_year(year)
    except CircuitOpenError:
        log.debug("Circuit open for TBA — skipping event metadata sync")
        return set()
    except Exception as e:
        log.warning("Event metadata fetch failed: %s", e)
        return set()

    if not raw_events:
        return set()

    # Validate upstream payload shape before touching Supabase
    valid_events = validate_list(TBAEvent, raw_events, "tba_events")
    if not valid_events:
        log.warning("All TBA events failed validation — skipping")
        return set()

    ongoing: set[str] = set()
    event_types: dict[str, int] = {}
    rows = []
    for ev_model in valid_events:
        ev = ev_model.model_dump()
        etype = ev.get("event_type", -1)
        if etype in {-1, 100}:  # junk types
            continue

        event_types[ev["key"]] = etype

        start = ev.get("start_date", "")
        end = ev.get("end_date", "")
        status = _event_status(start, end)
        if status == "ongoing":
            ongoing.add(ev["key"])

        rows.append({
            "event_key": ev["key"],
            "name": ev.get("name") or "Unknown Event",
            "start_date": start or None,
            "end_date": end or None,
            "competition_type": "frc",
            "raw_data": {
                "city": ev.get("city", ""),
                "state_prov": ev.get("state_prov", ""),
                "country": ev.get("country", ""),
                "event_type": etype,
                "event_type_string": ev.get("event_type_string", ""),
                "district": ev.get("district"),
                "week": ev.get("week"),
                "short_name": ev.get("short_name", ""),
                "status": status,
            },
        })

    if rows:
        try:
            await upsert_rows("events", rows)
            log.debug("Upserted %d events", len(rows))
        except Exception as e:
            log.warning("Supabase events upsert failed: %s", e)

    set_event_types(event_types)
    return ongoing


async def _sync_teams_and_oprs(event_key: str) -> None:
    """Fetch full team list + OPRs from TBA for a single event and upsert."""
    tba = get_tba_client()

    try:
        teams_raw, oprs_raw = await asyncio.gather(
            tba.get_event_teams_full(event_key),
            tba.get_event_oprs(event_key),
            return_exceptions=True,
        )
    except CircuitOpenError:
        log.debug("Circuit open — skipping team/OPR sync for %s", event_key)
        return

    # ── Teams table (now stores school_name / rookie_year) ──
    if isinstance(teams_raw, list) and teams_raw:
        valid_teams = validate_list(TBATeam, teams_raw, f"tba_teams:{event_key}")
        team_rows = []
        for t_model in valid_teams:
            t = t_model.model_dump()
            team_rows.append({
                "team_key": t["key"],
                "team_number": t.get("team_number", 0),
                "nickname": t.get("nickname", ""),
                "competition_type": "frc",
                "raw_tims_data": {
                    "city": t.get("city", ""),
                    "state_prov": t.get("state_prov", ""),
                    "country": t.get("country", ""),
                    "school_name": t.get("school_name", ""),
                    "rookie_year": t.get("rookie_year"),
                },
            })

        try:
            await upsert_rows("teams", team_rows)
        except Exception as e:
            log.warning("Supabase teams upsert failed for %s: %s", event_key, e)

    # ── Event-teams junction (OPRs) ─────────────────────
    opr_lookup: dict = {}
    if isinstance(oprs_raw, dict):
        oprs = oprs_raw.get("oprs", {})
        dprs = oprs_raw.get("dprs", {})
        ccwms = oprs_raw.get("ccwms", {})
        for tkey in oprs:
            opr_lookup[tkey] = {
                "opr": oprs.get(tkey),
                "dpr": dprs.get(tkey),
                "ccwm": ccwms.get(tkey),
            }

    if isinstance(teams_raw, list) and teams_raw and valid_teams:
        # Ensure event_teams rows exist (upsert with empty raw_data for new teams)
        et_seed = [
            {"event_key": event_key, "team_key": t_model.key, "raw_data": {}}
            for t_model in valid_teams
        ]
        try:
            await upsert_rows("event_teams", et_seed)
        except Exception:
            pass

        # Merge OPR data into raw_data (atomic, preserves rankings/EPA)
        merge_rows = [
            {"event_key": event_key, "team_key": t_model.key,
             "data": _strip_nulls(opr_lookup.get(t_model.key, {}))}
            for t_model in valid_teams if opr_lookup.get(t_model.key)
        ]
        if merge_rows:
            try:
                await merge_event_teams(merge_rows)
            except Exception as e:
                log.warning("Supabase event_teams OPR merge failed for %s: %s", event_key, e)

        _invalidate_snapshot(event_key)


async def _sync_alliances(event_key: str) -> None:
    """Fetch playoff alliance selections and store in events.raw_data."""
    tba = get_tba_client()

    try:
        alliances = await tba.get_event_alliances(event_key)
    except CircuitOpenError:
        log.debug("Circuit open — skipping alliance sync for %s", event_key)
        return
    except Exception as e:
        log.warning("Alliance fetch failed for %s: %s", event_key, e)
        return

    if not alliances:
        return

    # Merge into events.raw_data by reading current, updating, writing back.
    try:
        from ..services.supabase_client import get_supabase
        client = await get_supabase()
        resp = await client.table("events").select("raw_data").eq(
            "event_key", event_key
        ).execute()

        # If the event row doesn't exist yet, skip — an upsert with only
        # event_key + raw_data would violate the NOT NULL name column.
        if not resp.data:
            log.debug("Event row missing for %s — skipping alliance store", event_key)
            return

        current_raw = resp.data[0].get("raw_data") or {}
        if isinstance(current_raw, str):
            current_raw = json.loads(current_raw)

        current_raw["alliances"] = alliances
        await client.table("events").update(
            {"raw_data": current_raw}
        ).eq("event_key", event_key).execute()
        log.debug("Stored alliances for %s", event_key)
        _invalidate_snapshot(event_key)
    except Exception as e:
        log.warning("Alliance upsert failed for %s: %s", event_key, e)


async def _sync_epa(event_key: str) -> None:
    """Fetch EPA data from Statbotics and merge into event_teams.raw_data."""
    try:
        epa_map = await get_epa_map(event_key)
    except CircuitOpenError:
        log.debug("Circuit open — skipping EPA sync for %s", event_key)
        return
    except Exception as e:
        log.warning("EPA fetch failed for %s: %s", event_key, e)
        return

    if not epa_map:
        return

    # Merge EPA into raw_data atomically (preserves OPR/rankings)
    # Strip nulls inside each EPA block as well
    merge_rows = [
        {"event_key": event_key, "team_key": tk,
         "data": {"epa": _strip_nulls(epa) if isinstance(epa, dict) else epa}}
        for tk, epa in epa_map.items()
        if epa is not None
    ]
    if merge_rows:
        try:
            await merge_event_teams(merge_rows)
            log.debug("Merged EPA for %d teams at %s", len(merge_rows), event_key)
            _invalidate_snapshot(event_key)
        except Exception as e:
            log.warning("EPA merge failed for %s: %s", event_key, e)


async def _sync_avatars(event_key: str) -> None:
    """Fetch avatars for teams at this event and store in team_avatars table."""
    year = int(event_key[:4]) if event_key[:4].isdigit() else 2026
    try:
        from ..services.avatar_cache import get_avatars
        from ..services.supabase_client import get_supabase

        # Get team keys from Supabase (already ingested by _sync_teams_and_oprs)
        sb = await get_supabase()
        resp = await (
            sb.table("event_teams")
            .select("team_key")
            .eq("event_key", event_key)
            .execute()
        )
        team_keys = [r["team_key"] for r in (resp.data or [])]
        if not team_keys:
            return

        # Check which already have avatars this year
        existing = await (
            sb.table("team_avatars")
            .select("team_key")
            .in_("team_key", team_keys)
            .eq("year", year)
            .execute()
        )
        existing_keys = {r["team_key"] for r in (existing.data or [])}
        missing = [tk for tk in team_keys if tk not in existing_keys]
        if not missing:
            return

        # Fetch from disk cache / TBA and store
        avatar_map = await get_avatars(missing, year)
        if avatar_map:
            rows = [
                {"team_key": tk, "year": year, "avatar_base64": b64}
                for tk, b64 in avatar_map.items()
            ]
            await upsert_rows("team_avatars", rows)
            log.debug("Stored %d avatars for %s", len(rows), event_key)
    except Exception as e:
        log.warning("Avatar sync failed for %s: %s", event_key, e)


async def _sync_frc_team_data(event_key: str) -> None:
    """Fetch team info from FRC Events API and store in teams.frc_data.

    The FRC API provides schoolName / nameShort that are often better quality
    than TBA's school_name.  Stored in a separate JSONB column so TBA data
    (raw_tims_data) is never overwritten.
    """
    frc = get_frc_client()
    year = int(event_key[:4])
    event_code = event_key[4:]

    try:
        frc_teams = await frc.get_event_teams(year, event_code)
    except CircuitOpenError:
        log.debug("Circuit open — skipping FRC team data sync for %s", event_key)
        return
    except Exception as e:
        log.warning("FRC team data fetch failed for %s: %s", event_key, e)
        return

    if not frc_teams:
        return

    rows = []
    for ft in frc_teams:
        num = ft.get("teamNumber")
        if not num:
            continue
        rows.append({
            "team_key": f"frc{num}",
            "team_number": num,
            "nickname": ft.get("nameShort", ""),
            "competition_type": "frc",
            "frc_data": {
                "schoolName": ft.get("schoolName", ""),
                "nameShort": ft.get("nameShort", ""),
                "nameFull": ft.get("nameFull", ""),
                "city": ft.get("city", ""),
                "stateProv": ft.get("stateProv", ""),
                "country": ft.get("country", ""),
                "rookieYear": ft.get("rookieYear"),
                "website": ft.get("website", ""),
            },
        })

    if rows:
        try:
            await upsert_rows("teams", rows)
            log.debug("Stored FRC team data for %d teams at %s", len(rows), event_key)
        except Exception as e:
            log.warning("FRC team data upsert failed for %s: %s", event_key, e)


async def _sync_regional_pool(year: int, ongoing: set[str]) -> None:
    """Sync FRC Events API v3.2 regional advancement data into Supabase.

    Fetches:
     - Per-event advancement detail for each ongoing regional/district event
     - Global qualified-team pool (one row with event_key=NULL)
    """
    frc = get_frc_client()
    from ..services.supabase_client import get_supabase

    # ── Global pool ─────────────────────────────────────────
    try:
        global_teams = await frc.get_regional_pool(year)
        if global_teams:
            sb = await get_supabase()
            await sb.table("regional_pool").upsert({
                "year": year,
                "event_key": None,
                "payload": global_teams,
            }, on_conflict="year,event_key").execute()
            log.debug("Stored global regional pool (%d teams)", len(global_teams))
    except CircuitOpenError:
        log.debug("Circuit open — skipping global regional pool sync")
    except Exception as e:
        log.warning("Global regional pool sync failed: %s", e)

    # ── Per-event detail ────────────────────────────────────
    for ek in ongoing:
        event_code = ek[4:]
        try:
            detail = await frc.get_regional_pool_event(year, event_code)
            if detail:
                sb = await get_supabase()
                await sb.table("regional_pool").upsert({
                    "year": year,
                    "event_key": ek,
                    "payload": detail,
                }, on_conflict="year,event_key").execute()
                log.debug("Stored regional pool detail for %s", ek)
        except CircuitOpenError:
            log.debug("Circuit open — skipping regional pool for %s", ek)
        except Exception as e:
            log.warning("Regional pool sync failed for %s: %s", ek, e)


async def run_event_sync(year: int | None = None) -> None:
    """Main loop — runs until cancelled."""
    if year is None:
        year = date.today().year

    log.info("Event sync started (year=%d, interval=%ds)", year, SYNC_INTERVAL)

    while True:
        try:
            # 1) Sync all event metadata and discover ongoing events
            ongoing = await _sync_event_metadata(year)
            set_active_events(ongoing)

            if ongoing:
                log.info("Active events: %s", ", ".join(sorted(ongoing)))
            else:
                log.debug("No active events found")

            # 2) For ongoing events, sync teams/OPRs, alliances, EPA, FRC data, avatars.
            #    Stagger per-event groups across a 30s window to avoid simultaneous
            #    FRC API bursts when many championship events are active.
            if ongoing:
                event_list = list(ongoing)
                n = len(event_list)
                stagger = 30.0 / n if n > 1 else 0

                async def _sync_event_seed(ek: str, delay: float) -> None:
                    if delay:
                        await asyncio.sleep(delay)
                    await asyncio.gather(
                        _sync_teams_and_oprs(ek),
                        _sync_alliances(ek),
                        _sync_frc_team_data(ek),
                        _sync_avatars(ek),
                        return_exceptions=True,
                    )

                await asyncio.gather(
                    *[_sync_event_seed(ek, i * stagger) for i, ek in enumerate(event_list)],
                    return_exceptions=True,
                )

            # EPA merges into raw_data — run one event at a time with a stagger
            # so that 6 simultaneous events don't burst Statbotics in <3 seconds.
            for i, ek in enumerate(ongoing):
                if i > 0:
                    await asyncio.sleep(EPA_STAGGER)
                try:
                    await _sync_epa(ek)
                except Exception as e:
                    log.warning("EPA sync failed for %s: %s", ek, e)

            # 3) Regional pool (v3.2) — once per sweep, not per event
            await _sync_regional_pool(year, ongoing)

            # 4) Warm connections cache for ongoing events (non-blocking background tasks).
            #    This ensures Supabase has both past-3yr and all-time connections data
            #    before any user requests it via the Play by Play "All Time" toggle.
            for ek in ongoing:
                asyncio.ensure_future(_warm_event_connections(ek))

        except Exception as e:
            log.error("Event sync sweep error: %s", e)

        await asyncio.sleep(SYNC_INTERVAL)


async def _warm_event_connections(event_key: str) -> None:
    """Ensure past-3yr and all-time connections are cached in Supabase.

    Returns immediately if the disk cache is already warm.  The
    get_event_connections call handles Supabase → build-from-scratch
    fallback and automatically kicks off the all-time background warm.
    """
    from ..services.summary_service import get_event_connections
    from ..services import payload_cache

    _CONN_TTL = 3600
    # Fast-path: skip if disk cache is already populated
    if payload_cache.read_payload("connections", event_key, _CONN_TTL):
        return
    try:
        # Building past-3yr also triggers _maybe_warm_alltime_connections
        await get_event_connections(event_key, all_time=False)
        log.debug("Connections cache warmed for %s", event_key)
    except Exception as e:
        log.debug("Connections warm failed for %s: %s", event_key, e)
