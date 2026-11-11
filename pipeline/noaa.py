"""Normalize NOAA CO-OPS JSON into typed Arrow tables.

Shared by the seed load and the ingest job, so both produce identical rows.
"""

import time
from datetime import datetime, timedelta, timezone

import pyarrow as pa
import requests

OBSERVED_SCHEMA = pa.schema(
    [
        ("station", pa.string()),
        ("t", pa.timestamp("us", tz="UTC")),
        ("water_height", pa.float64()),
        ("sigma", pa.float64()),
        ("flags", pa.string()),
        ("quality", pa.string()),
    ]
)

PREDICTED_SCHEMA = pa.schema(
    [
        ("station", pa.string()),
        ("t", pa.timestamp("us", tz="UTC")),
        ("water_height", pa.float64()),
    ]
)


def _time(s: str) -> datetime:
    # NOAA sends 'YYYY-MM-DD HH:MM' in GMT because we request time_zone=gmt.
    return datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)


def _num(s: str | None) -> float | None:
    # Failed-QC readings arrive as "" -- store NULL, never 0.
    return float(s) if s not in (None, "") else None


def _str(s: str | None) -> str | None:
    return s if s not in (None, "") else None


def observed_rows(payload: dict, station: str) -> list[dict]:
    return [
        {
            "station": station,
            "t": _time(r["t"]),
            "water_height": _num(r.get("v")),
            "sigma": _num(r.get("s")),
            "flags": _str(r.get("f")),
            "quality": _str(r.get("q")),
        }
        for r in payload.get("data", [])
    ]


def predicted_rows(payload: dict, station: str) -> list[dict]:
    # Note the different top-level key: predictions come under "predictions", not "data".
    return [
        {"station": station, "t": _time(r["t"]), "water_height": _num(r["v"])}
        for r in payload.get("predictions", [])
    ]


def to_table(rows: list[dict], schema: pa.Schema) -> pa.Table:
    return pa.Table.from_pylist(rows, schema=schema)


# ---- live fetch (used by the ingest job) ----------------------------------------------


API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
APP = "cs452_tides_pipeline"
HEADERS = {"User-Agent": f"{APP} (BYU CS 452 class project)"}
NO_DATA = "No data was found"
MAX_WINDOW = timedelta(days=31)  # API limit for 6-min data per request


class NoaaError(RuntimeError):
    pass


def fetch(product: str, station: str, datum: str, begin: datetime, end: datetime, tries: int = 3) -> dict:
    """One API call. "No data was found" returns an empty payload (normal: nothing new yet);
    server errors are retried with backoff; anything else raises NoaaError."""
    params = {
        "product": product,
        "station": station,
        "datum": datum,
        "time_zone": "gmt",
        "units": "metric",
        "format": "json",
        "application": APP,
        "begin_date": f"{begin:%Y%m%d %H:%M}",
        "end_date": f"{end:%Y%m%d %H:%M}",
    }
    if product == "predictions":
        params["interval"] = "6"
    reason = ""
    for attempt in range(1, tries + 1):
        try:
            r = requests.get(API, params=params, headers=HEADERS, timeout=30)
            try:
                payload = r.json()
            except ValueError:
                payload = None
            if isinstance(payload, dict) and "error" in payload:
                msg = payload["error"].get("message", "").strip()
                if NO_DATA in msg:
                    return {}
                reason = f"HTTP {r.status_code}: {msg}"
                if 400 <= r.status_code < 500:
                    break  # our request is wrong; retrying won't help
            elif r.status_code == 200 and isinstance(payload, dict):
                return payload
            else:
                reason = f"HTTP {r.status_code}"
        except requests.RequestException as e:
            reason = f"{type(e).__name__}: {e}"
        if attempt < tries:
            time.sleep(2**attempt)
    raise NoaaError(f"{product} {params['begin_date']}..{params['end_date']}: {reason}")


def fetch_range(product: str, station: str, datum: str, begin: datetime, end: datetime) -> list[dict]:
    """Fetch [begin, end] in chunks of at most 31 days; returns normalized rows."""
    rows_fn = observed_rows if product == "water_level" else predicted_rows
    rows, start = [], begin
    while start <= end:
        stop = min(start + MAX_WINDOW - timedelta(minutes=6), end)
        rows += rows_fn(fetch(product, station, datum, start, stop), station)
        start = stop + timedelta(minutes=6)
    return rows
