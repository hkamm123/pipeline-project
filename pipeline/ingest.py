"""The recurring ingest job (Cloud Run job, triggered by Cloud Scheduler every 15 min).

    uv run python -m pipeline.ingest                 # normal run: last 24 h + 48 h of predictions ahead
    LOOKBACK_HOURS=1000 uv run python -m pipeline.ingest   # wider re-pull (catches preliminary -> verified)

Each run:
  1. Picks a window: the last LOOKBACK_HOURS (default 24), or from the newest stored
     observation if the table is further behind than that (automatic gap backfill).
  2. Fetches observed + predicted for the window (predictions also 48 h into the future).
  3. Loads each into a per-run staging table and MERGEs it, scanning only the window's
     partitions. Overlap with earlier runs is harmless: unchanged rows are left alone.
  4. Records the run in ingest_runs (success / no_new_data / failed).
  5. Exports latest.json for the music page.
"""

import json
import os
import sys
import tempfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pyarrow.parquet as pq
from google.cloud import bigquery, storage

from pipeline import bq, noaa
from pipeline.config import DATUM, PROJECT, STATION, table

BUCKET = f"{PROJECT}-public"
LOOKBACK = timedelta(hours=int(os.environ.get("LOOKBACK_HOURS", "24")))
PREDICT_AHEAD = timedelta(hours=48)
MAX_BACKFILL = timedelta(days=365)  # beyond this, a human should look (or re-run the seed)


def floor6(dt: datetime) -> datetime:
    return dt.replace(minute=dt.minute - dt.minute % 6, second=0, microsecond=0)


def run_identity() -> tuple[str, str]:
    # Cloud Run sets CLOUD_RUN_EXECUTION for jobs; locally we make one up.
    execution = os.environ.get("CLOUD_RUN_EXECUTION")
    trigger = os.environ.get("RUN_TRIGGER") or ("scheduler" if execution else "manual")
    run_id = execution or f"manual-{datetime.now(timezone.utc):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:6]}"
    return run_id, trigger


def merge_rows(rows: list[dict], schema, target: str, run_id: str, tmp: Path) -> dict:
    if not rows:
        return {"fetched": 0, "inserted": 0, "updated": 0}
    path = tmp / f"{target}.parquet"
    pq.write_table(noaa.to_table(rows, schema), path)
    staging = f"_stage_{target}_{run_id.replace('-', '_')}"  # per run: concurrent runs can't collide
    bq.load_parquet(path, staging, expire_hours=1)
    # The window comes from the rows themselves, so every source row is inside it
    # (otherwise an out-of-window row could never match and would be inserted twice).
    window = (min(r["t"] for r in rows), max(r["t"] for r in rows))
    stats = bq.merge(target, staging, run_id, window=window)
    bq.client().delete_table(table(staging), not_found_ok=True)
    return {"fetched": len(rows), **stats}


def export_latest(now: datetime) -> None:
    """Write latest.json: everything the music page needs, nothing it has to query."""
    p = [
        bigquery.ScalarQueryParameter("lo", "TIMESTAMP", now - timedelta(hours=48)),
        bigquery.ScalarQueryParameter("hi", "TIMESTAMP", now + PREDICT_AHEAD),
        bigquery.ScalarQueryParameter("station", "STRING", STATION),
        bigquery.ScalarQueryParameter("month", "INT64", now.month),
    ]
    series = bq.query(
        f"""SELECT t, observed, predicted, residual, sigma, quality, reading_status
            FROM `{table('readings')}`
            WHERE station = @station AND t BETWEEN @lo AND @hi ORDER BY t""",
        p,
    )
    normals = bq.query(
        f"SELECT residual_q, level_q, n FROM `{table('normals')}` WHERE station = @station AND month = @month",
        p,
    )
    runs = bq.query(
        f"""SELECT run_id, run_trigger, started_at, finished_at, status, obs_inserted, obs_updated,
                   pred_inserted, latest_obs_t, error
            FROM `{table('ingest_runs')}` ORDER BY started_at DESC LIMIT 200"""
    )

    def iso(v):
        return v.isoformat() if isinstance(v, datetime) else v

    doc = {
        "generated_at": iso(now),
        "station": {"id": STATION, "name": "Anchorage, AK", "datum": DATUM, "units": "meters"},
        "series": [
            {
                "t": iso(r.t),
                "obs": r.observed,
                "pred": r.predicted,
                "resid": r.residual,
                "sigma": r.sigma,
                "q": r.quality,
                "status": r.reading_status,
            }
            for r in series
        ],
        "normals": (
            {"month": now.month, "residual_q": list(normals[0].residual_q), "level_q": list(normals[0].level_q), "n": normals[0].n}
            if normals
            else None
        ),
        "pipeline": {"runs": [{k: iso(v) for k, v in r.items()} for r in runs]},
    }
    blob = storage.Client(project=PROJECT).bucket(BUCKET).blob("latest.json")
    blob.cache_control = "no-cache, max-age=0"
    blob.upload_from_string(json.dumps(doc, separators=(",", ":")), content_type="application/json")


def main() -> int:
    started = datetime.now(timezone.utc)
    run_id, trigger = run_identity()
    now6 = floor6(started)
    run = {"run_id": run_id, "run_trigger": trigger, "started_at": started, "error": None}
    print(f"run {run_id} ({trigger})")
    try:
        latest = bq.latest_obs_t()
        begin = now6 - LOOKBACK
        if latest and latest < begin:
            begin = max(latest, now6 - MAX_BACKFILL)  # we're behind: backfill the gap
            print(f"  behind: newest observation {latest}, backfilling from {begin}")
        run.update(window_start=begin, window_end=now6)

        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            obs = noaa.fetch_range("water_level", STATION, DATUM, begin, now6)
            o = merge_rows(obs, noaa.OBSERVED_SCHEMA, "observed", run_id, tmp)
            pred = noaa.fetch_range("predictions", STATION, DATUM, begin, now6 + PREDICT_AHEAD)
            p = merge_rows(pred, noaa.PREDICTED_SCHEMA, "predicted", run_id, tmp)

        print(f"  observed:  {o['fetched']} fetched, {o['inserted']} inserted, {o['updated']} updated")
        print(f"  predicted: {p['fetched']} fetched, {p['inserted']} inserted, {p['updated']} updated")
        run.update(
            status="success" if (o["inserted"] or o["updated"]) else "no_new_data",
            obs_fetched=o["fetched"], obs_inserted=o["inserted"], obs_updated=o["updated"],
            pred_fetched=p["fetched"], pred_inserted=p["inserted"], pred_updated=p["updated"],
        )
        code = 0
    except Exception as e:
        run.update(status="failed", error=f"{type(e).__name__}: {e}"[:2000])
        print(f"  FAILED: {run['error']}", file=sys.stderr)
        code = 1  # non-zero exit: Cloud Run marks the execution failed (alerts watch this)

    run["finished_at"] = datetime.now(timezone.utc)
    try:
        run["latest_obs_t"] = bq.latest_obs_t()
        bq.record_run(run)
        export_latest(started)  # even after a failed fetch, so the page shows the failure
        print(f"  {run['status']}; latest observation {run['latest_obs_t']}; latest.json written")
    except Exception as e:
        print(f"  could not record run / export: {type(e).__name__}: {e}", file=sys.stderr)
        code = 1
    return code


if __name__ == "__main__":
    sys.exit(main())
