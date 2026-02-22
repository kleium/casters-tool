"""Server-side event cache — save/load full event snapshots to disk."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Optional

CACHE_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data" / "saved_events"


def _ensure_dir() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def save_event(event_key: str, data: dict[str, Any]) -> dict:
    """Persist a full event snapshot to disk."""
    _ensure_dir()
    payload = {
        "event_key": event_key,
        "saved_at": time.time(),
        "saved_iso": time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime()),
        "data": data,
    }
    path = CACHE_DIR / f"{event_key}.json"
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    return {"event_key": event_key, "saved_at": payload["saved_at"], "saved_iso": payload["saved_iso"]}


def load_event(event_key: str) -> Optional[dict]:
    """Load a saved event snapshot from disk.  Returns None if not found."""
    path = CACHE_DIR / f"{event_key}.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def delete_event(event_key: str) -> bool:
    """Delete a saved event snapshot.  Returns True if it existed."""
    path = CACHE_DIR / f"{event_key}.json"
    if path.exists():
        path.unlink()
        return True
    return False


def list_saved_events() -> list[dict]:
    """Return metadata for all saved events (no heavy data)."""
    _ensure_dir()
    result = []
    for p in sorted(CACHE_DIR.glob("*.json")):
        try:
            raw = json.loads(p.read_text(encoding="utf-8"))
            entry = {
                "event_key": raw.get("event_key", p.stem),
                "saved_at": raw.get("saved_at"),
                "saved_iso": raw.get("saved_iso"),
            }
            # Include event name/status if stored
            d = raw.get("data", {})
            if "info" in d:
                entry["name"] = d["info"].get("name", "")
                entry["status"] = d["info"].get("status", "")
                entry["year"] = d["info"].get("year", "")
            result.append(entry)
        except Exception:
            continue
    return result
