#!/usr/bin/env bash
# Email alert when the pipeline breaks. Safe to re-run (finds and updates what exists).
#   bash deploy/alerts.sh
#
# One policy, two conditions (Cloud Monitoring bills $0.10 per condition per month):
#   1. An execution of tides-ingest or tides-reverify FAILED (non-zero exit after its retry).
#   2. NO tides-ingest execution finished for an hour (Scheduler stopped, job can't start,
#      quota, deleted image...). This one can't come from the job itself: a job that
#      doesn't run can't report that it didn't run, so we alert on the absence of a metric.
#
# The email address is the gcloud account you're logged in as (not stored in the repo).
set -euo pipefail
PROJECT=cs452-tides-hk
EMAIL=${ALERT_EMAIL:-$(gcloud config get account 2>/dev/null)}
API=https://monitoring.googleapis.com/v3/projects/$PROJECT
AUTH=(-H "Authorization: Bearer $(gcloud auth print-access-token)" -H "Content-Type: application/json")
POLICY_NAME="Tides pipeline: ingest failed or stopped running"

# --- notification channel (email)
CHANNEL=$(curl -s --fail-with-body "${AUTH[@]}" -G "$API/notificationChannels" \
  --data-urlencode "filter=type=\"email\" AND labels.email_address=\"$EMAIL\"" |
  python3 -c "import json,sys; c=json.load(sys.stdin).get('notificationChannels',[]); print(c[0]['name'] if c else '')")
if [[ -z "$CHANNEL" ]]; then
  CHANNEL=$(curl -s --fail-with-body "${AUTH[@]}" -X POST "$API/notificationChannels" -d @- <<EOF | python3 -c "import json,sys; print(json.load(sys.stdin)['name'])"
{"type": "email", "displayName": "Pipeline owner", "labels": {"email_address": "$EMAIL"}}
EOF
)
fi
echo "channel: $CHANNEL"

# --- the policy
JOB_METRIC='resource.type = "cloud_run_job" AND metric.type = "run.googleapis.com/job/completed_execution_count"'
POLICY=$(python3 - "$CHANNEL" "$POLICY_NAME" "$JOB_METRIC" <<'EOF'
import json, sys
channel, name, metric = sys.argv[1:]
sum15 = [{"alignmentPeriod": "900s", "perSeriesAligner": "ALIGN_SUM", "crossSeriesReducer": "REDUCE_SUM"}]
print(json.dumps({
  "displayName": name,
  "combiner": "OR",
  "conditions": [
    {"displayName": "An ingest or reverify execution failed",
     "conditionThreshold": {
       "filter": f'{metric} AND resource.labels.job_name = starts_with("tides-") AND metric.labels.result = "failed"',
       "aggregations": sum15, "comparison": "COMPARISON_GT", "thresholdValue": 0,
       "duration": "0s", "trigger": {"count": 1}}},
    {"displayName": "No tides-ingest execution finished in the last hour",
     "conditionAbsent": {
       "filter": f'{metric} AND resource.labels.job_name = "tides-ingest"',
       "aggregations": sum15, "duration": "3600s", "trigger": {"count": 1}}},
  ],
  "alertStrategy": {"autoClose": "86400s"},
  "documentation": {"mimeType": "text/markdown", "content":
    "The tides pipeline (Cloud Scheduler -> Cloud Run job tides-ingest, every 15 min) failed or stopped.\n\n"
    "- Runs and errors: `SELECT * FROM tides.ingest_runs ORDER BY started_at DESC LIMIT 20`\n"
    "- Logs: Cloud Run -> Jobs -> tides-ingest -> Executions\n"
    "- Gaps fill themselves: the next good run backfills from the newest stored reading (up to 365 days)."},
  "notificationChannels": [channel],
}))
EOF
)
EXISTING=$(curl -s --fail-with-body "${AUTH[@]}" -G "$API/alertPolicies" --data-urlencode "filter=display_name=\"$POLICY_NAME\"" |
  python3 -c "import json,sys; p=json.load(sys.stdin).get('alertPolicies',[]); print(p[0]['name'] if p else '')")
if [[ -n "$EXISTING" ]]; then
  curl -s --fail-with-body "${AUTH[@]}" -X PATCH "https://monitoring.googleapis.com/v3/$EXISTING" -d "$POLICY" >/dev/null
  echo "updated: $EXISTING"
else
  curl -s --fail-with-body "${AUTH[@]}" -X POST "$API/alertPolicies" -d "$POLICY" | python3 -c "import json,sys; print('created:', json.load(sys.stdin)['name'])"
fi
