# Anchorage Tides → Ambient Music Pipeline (CS 452)

A data pipeline that bulk-loads decades of NOAA tide data for Anchorage, AK, keeps itself
current every 15 minutes with nobody pushing the button, and drives a generative ambient
music page in the browser.

**Stack:** NOAA CO-OPS API → Cloud Scheduler → Cloud Run job → BigQuery → `latest.json` in
Cloud Storage → Tone.js page (+ Looker Studio for liveness)

- Sound design and control panel: [docs/sound-design.md](docs/sound-design.md)
- Seed download: `uv run python -m seed.download_history`

_Work in progress._
