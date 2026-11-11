"""A lock so only one ingest run writes at a time.

Two MERGEs running at once can both see a row as missing and both insert it (BigQuery
lets insert-only MERGEs run concurrently, and it doesn't enforce keys). This happened when
a scheduled run and a manual run started in the same second.

The lock is an object in Cloud Storage created with if_generation_match=0, meaning "only
if it doesn't exist yet". Cloud Storage checks that atomically, so exactly one run wins,
like Redis SET NX. A lock older than STALE is treated as left behind by a crashed run.
"""

import json
from datetime import datetime, timedelta, timezone

from google.api_core.exceptions import NotFound, PreconditionFailed
from google.cloud import storage

STALE = timedelta(minutes=15)


class Locked(Exception):
    pass


class GcsLock:
    def __init__(self, bucket: str, name: str, owner: str, project: str):
        self.blob = storage.Client(project=project).bucket(bucket).blob(name)
        self.owner = owner
        self.generation = None

    def acquire(self) -> None:
        body = json.dumps({"owner": self.owner, "at": datetime.now(timezone.utc).isoformat()})
        for _ in range(2):
            try:
                self.blob.upload_from_string(body, if_generation_match=0, content_type="application/json")
                self.generation = self.blob.generation
                return
            except PreconditionFailed:
                try:
                    self.blob.reload()
                except NotFound:
                    continue  # released between our attempt and the check: try again
                age = datetime.now(timezone.utc) - self.blob.updated
                if age < STALE:
                    raise Locked(f"held by {self.blob.download_as_text()} ({age.seconds}s old)")
                try:  # stale: delete it, but only if nobody replaced it meanwhile
                    self.blob.delete(if_generation_match=self.blob.generation)
                except (PreconditionFailed, NotFound):
                    pass
        raise Locked("could not acquire lock")

    def release(self) -> None:
        if self.generation is not None:
            try:
                self.blob.delete(if_generation_match=self.generation)  # only our own lock
            except (PreconditionFailed, NotFound):
                pass
