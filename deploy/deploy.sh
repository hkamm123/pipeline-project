#!/usr/bin/env bash
# Deploy the ingest job to Cloud Run and schedule it. Safe to re-run.
set -euo pipefail
PROJECT=cs452-tides-hk
REGION=us-central1
BUCKET=gs://${PROJECT}-public
INGEST_SA=tides-ingest@${PROJECT}.iam.gserviceaccount.com      # what the job runs as
SCHED_SA=tides-scheduler@${PROJECT}.iam.gserviceaccount.com     # what starts the job
gcloud config set project $PROJECT >/dev/null
export CLOUDSDK_CORE_DISABLE_PROMPTS=1  # never wait on a yes/no prompt (auto-accept defaults)

# 1. Service accounts (identities for programs), with only the permissions each needs.
for sa in tides-ingest tides-scheduler; do
  gcloud iam service-accounts describe $sa@$PROJECT.iam.gserviceaccount.com >/dev/null 2>&1 ||
    gcloud iam service-accounts create $sa --display-name="$sa"
done
# ingest: run BigQuery jobs (project), edit tables in dataset `tides` only, write objects in our bucket only
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$INGEST_SA \
  --role=roles/bigquery.jobUser --condition=None >/dev/null
bq query --nouse_legacy_sql \
  "GRANT \`roles/bigquery.dataEditor\` ON SCHEMA \`$PROJECT.tides\` TO 'serviceAccount:$INGEST_SA'" >/dev/null
gcloud storage buckets add-iam-policy-binding $BUCKET --member=serviceAccount:$INGEST_SA \
  --role=roles/storage.objectUser >/dev/null

# 2. Build the container (Cloud Build) and deploy two jobs from the same image:
#    tides-ingest   every 15 min, 24 h window
#    tides-reverify daily, ~42-day window, picks up preliminary -> verified revisions
gcloud run jobs deploy tides-ingest --source . --region $REGION \
  --service-account $INGEST_SA --set-env-vars RUN_TRIGGER=scheduler \
  --memory 512Mi --cpu 1 --task-timeout 10m --max-retries 1
IMAGE=$(gcloud run jobs describe tides-ingest --region $REGION --format='value(spec.template.spec.template.spec.containers[0].image)')
gcloud run jobs deploy tides-reverify --image "$IMAGE" --region $REGION \
  --service-account $INGEST_SA --set-env-vars RUN_TRIGGER=reverify,LOOKBACK_HOURS=1000 \
  --memory 512Mi --cpu 1 --task-timeout 15m --max-retries 1

# 3. The scheduler's identity may start these two jobs and nothing else.
for job in tides-ingest tides-reverify; do
  gcloud run jobs add-iam-policy-binding $job --region $REGION \
    --member=serviceAccount:$SCHED_SA --role=roles/run.invoker >/dev/null
done

# 4. Cloud Scheduler: call the Cloud Run Admin API's jobs.run, authenticated as SCHED_SA.
#    Minute 4/19/34/49: NOAA publishes each 6-min reading a few minutes late.
schedule() {  # name cron job
  local uri="https://run.googleapis.com/v2/projects/$PROJECT/locations/$REGION/jobs/$3:run"
  if gcloud scheduler jobs describe "$1" --location $REGION >/dev/null 2>&1; then verb=update; else verb=create; fi
  gcloud scheduler jobs $verb http "$1" --location $REGION --schedule "$2" --time-zone Etc/UTC \
    --uri "$uri" --http-method POST --oauth-service-account-email $SCHED_SA \
    --attempt-deadline 3m
}
schedule tides-ingest-15min "4-59/15 * * * *" tides-ingest
schedule tides-reverify-daily "30 6 * * *" tides-reverify
echo "deployed"
