-- Schema for the Anchorage tides pipeline (BigQuery, dataset cs452-tides-hk.tides).
-- Safe to re-run: tables use IF NOT EXISTS, the view uses CREATE OR REPLACE.
--   bq query --nouse_legacy_sql < sql/schema.sql

-- Observed water level, one row per station per 6-minute reading (NOAA product water_level).
-- Partitioned by month: ~30 years of data is ~380 monthly partitions, where daily would be
-- ~11,000 (over BigQuery's 4,000-per-query and 10,000-per-table limits).
CREATE TABLE IF NOT EXISTS `cs452-tides-hk.tides.observed` (
  station      STRING(7) NOT NULL,  -- NOAA station id, e.g. '9455920' (a label, not a number)
  t            TIMESTAMP NOT NULL,  -- t (GMT)
  water_height FLOAT64,             -- v, meters above MSL; NULL when the reading failed QC
  sigma        FLOAT64,             -- s
  flags        STRING(7),           -- f, 'O,F,R,L' (first is I = inferred in verified data)
  quality      STRING(1),           -- q, 'p' preliminary / 'v' verified
  -- bookkeeping: when and by which run each row arrived or last changed
  first_ingested_at TIMESTAMP NOT NULL,
  updated_at        TIMESTAMP NOT NULL,
  run_id            STRING NOT NULL,   -- ingest_runs.run_id of the last run that changed it ('seed-<UTC time>' for the bulk load)
  PRIMARY KEY (station, t) NOT ENFORCED
)
PARTITION BY TIMESTAMP_TRUNC(t, MONTH)
CLUSTER BY station
OPTIONS (description = 'NOAA CO-OPS observed water level, 6-min, datum MSL, metric');

-- Predicted (astronomical) tide at the same 6-minute timestamps (NOAA product predictions).
-- Also holds future rows: the ingest job fetches about two days ahead for the chart.
CREATE TABLE IF NOT EXISTS `cs452-tides-hk.tides.predicted` (
  station      STRING(7) NOT NULL,  -- must match observed.station's type for the join
  t            TIMESTAMP NOT NULL,  -- t (GMT)
  water_height FLOAT64 NOT NULL,    -- v, meters above MSL; predictions are computed, never blank
  first_ingested_at TIMESTAMP NOT NULL,
  updated_at        TIMESTAMP NOT NULL,
  run_id            STRING NOT NULL,
  PRIMARY KEY (station, t) NOT ENFORCED
)
PARTITION BY TIMESTAMP_TRUNC(t, MONTH)
CLUSTER BY station
OPTIONS (description = 'NOAA CO-OPS predicted tide, 6-min, datum MSL, metric');

-- One row per pipeline run: the evidence for "did every scheduled run happen, what did it
-- do, and when did it die?" Small (~100 rows/day), so no partitioning.
CREATE TABLE IF NOT EXISTS `cs452-tides-hk.tides.ingest_runs` (
  run_id        STRING NOT NULL,     -- unique per run (Cloud Run execution id, or 'seed-<UTC time>')
  run_trigger   STRING NOT NULL,     -- 'scheduler', 'manual', 'seed', 'backfill'
  started_at    TIMESTAMP NOT NULL,
  finished_at   TIMESTAMP,           -- NULL if the run crashed before finishing
  status        STRING NOT NULL,     -- 'success', 'no_new_data', 'skipped' (another run held the lock), 'failed'
  window_start  TIMESTAMP,           -- the time window requested from NOAA
  window_end    TIMESTAMP,
  obs_fetched   INT64,
  obs_inserted  INT64,
  obs_updated   INT64,               -- e.g. preliminary values replaced by verified ones
  pred_fetched  INT64,
  pred_inserted INT64,
  pred_updated  INT64,
  latest_obs_t  TIMESTAMP,           -- newest observation in the table after this run (freshness)
  error         STRING,              -- error message when status = 'failed'
  PRIMARY KEY (run_id) NOT ENFORCED
)
OPTIONS (description = 'Ledger of every ingest run, for liveness and continuity checks');

-- Observed and predicted side by side. FULL JOIN keeps times that have only a prediction
-- (the future, or gaps like March 2011) and any observation without a prediction. USING
-- merges station and t into single columns, so no COALESCE is needed.
CREATE OR REPLACE VIEW `cs452-tides-hk.tides.readings` AS
SELECT
  station,
  t,
  o.water_height                  AS observed,
  p.water_height                  AS predicted,
  o.water_height - p.water_height AS residual,   -- + means the sea is higher than the tide tables say
  o.sigma,
  o.flags,
  o.quality,
  CASE
    WHEN o.run_id IS NULL       THEN 'predicted_only'  -- no observation row (future or a gap)
    WHEN o.water_height IS NULL THEN 'failed_qc'       -- observation row exists, value blank
    ELSE 'observed'
  END                             AS reading_status
FROM `cs452-tides-hk.tides.observed` AS o
FULL JOIN `cs452-tides-hk.tides.predicted` AS p
  USING (station, t);

-- Same as `readings`, but for a time window, with the filter applied to each table BEFORE
-- the join. Filtering the view's `t` doesn't prune partitions: after FULL JOIN ... USING,
-- t is COALESCE(o.t, p.t), which hides the partition column (measured: 298 MB per call
-- through the view vs. ~10 MB through this function).
CREATE OR REPLACE TABLE FUNCTION `cs452-tides-hk.tides.readings_between`(lo TIMESTAMP, hi TIMESTAMP) AS
SELECT
  station,
  t,
  o.water_height                  AS observed,
  p.water_height                  AS predicted,
  o.water_height - p.water_height AS residual,
  o.sigma,
  o.flags,
  o.quality,
  CASE
    WHEN o.run_id IS NULL       THEN 'predicted_only'
    WHEN o.water_height IS NULL THEN 'failed_qc'
    ELSE 'observed'
  END                             AS reading_status
FROM (SELECT * FROM `cs452-tides-hk.tides.observed`  WHERE t BETWEEN lo AND hi) AS o
FULL JOIN (SELECT * FROM `cs452-tides-hk.tides.predicted` WHERE t BETWEEN lo AND hi) AS p
  USING (station, t);
