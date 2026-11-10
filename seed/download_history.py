"""One-time download of the historical seed from NOAA CO-OPS.

Saves the raw API responses, gzipped, under data/raw/ so the bulk load (and every
re-run of it while we iterate) reads from disk instead of NOAA. Run it once:

    uv run python -m seed.download_history

Safe to stop and re-run: windows already on disk are skipped (resume), and each file is
written to a temp name and renamed, so a crash never leaves a half-written file that
resume would mistake for a finished one.

Layout:
    data/raw/meta/                     station details, datums
    data/raw/water_level/YYYY-MM.json.gz    observed, 6-min, one file per month (31-day API limit)
    data/raw/predictions/YYYY.json.gz       predicted, 6-min, one file per year (1-year limit)
    data/raw/<product>/<window>.empty.json  NOAA answered "No data was found" for that window
    data/raw/coverage.json             summary: which windows had data, were empty, or failed
"""

import calendar
import gzip
import json
import os
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

import requests

STATION = "9455920"  # Anchorage, AK
DATUM = "MSL"  # heights relative to mean sea level, so the tide swings around 0
FIRST_YEAR = 1964  # station established 1964-04-24; earlier windows would all be empty

API = "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter"
MDAPI = f"https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/{STATION}"
APP = "cs452_tides_pipeline"  # NOAA asks clients to identify themselves
HEADERS = {"User-Agent": f"{APP} (BYU CS 452 class project)"}

PAUSE_S = 1.0  # politeness: at most ~1 request per second
MAX_TRIES = 5
NO_DATA = "No data was found"

RAW = Path(__file__).resolve().parent.parent / "data" / "raw"


def write_atomic(path: Path, data: bytes) -> None:
    """Write to a temp file, then rename: the file either exists complete or not at all."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


def fetch(params: dict) -> tuple[str, bytes | str]:
    """Call the Data API. Returns ("ok", body), ("empty", message) or ("failed", reason)."""
    params = {
        "station": STATION,
        "datum": DATUM,
        "time_zone": "gmt",  # never local time: DST would repeat an hour every November
        "units": "metric",
        "format": "json",
        "application": APP,
        **params,
    }
    reason = ""
    for attempt in range(1, MAX_TRIES + 1):
        try:
            r = requests.get(API, params=params, headers=HEADERS, timeout=60)
            body = r.content
            try:
                payload = json.loads(body)
            except ValueError:
                payload = None
            if isinstance(payload, dict) and "error" in payload:
                msg = payload["error"].get("message", "").strip()
                if NO_DATA in msg:
                    return "empty", msg  # a real answer, not a failure: don't retry
                reason = f"HTTP {r.status_code}: {msg}"
                if 400 <= r.status_code < 500:
                    return "failed", reason  # our request is wrong; retrying won't help
            elif r.status_code == 200 and isinstance(payload, dict):
                return "ok", body
            else:
                reason = f"HTTP {r.status_code}, unexpected body: {body[:120]!r}"
        except requests.RequestException as e:
            reason = f"{type(e).__name__}: {e}"
        wait = 2**attempt  # exponential backoff: 2, 4, 8, 16 s
        print(f"    attempt {attempt} failed ({reason}); retrying in {wait}s", flush=True)
        time.sleep(wait)
    return "failed", reason


def download_window(product: str, label: str, params: dict, coverage: dict) -> None:
    done = RAW / product / f"{label}.json.gz"
    empty = RAW / product / f"{label}.empty.json"
    if done.exists():
        coverage[product]["ok"].append(label)
        return
    if empty.exists():
        coverage[product]["empty"].append(label)
        return

    status, result = fetch({"product": product, **params})
    if status == "ok":
        write_atomic(done, gzip.compress(result))
        key = "data" if product != "predictions" else "predictions"
        rows = len(json.loads(result).get(key, []))
        print(f"  {product} {label}: {rows} rows", flush=True)
        coverage[product]["ok"].append(label)
    elif status == "empty":
        write_atomic(empty, json.dumps({"message": result}).encode())
        print(f"  {product} {label}: no data", flush=True)
        coverage[product]["empty"].append(label)
    else:
        # Not written to disk, so the next run tries this window again.
        print(f"  {product} {label}: FAILED ({result})", flush=True)
        coverage[product]["failed"].append({"window": label, "reason": result})
    time.sleep(PAUSE_S)


def main() -> int:
    # The seed ends at the start of today (UTC). The recurring ingest job takes it from
    # there, and its overlapping window makes the seam between the two harmless.
    today = datetime.now(timezone.utc).date()
    coverage = {
        "station": STATION,
        "datum": DATUM,
        "seed_end_exclusive": f"{today} 00:00 UTC",
        "water_level": {"ok": [], "empty": [], "failed": []},
        "predictions": {"ok": [], "empty": [], "failed": []},
    }

    print("station metadata")
    for name, url in [
        ("details", f"{MDAPI}/details.json"),
        ("datums", f"{MDAPI}/datums.json?units=metric"),
    ]:
        r = requests.get(url, headers=HEADERS, timeout=60)
        r.raise_for_status()
        write_atomic(RAW / "meta" / f"{name}.json", r.content)

    print("observed water level, 6-min, month by month")
    for year in range(FIRST_YEAR, today.year + 1):
        for month in range(1, 13):
            first = date(year, month, 1)
            if first >= today:
                break
            last_day = calendar.monthrange(year, month)[1]
            last = min(date(year, month, last_day), date.fromordinal(today.toordinal() - 1))
            download_window(
                "water_level",
                f"{year}-{month:02d}",
                {"begin_date": f"{first:%Y%m%d} 00:00", "end_date": f"{last:%Y%m%d} 23:59"},
                coverage,
            )

    print("predicted water level, 6-min, year by year")
    for year in range(FIRST_YEAR, today.year + 1):
        last = date(year, 12, 31) if year < today.year else date.fromordinal(today.toordinal() - 1)
        download_window(
            "predictions",
            f"{year}",
            {
                "interval": "6",
                "begin_date": f"{year}0101 00:00",
                "end_date": f"{last:%Y%m%d} 23:59",
            },
            coverage,
        )

    write_atomic(RAW / "coverage.json", json.dumps(coverage, indent=2).encode())
    for product in ("water_level", "predictions"):
        c = coverage[product]
        print(f"{product}: {len(c['ok'])} with data, {len(c['empty'])} empty, {len(c['failed'])} failed")
    failed = coverage["water_level"]["failed"] + coverage["predictions"]["failed"]
    if failed:
        print("Some windows failed. Re-run the script to retry just those.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
