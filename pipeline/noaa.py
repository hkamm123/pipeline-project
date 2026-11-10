"""Normalize NOAA CO-OPS JSON into typed Arrow tables.

Shared by the seed load and the ingest job, so both produce identical rows.
"""

from datetime import datetime, timezone

import pyarrow as pa

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
