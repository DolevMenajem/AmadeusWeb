import os
import json
import random
import asyncio
from pathlib import Path
from datetime import datetime, timezone
from typing import Any, List
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
import traceback

from ..lib.db import get_conn
from ..lib.midi_gen import generate_output_midi, extract_midi_features, UPLOADS_DIR
from ..lib.gemini import generate_lecturer_feedback

# --- NEW: DUAL AI BRAIN IMPORT ---
from ..models.composer_engine import AmadeusComposerREMI, AmadeusComposerOctuple

CURRENT_DIR = Path(__file__).resolve().parent
MODELS_DIR = CURRENT_DIR.parent / "models"

print("Loading Amadeus Dual Brains into RAM...")
tokenizer_file = "Compose10k.json"

# Brain A: Standard (Single-Track)
composer_remi = AmadeusComposerREMI(
    checkpoint_path=str(MODELS_DIR / "checkpoint_best.pt"), 
    tokenizer_path=str(MODELS_DIR / tokenizer_file)
)

# Brain B: Multi-Track (Full Band)
composer_octuple = AmadeusComposerOctuple(
    checkpoint_path=str(MODELS_DIR / "checkpoint_best_octuple.pt"), 
    tokenizer_path=str(MODELS_DIR / tokenizer_file)
)
print("Dual Brains Ready.")
# ---------------------------------

router = APIRouter()

GENRE_LABELS = {
    "jazz": "Jazz", "classical": "Classical", "blues": "Blues",
    "electronic": "Electronic", "bossa-nova": "Bossa Nova", "rock": "Rock",
    "ambient": "Ambient", "latin": "Latin", "funk": "Funk", "folk": "Folk",
}


def serialize_job(row: dict) -> dict:
    # Helper to safely format dates whether they are strings (SQLite) or datetime objects (Postgres)
    def safe_iso(date_val):
        if not date_val:
            return None
        if isinstance(date_val, str):
            return date_val
        return date_val.isoformat()

    return {
        "id": row["id"],
        "type": row["type"],
        "status": row["status"],
        "inputFilename": row["input_filename"],
        "outputFilename": row["output_filename"],
        "targetGenre": row["target_genre"],
        "barsToExtend": row["bars_to_extend"],
        "evaluationResult": json.loads(row["evaluation_result"]) if row.get("evaluation_result") else None,
        "errorMessage": row["error_message"],
        "createdAt": safe_iso(row.get("created_at")),
        "completedAt": safe_iso(row.get("completed_at")),
    }


def _set_status(job_id: int, status: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("UPDATE jobs SET status = %s WHERE id = %s", (status, job_id))


def _complete_job(job_id: int, update: dict):
    sets = ", ".join(f"{k} = %s" for k in update)
    vals = list(update.values()) + [job_id]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE jobs SET {sets} WHERE id = %s", vals)


def _fail_job(job_id: int, message: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE jobs SET status = %s, error_message = %s, completed_at = %s WHERE id = %s",
                ("failed", message, datetime.now(timezone.utc), job_id),
            )


# Added model_type to the processing arguments
async def simulate_processing(job_id: int, job_type: str, target_genre: str | None = None, bars: int | None = None,
                             input_filename: str | None = None, temperature: float = 0.8, top_k: int = 0, top_p: float = 1.0,
                             model_type: str = "remi"):
    await asyncio.sleep(0.5)
    
    try:
        _set_status(job_id, "processing")

        if job_type == "evaluate":
            features: dict[str, Any] = {}
            if input_filename:
                filepath = os.path.join(UPLOADS_DIR, input_filename)
                features = extract_midi_features(filepath)

            try:
                gemini_str = await generate_lecturer_feedback(target_genre, features)
                clean_json = gemini_str.replace("```json", "").replace("```", "").strip()
                ai_data = json.loads(clean_json)
                
                eval_result = {
                    "overallScore": ai_data.get("overallScore", 75),
                    "rhythmScore": ai_data.get("rhythmScore", 75),
                    "harmonyScore": ai_data.get("harmonyScore", 75),
                    "melodyScore": ai_data.get("melodyScore", 75),
                    "complexityScore": ai_data.get("complexityScore", 75),
                    "predictedGenre": target_genre,
                    "genreConfidence": 1.0,
                    "midiFeatures": features,
                    "lecturerFeedback": ai_data.get("lecturerFeedback", "Excellent piece."),
                    "summary": ai_data.get("summary", "A solid composition."),
                    "suggestions": ai_data.get("suggestions", []),
                }
            except Exception as e:
                print(f"JSON Parse Error: {e}")
                eval_result = {"errorMessage": "Failed to parse AI evaluation data."}

            _complete_job(job_id, {
                "status": "completed",
                "completed_at": datetime.now(timezone.utc),
                "evaluation_result": json.dumps(eval_result),
            })
            
        else:
            if job_type in ["extend", "live_extend"] and input_filename:
                real_uploads_dir = Path(__file__).resolve().parent.parent.parent / "uploads"
                input_path = str(real_uploads_dir / input_filename)
                output_filename = f"amadeus_creation_{job_id}.mid"
                output_path = str(real_uploads_dir / output_filename)
                
                tokens_to_generate = (bars or 4) * 32
                
                # --- DYNAMIC ROUTING ---
                active_composer = composer_octuple if model_type == "octuple" else composer_remi
                
                loop = asyncio.get_running_loop()
                await loop.run_in_executor(
                    None,
                    lambda: active_composer.extend_midi(
                        input_midi_path=input_path,
                        output_midi_path=output_path,
                        num_generate=tokens_to_generate,
                        temperature=temperature,
                        top_k=top_k,
                        top_p=top_p
                    )
                )
            else:
                output_filename = generate_output_midi(job_id, job_type, target_genre, bars)

            _complete_job(job_id, {
                "status": "completed",
                "completed_at": datetime.now(timezone.utc),
                "output_filename": output_filename,
            })

    except Exception as e:
        traceback.print_exc()
        _fail_job(job_id, f"Internal error: {str(e)}")


# ── GET /jobs ────────────────────────────────────────────────────────────────

@router.get("/jobs")
def list_jobs():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM jobs ORDER BY created_at DESC")
            rows = cur.fetchall()
    return [serialize_job(r) for r in rows]


# ── GET /jobs/:id ─────────────────────────────────────────────────────────────

@router.get("/jobs/{job_id}")
def get_job(job_id: int):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM jobs WHERE id = %s", (job_id,))
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Job not found")
    return serialize_job(row)


# ── POST /jobs/extend ─────────────────────────────────────────────────────────

class ExtendInput(BaseModel):
    inputFilename: str
    barsToExtend: int = Field(ge=1, le=64)
    temperature: float = Field(default=0.8)
    topK: int = Field(default=0)
    topP: float = Field(default=1.0)
    modelType: str = Field(default="remi") # NEW: Tracks the selected model

@router.post("/jobs/extend", status_code=201)
async def extend_midi(body: ExtendInput):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO jobs (type, status, input_filename, bars_to_extend) VALUES (%s, %s, %s, %s) RETURNING *",
                ("extend", "pending", body.inputFilename, body.barsToExtend),
            )
            row = cur.fetchone()
    asyncio.create_task(simulate_processing(
        row["id"], "extend", bars=body.barsToExtend, input_filename=body.inputFilename, 
        temperature=body.temperature, top_k=body.topK, top_p=body.topP, model_type=body.modelType
    ))
    return serialize_job(row)


