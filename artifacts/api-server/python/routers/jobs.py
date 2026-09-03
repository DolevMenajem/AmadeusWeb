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
import tempfile
from fastapi.responses import FileResponse

from ..lib.db import get_conn
from ..lib.midi_gen import generate_output_midi, extract_midi_features, UPLOADS_DIR
from ..lib.gemini import generate_lecturer_feedback



# --- TRI BRAIN IMPORT ---
from ..models.composer_engine import AmadeusComposerREMI, AmadeusComposerOctuple, AmadeusComposerTSD

CURRENT_DIR = Path(__file__).resolve().parent
MODELS_DIR = CURRENT_DIR.parent / "models"

print("Loading Amadeus Tri-Brains into RAM...")

# Brain A: REMI
composer_remi = AmadeusComposerREMI(
    checkpoint_path=str(MODELS_DIR / "BIG_REMI.pt"), 
    tokenizer_path=str(MODELS_DIR / "Compose_REMI.json")
)

# Brain B: Octuple
composer_octuple = AmadeusComposerOctuple(
    checkpoint_path=str(MODELS_DIR / "checkpoint_best_octuple.pt"), 
    tokenizer_path=str(MODELS_DIR / "Compose_Octuple.json")
)

# Brain C: The New TSD GPT
composer_tsd = AmadeusComposerTSD(
    checkpoint_path=str(MODELS_DIR / "checkpoint_best_tsd.pt"), # Ensure your friend's .pt file is named this
    tokenizer_path=str(MODELS_DIR / "Compose_TSD.json")
)
print("Tri-Brains Ready.")
# ---------------------------------

router = APIRouter()
RUNNING_TASKS: dict[int, asyncio.Task] = {}
GENRE_LABELS = {
    "jazz": "Jazz", "classical": "Classical", "blues": "Blues",
    "electronic": "Electronic", "bossa-nova": "Bossa Nova", "rock": "Rock",
    "ambient": "Ambient", "latin": "Latin", "funk": "Funk", "folk": "Folk",
}


