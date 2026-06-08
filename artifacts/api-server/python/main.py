from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .routers.health import router as health_router
from .routers.upload import router as upload_router
from .routers.genres import router as genres_router
from .routers.jobs import router as jobs_router
from .routers.stats import router as stats_router
from .routers.websocket import router as ws_router

app = FastAPI(title="Amadeus API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

PREFIX = "/api"

app.include_router(health_router, prefix=PREFIX)
app.include_router(upload_router, prefix=PREFIX)
app.include_router(genres_router, prefix=PREFIX)
app.include_router(jobs_router, prefix=PREFIX)
app.include_router(stats_router, prefix=PREFIX)
app.include_router(ws_router)
