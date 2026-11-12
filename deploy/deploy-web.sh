#!/usr/bin/env bash
# Publish the music page to the same public bucket that holds latest.json.
#   bash deploy/deploy-web.sh
# Page: https://storage.googleapis.com/cs452-tides-hk-public/index.html
set -euo pipefail
BUCKET=gs://cs452-tides-hk-public
cd "$(dirname "$0")/.."
# Short cache so a redeploy shows up within a minute (latest.json itself is no-cache).
gcloud storage cp --recursive --cache-control="public, max-age=60" web/index.html web/style.css web/js "$BUCKET/"
echo "https://storage.googleapis.com/${BUCKET#gs://}/index.html"