# ── POST /jobs/transform ──────────────────────────────────────────────────────

class TransformInput(BaseModel):
    inputFilename: str
    targetGenre: str

@router.post("/jobs/transform", status_code=201)
async def transform_midi(body: TransformInput):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO jobs (type, status, input_filename, target_genre) VALUES (%s, %s, %s, %s) RETURNING *",
                ("transform", "pending", body.inputFilename, body.targetGenre),
            )
            row = cur.fetchone()
    asyncio.create_task(simulate_processing(row["id"], "transform", target_genre=body.targetGenre, input_filename=body.inputFilename))
    return serialize_job(row)


# ── POST /jobs/evaluate ───────────────────────────────────────────────────────

class EvaluateInput(BaseModel):
    inputFilename: str
    targetGenre: str

@router.post("/jobs/evaluate", status_code=201)
async def evaluate_midi(body: EvaluateInput):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO jobs (type, status, input_filename, target_genre) VALUES (%s, %s, %s, %s) RETURNING *",
                ("evaluate", "pending", body.inputFilename, body.targetGenre),
            )
            row = cur.fetchone()
    asyncio.create_task(simulate_processing(row["id"], "evaluate", target_genre=body.targetGenre, input_filename=body.inputFilename))
    return serialize_job(row)


# ── POST /api/jam (LIVE JAMMING FAST-TRACK) ───────────────────────────────────

class JamNote(BaseModel):
    pitch: int
    time: int
    duration: int
    velocity: int

class JamRequest(BaseModel):
    notes: List[JamNote]
    num_generate: int = 64  # Keep it short for fast response (1-2 bars)
    temperature: float = 0.8

@router.post("/jam", status_code=200)
async def live_jam_endpoint(body: JamRequest):
    """Bypasses SQLite and Disk completely. In-memory RAM to RAM processing."""
    if not body.notes:
        raise HTTPException(status_code=400, detail="No notes provided")
        
    notes_data = [n.model_dump() for n in body.notes]
    
    # Run in an executor thread so we don't freeze the FastAPI web server
    loop = asyncio.get_running_loop()
    try:
        result_notes = await loop.run_in_executor(
            None,
            lambda: composer_octuple.live_extend(notes_data, body.num_generate, body.temperature)
        )
        return {"notes": result_notes}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


# ── GET /jobs/:id/download ────────────────────────────────────────────────────

from fastapi.responses import FileResponse

@router.get("/jobs/{job_id}/download")
def download_job_result(job_id: int, type: str = "full"):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM jobs WHERE id = %s", (job_id,))
            row = cur.fetchone()
            
    if not row or row["status"] != "completed" or not row["output_filename"]:
        raise HTTPException(status_code=404, detail="Job result not found")

    base_name = row["output_filename"].replace(".mid", "")
    
    # Route the request to the correct generated file
    if type == "extension":
        file_name = f"{base_name}_extension.mid"
        media_type = "audio/midi"
        download_name = f"extension_{row['output_filename']}"
    elif type == "audio":
        file_name = f"{base_name}.wav"
        media_type = "audio/wav"
        download_name = row["output_filename"].replace(".mid", ".wav")
    else: # full
        file_name = f"{base_name}_full.mid"
        media_type = "audio/midi"
        download_name = f"full_{row['output_filename']}"

    file_path = Path(UPLOADS_DIR) / file_name
    
    # Fallback just in case an older job only has the base .mid file
    if not file_path.exists():
        file_path = Path(UPLOADS_DIR) / row["output_filename"]
        download_name = row["output_filename"]
        media_type = "audio/midi"
        
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")
        
    return FileResponse(path=file_path, filename=download_name, media_type=media_type)