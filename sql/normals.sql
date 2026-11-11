-- Historical "normals" per station and calendar month, precomputed from the seed so the
-- ingest job and the music page never scan 30 years of data on every run.
-- residual_q / level_q are 101 values: index k is the k-th percentile (0 = min, 100 = max).
--   bq query --nouse_legacy_sql < sql/normals.sql
CREATE OR REPLACE TABLE `cs452-tides-hk.tides.normals`
OPTIONS (description = 'Percentiles of residual and water level by station and month, from history') AS
SELECT
  station,
  EXTRACT(MONTH FROM t)          AS month,
  APPROX_QUANTILES(residual, 100) AS residual_q,
  APPROX_QUANTILES(observed, 100) AS level_q,
  COUNT(*)                        AS n
FROM `cs452-tides-hk.tides.readings`
WHERE reading_status = 'observed'
GROUP BY station, month;
