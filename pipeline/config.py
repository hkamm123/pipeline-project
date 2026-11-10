"""Settings shared by the seed load and the recurring ingest job."""

PROJECT = "cs452-tides-hk"
DATASET = "tides"
STATION = "9455920"  # Anchorage, AK
DATUM = "MSL"


def table(name: str) -> str:
    return f"{PROJECT}.{DATASET}.{name}"