def serialize_job(row: dict) -> dict:
    def safe_iso(date_val):
        if not date_val:
            return None
        if isinstance(date_val, str):
            return date_val
        return date_val.isoformat()

    # Parse output_filename whether it's a JSON array or a plain string
    output_raw = row.get("output_filename")
    variations = []
    primary_output = output_raw

    if output_raw and output_raw.startswith("["):
        try:
            variations = json.loads(output_raw)
            primary_output = variations[0] if variations else output_raw
        except Exception:
            variations = []

    return {
        "id": row["id"],
        "type": row["type"],
        "status": row["status"],
        "inputFilename": row["input_filename"],
        "outputFilename": primary_output,
        "variations": variations, # List of filenames if multi-choice
        "numVariations": len(variations) if variations else 1,
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
                             model_type: str = "remi", num_variations=1):
    await asyncio.sleep(0.5)
    
    try:
        _set_status(job_id, "processing")

        if job_type == "evaluate":
            features: dict[str, Any] = {}
            if input_filename:
                filepath = os.path.join(UPLOADS_DIR, input_filename)
                features = extract_midi_features(filepath)

            try:
                # NEW: Fire 3 Gemini requests concurrently!
                task_theory = generate_lecturer_feedback(target_genre, features, persona="theory")
                task_rhythm = generate_lecturer_feedback(target_genre, features, persona="rhythm")
                task_genre = generate_lecturer_feedback(target_genre, features, persona="genre")
                
                # Wait for all 3 to finish simultaneously
                raw_theory, raw_rhythm, raw_genre = await asyncio.gather(task_theory, task_rhythm, task_genre)
                
                # Parse all 3 JSON responses
                data_theory = json.loads(raw_theory.replace("```json", "").replace("```", "").strip())
                data_rhythm = json.loads(raw_rhythm.replace("```json", "").replace("```", "").strip())
                data_genre = json.loads(raw_genre.replace("```json", "").replace("```", "").strip())
                
                theory_score = data_theory.get("score", 75)
                rhythm_score = data_rhythm.get("score", 75)
                genre_score = data_genre.get("score", 75)
                overall = round((data_theory.get("score", 75) + data_rhythm.get("score", 75) + data_genre.get("score", 75)) / 3)
                
                eval_result = {
                    "overallScore": overall,
                    "theoryScore": theory_score,
                    "rhythmScore": rhythm_score,
                    "genreScore": genre_score,
                    "predictedGenre": target_genre,
                    "genreConfidence": 1.0,
                    "midiFeatures": features,
                    # Combine the feedback into a structured dictionary
                    "lecturerFeedback": {
                        "Theory & Harmony": data_theory.get("feedback", ""),
                        "Rhythm & Groove": data_rhythm.get("feedback", ""),
                        "Genre Accuracy": data_genre.get("feedback", "")
                    },
                    # Combine all suggestions into one master list
                    "suggestions": data_theory.get("suggestions", []) + data_rhythm.get("suggestions", []) + data_genre.get("suggestions", [])
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
                
                if model_type == "octuple":
                    active_composer = composer_octuple
                elif model_type == "tsd":
                    active_composer = composer_tsd
                else:
                    active_composer = composer_remi
                
                loop = asyncio.get_running_loop()
                # Run engine with num_variations
                generated_paths = await loop.run_in_executor(
                    None,
                    lambda: active_composer.extend_midi(
                        input_midi_path=input_path,
                        output_midi_path=output_path,
                        num_generate=tokens_to_generate,
                        temperature=temperature,
                        top_k=top_k,
                        top_p=top_p,
                        num_variations=num_variations
                    )
                )
                
                # If multiple variations were generated, store JSON; otherwise, store the single filename
                if isinstance(generated_paths, list):
                    if len(generated_paths) > 1:
                        stored_output = json.dumps([os.path.basename(p) for p in generated_paths])
                    else:
                        stored_output = os.path.basename(generated_paths[0])
                else:
                    stored_output = output_filename
            else:
                stored_output = generate_output_midi(job_id, job_type, target_genre, bars)

            _complete_job(job_id, {
                "status": "completed",
                "completed_at": datetime.now(timezone.utc),
                "output_filename": stored_output,
            })

    except asyncio.CancelledError:
        print(f"[SYS] Job {job_id} cancelled by user.")
        _set_status(job_id, "cancelled")
        raise

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
    modelType: str = Field(default="remi")
    numVariations: int = Field(default=1, ge=1, le=3) # Allow between 1 and 3 options

@router.post("/jobs/extend", status_code=201)
async def extend_midi(body: ExtendInput):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO jobs (type, status, input_filename, bars_to_extend) VALUES (%s, %s, %s, %s) RETURNING *",
                ("extend", "pending", body.inputFilename, body.barsToExtend),
            )
            row = cur.fetchone()
    task = asyncio.create_task(simulate_processing(
        row["id"], "extend", bars=body.barsToExtend, input_filename=body.inputFilename, 
        temperature=body.temperature, top_k=body.topK, top_p=body.topP, model_type=body.modelType,
        num_variations=body.numVariations # Pass to worker
    ))
    RUNNING_TASKS[row["id"]] = task
    task.add_done_callback(lambda t, jid=row["id"]: RUNNING_TASKS.pop(jid, None))
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
    task = asyncio.create_task(simulate_processing(row["id"], "evaluate",
                                 target_genre=body.targetGenre, input_filename=body.inputFilename))
    RUNNING_TASKS[row["id"]] = task
    task.add_done_callback(lambda t, jid=row["id"]: RUNNING_TASKS.pop(jid, None))
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
    bpm: int = 120

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
            lambda: composer_octuple.live_extend(notes_data, body.num_generate, body.temperature, body.bpm)
        )
        return {"notes": result_notes}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/jam/export", status_code=200)
