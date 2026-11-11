"""BigQuery helpers: staging loads (free load jobs), the idempotent MERGE, the run ledger."""

from datetime import datetime, timedelta, timezone
from pathlib import Path

from google.cloud import bigquery

from pipeline.config import PROJECT, table

_client: bigquery.Client | None = None


def client() -> bigquery.Client:
    global _client
    if _client is None:
        _client = bigquery.Client(project=PROJECT)  # credentials: ADC locally, service account in Cloud Run
    return _client


def load_parquet(path: Path, staging: str, expire_hours: int = 24) -> int:
    """Load a Parquet file into a staging table with a load job (free, unlike streaming inserts).
    The staging table is replaced each time and expires on its own."""
    job = client().load_table_from_file(
        path.open("rb"),
        table(staging),
        job_config=bigquery.LoadJobConfig(
            source_format=bigquery.SourceFormat.PARQUET,
            write_disposition=bigquery.WriteDisposition.WRITE_TRUNCATE,
        ),
    )
    job.result()
    t = client().get_table(table(staging))
    t.expires = datetime.now(timezone.utc) + timedelta(hours=expire_hours)
    client().update_table(t, ["expires"])
    return t.num_rows


# One MERGE per target table. Matching on the logical key (station, t) is what makes the
# pipeline idempotent: re-running with the same data inserts nothing and updates nothing.
# Rows are updated only when a value actually changed (e.g. preliminary -> verified), so
# updated_at / run_id mean "last real change", not "last time we saw it".
# The QUALIFY dedups the source: MERGE fails if two source rows match one target row.
# window_filter (optional) limits the target scan to the fetched time window so BigQuery
# prunes partitions. Only safe when every source row lies inside that window.
_MERGE = {
    "observed": """
MERGE `{target}` T
USING (
  SELECT * FROM `{staging}`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY station, t ORDER BY quality DESC) = 1  -- prefer 'v' over 'p'
) S
ON T.station = S.station AND T.t = S.t {window_filter}
WHEN MATCHED AND (
     T.water_height IS DISTINCT FROM S.water_height
  OR T.sigma        IS DISTINCT FROM S.sigma
  OR T.flags        IS DISTINCT FROM S.flags
  OR T.quality      IS DISTINCT FROM S.quality
) THEN UPDATE SET
  water_height = S.water_height, sigma = S.sigma, flags = S.flags, quality = S.quality,
  updated_at = CURRENT_TIMESTAMP(), run_id = @run_id
WHEN NOT MATCHED THEN INSERT
  (station, t, water_height, sigma, flags, quality, first_ingested_at, updated_at, run_id)
  VALUES (S.station, S.t, S.water_height, S.sigma, S.flags, S.quality,
          CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), @run_id)
""",
    "predicted": """
MERGE `{target}` T
USING (
  SELECT * FROM `{staging}`
  QUALIFY ROW_NUMBER() OVER (PARTITION BY station, t) = 1
) S
ON T.station = S.station AND T.t = S.t {window_filter}
WHEN MATCHED AND T.water_height IS DISTINCT FROM S.water_height THEN UPDATE SET
  water_height = S.water_height, updated_at = CURRENT_TIMESTAMP(), run_id = @run_id
WHEN NOT MATCHED THEN INSERT
  (station, t, water_height, first_ingested_at, updated_at, run_id)
  VALUES (S.station, S.t, S.water_height, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), @run_id)
""",
}


def merge(target: str, staging: str, run_id: str, window: tuple[datetime, datetime] | None = None) -> dict:
    params = [bigquery.ScalarQueryParameter("run_id", "STRING", run_id)]
    window_filter = ""
    if window:
        # Filter on the partition column directly (not DATE(T.t)) so pruning works.
        window_filter = "AND T.t BETWEEN @w_start AND @w_end"
        params += [
            bigquery.ScalarQueryParameter("w_start", "TIMESTAMP", window[0]),
            bigquery.ScalarQueryParameter("w_end", "TIMESTAMP", window[1]),
        ]
    sql = _MERGE[target].format(target=table(target), staging=table(staging), window_filter=window_filter)
    job = client().query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params))
    job.result()
    stats = job.dml_stats
    return {
        "inserted": stats.inserted_row_count if stats else 0,
        "updated": stats.updated_row_count if stats else 0,
        "bytes_processed": job.total_bytes_processed,
    }


def record_run(row: dict) -> None:
    """Append one row to ingest_runs with a load job (free; streaming inserts are billed)."""
    row = {k: (v.isoformat() if isinstance(v, datetime) else v) for k, v in row.items()}
    target = client().get_table(table("ingest_runs"))
    client().load_table_from_json(
        [row],
        target,
        job_config=bigquery.LoadJobConfig(
            schema=target.schema,
            write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
        ),
    ).result()


def latest_obs_t():
    rows = list(client().query(f"SELECT MAX(t) AS m FROM `{table('observed')}`").result())
    return rows[0].m


def query(sql: str, params: list | None = None) -> list:
    job = client().query(sql, job_config=bigquery.QueryJobConfig(query_parameters=params or []))
    return list(job.result())
