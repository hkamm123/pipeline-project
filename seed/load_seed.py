"""One-time bulk load of the downloaded seed into BigQuery.

    uv run python -m seed.load_seed

raw JSON (data/raw) -> normalize -> Parquet (data/parquet) -> load job into a staging
table -> MERGE into observed / predicted -> one row in ingest_runs.
Re-running is safe: the MERGE matches on (station, t), so a second run changes nothing.
"""

import gzip
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from pipeline import bq, noaa
from pipeline.config import STATION

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
PARQUET = ROOT / "data" / "parquet"


def build_parquet(product: str, rows_fn, schema: pa.Schema) -> tuple[Path, int]:
    tables = []
    for f in sorted((RAW / product).glob("*.json.gz")):
        payload = json.loads(gzip.decompress(f.read_bytes()))
        tables.append(noaa.to_table(rows_fn(payload, STATION), schema))
    combined = pa.concat_tables(tables)
    PARQUET.mkdir(parents=True, exist_ok=True)
    out = PARQUET / f"{product}.parquet"
    pq.write_table(combined, out, compression="zstd")
    return out, combined.num_rows


def main() -> int:
    started = datetime.now(timezone.utc)
    run_id = f"seed-{started:%Y%m%dT%H%M%SZ}"
    print(f"run {run_id}")
    result = {}
    try:
        for product, target, rows_fn, schema in [
            ("water_level", "observed", noaa.observed_rows, noaa.OBSERVED_SCHEMA),
            ("predictions", "predicted", noaa.predicted_rows, noaa.PREDICTED_SCHEMA),
        ]:
            path, n = build_parquet(product, rows_fn, schema)
            print(f"  {product}: {n:,} rows -> {path.name} ({path.stat().st_size / 1e6:.1f} MB)")
            staged = bq.load_parquet(path, f"_seed_{target}")
            print(f"  loaded {staged:,} rows into staging _seed_{target}")
            stats = bq.merge(target, f"_seed_{target}", run_id)
            print(
                f"  MERGE {target}: {stats['inserted']:,} inserted, {stats['updated']:,} updated, "
                f"{stats['bytes_processed'] / 1e6:.0f} MB processed"
            )
            result[target] = (n, stats)
        status, error = "success", None
    except Exception as e:  # record the failure in the ledger, then re-raise
        status, error = "failed", f"{type(e).__name__}: {e}"
        raise
    finally:
        obs = result.get("observed", (None, {}))
        pred = result.get("predicted", (None, {}))
        bq.record_run(
            {
                "run_id": run_id,
                "run_trigger": "seed",
                "started_at": started,
                "finished_at": datetime.now(timezone.utc),
                "status": status,
                "window_start": None,
                "window_end": None,
                "obs_fetched": obs[0],
                "obs_inserted": obs[1].get("inserted"),
                "obs_updated": obs[1].get("updated"),
                "pred_fetched": pred[0],
                "pred_inserted": pred[1].get("inserted"),
                "pred_updated": pred[1].get("updated"),
                "latest_obs_t": bq.latest_obs_t() if status == "success" else None,
                "error": error,
            }
        )
        print(f"ledger: {status}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