async def export_jam_midi(body: JamRequest):
    """Takes the frontend JSON notes and builds a real .mid file for debugging."""
    if not body.notes:
        raise HTTPException(status_code=400, detail="No notes provided")

    from symusic import Score, Track, Note, Tempo, TimeSignature
    import os
    
    # Build the score exactly how the AI engine builds it
    score = Score(480) 
    score.tempos.append(Tempo(time=0, qpm=body.bpm))
    score.time_signatures.append(TimeSignature(time=0, numerator=4, denominator=4))
    
    track = Track(program=0, is_drum=False, name="ExportedJam")
    for n in body.notes:
        track.notes.append(Note(
            time=int(n.time), 
            duration=int(n.duration), 
            pitch=int(n.pitch), 
            velocity=int(n.velocity)
        ))
        
    track.notes.sort(key=lambda x: getattr(x, 'time', 0))
    score.tracks.append(track)
    
    # Save to a temporary file
    fd, path = tempfile.mkstemp(suffix=".mid")
    os.close(fd)
    score.dump_midi(path)
    
    return FileResponse(path, media_type="audio/midi", filename="jam_debug.mid")

# ── GET /jobs/:id/download ────────────────────────────────────────────────────
@router.get("/jobs/{job_id}/download")
def download_job_result(job_id: int, type: str = "full", variation: int = 1):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM jobs WHERE id = %s", (job_id,))
            row = cur.fetchone()
            
    if not row or row["status"] != "completed" or not row["output_filename"]:
        raise HTTPException(status_code=404, detail="Job result not found")

    output_raw = row["output_filename"]
    
    # Resolve target variation filename if stored as a list
    if output_raw.startswith("["):
        try:
            var_list = json.loads(output_raw)
            idx = max(0, min(variation - 1, len(var_list) - 1))
            target_filename = var_list[idx]
        except Exception:
            target_filename = f"amadeus_creation_{job_id}.mid"
    else:
        # Backward compatibility for single jobs or when variation > 1 is requested on a multi-var run
        if variation > 1:
            target_filename = f"amadeus_creation_{job_id}_var{variation}.mid"
        else:
            target_filename = output_raw

    base_name = target_filename.replace(".mid", "")
    
    if type == "extension":
        file_name = f"{base_name}_extension.mid"
        media_type = "audio/midi"
        download_name = f"extension_{target_filename}"
    elif type == "audio":
        file_name = f"{base_name}.wav"
        media_type = "audio/wav"
        download_name = target_filename.replace(".mid", ".wav")
    elif type == "input":
        file_name = row["input_filename"]
        media_type = "audio/midi"
        download_name = f"seed_{row['input_filename']}"
    else: # full
        file_name = f"{base_name}_full.mid"
        media_type = "audio/midi"
        download_name = f"full_{target_filename}"

    file_path = Path(UPLOADS_DIR) / file_name
    
    # Fallback to base .mid file if specific artifact is missing
    if not file_path.exists():
        file_path = Path(UPLOADS_DIR) / target_filename
        download_name = target_filename
        media_type = "audio/midi"
        
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found on disk")
        
    return FileResponse(path=file_path, filename=download_name, media_type=media_type)

# Job cancelation
@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: int):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT status FROM jobs WHERE id = %s", (job_id,))
            row = cur.fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Job not found")

            if row["status"] in ["completed", "failed", "cancelled"]:
                return {"message": f"Job already {row['status']}"}

            cur.execute("UPDATE jobs SET status = 'cancelled' WHERE id = %s", (job_id,))

    # Cancel the asyncio background worker if still running
    task = RUNNING_TASKS.pop(job_id, None)
    if task and not task.done():
        task.cancel()

    return {"message": f"Job {job_id} cancelled"}

from pydantic import BaseModel

class RenameJobRequest(BaseModel):
    newFilename: str

@router.patch("/jobs/{job_id}/rename")
def rename_job(job_id: int, body: RenameJobRequest):
    """Updates the input_filename (used as the display name) for a specific job."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            # First check if it exists
            cur.execute("SELECT id FROM jobs WHERE id = %s", (job_id,))
            if not cur.fetchone():
                raise HTTPException(status_code=404, detail="Job not found")
                
            # Perform the update
            cur.execute(
                "UPDATE jobs SET input_filename = %s WHERE id = %s", 
                (body.newFilename, job_id)
            )
            
    return {"message": "Job renamed successfully", "new_filename": body.newFilename}