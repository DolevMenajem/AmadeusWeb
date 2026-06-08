from fastapi import APIRouter
from ..lib.db import get_conn

router = APIRouter()


@router.get("/stats")
def get_stats():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT type, status FROM jobs")
            rows = cur.fetchall()

    total = len(rows)
    completed = sum(1 for r in rows if r["status"] == "completed")
    failed = sum(1 for r in rows if r["status"] == "failed")
    by_type = {
        "extend": sum(1 for r in rows if r["type"] == "extend"),
        "transform": sum(1 for r in rows if r["type"] == "transform"),
        "evaluate": sum(1 for r in rows if r["type"] == "evaluate"),
        "live_extend": sum(1 for r in rows if r["type"] == "live_extend"),
    }
    return {"totalJobs": total, "completedJobs": completed, "failedJobs": failed, "byType": by_type}
