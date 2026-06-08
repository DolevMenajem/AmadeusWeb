from fastapi import APIRouter
from ..lib.db import get_conn

router = APIRouter()


@router.get("/genres")
def list_genres():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT slug, name, description FROM genres ORDER BY name")
            rows = cur.fetchall()
    return [{"id": r["slug"], "name": r["name"], "description": r["description"]} for r in rows]
