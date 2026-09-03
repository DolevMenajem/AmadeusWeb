import os
import uuid
import subprocess
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import FileResponse

# Same env-configured render tooling composer_engine uses (duplicated here so a
# lightweight file route never has to import the torch-heavy engine module).
SOUNDFONT_PATH = os.environ.get("SOUNDFONT_PATH", "/usr/share/sounds/sf2/FluidR3_GM.sf2")
FLUIDSYNTH_BIN = os.environ.get("FLUIDSYNTH_PATH", "fluidsynth")

# Absolute path based on this file's location — survives any chdir
_SERVER_ROOT = Path(__file__).parent.parent.parent
UPLOADS_DIR = _SERVER_ROOT / "uploads"
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

router = APIRouter()


@router.post("/upload")
async def upload_midi_file(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in (".mid", ".midi"):
        raise HTTPException(status_code=400, detail="Only .mid and .midi files are allowed")

    unique_name = f"{uuid.uuid4()}{ext}"
    dest = UPLOADS_DIR / unique_name

    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="File too large (max 10 MB)")

    dest.write_bytes(content)

    return {
        "filename": unique_name,
        "originalName": file.filename,
        "size": len(content),
    }


@router.get("/files/{filename}")
def get_file(filename: str):
    safe_name = Path(filename).name
    filepath = UPLOADS_DIR / safe_name
    if not filepath.exists():
        raise HTTPException(status_code=404, detail="File not found")
    # Media type by suffix, served inline so <audio> elements and fetch() can
    # consume the file directly (the showcase page streams both kinds).
    media_type = "audio/wav" if filepath.suffix.lower() == ".wav" else "audio/midi"
    return FileResponse(
        path=str(filepath),
        media_type=media_type,
        filename=safe_name,
        headers={"Content-Disposition": f'inline; filename="{safe_name}"'},
    )


@router.post("/files/{filename}/render")
def render_uploaded_midi(filename: str):
    """Render an uploaded MIDI to WAV with FluidSynth (for the showcase page).

    Returns {"audio": false} rather than erroring when no renderer/soundfont is
    installed — the frontend then falls back to its in-browser piano player.
    """
    safe_name = Path(filename).name
    midi_path = UPLOADS_DIR / safe_name
    if not midi_path.exists() or midi_path.suffix.lower() not in (".mid", ".midi"):
        raise HTTPException(status_code=404, detail="MIDI file not found")

    wav_name = f"{midi_path.stem}.wav"
    wav_path = UPLOADS_DIR / wav_name
    if wav_path.exists():
        return {"audio": True, "filename": wav_name}

    if not os.path.exists(SOUNDFONT_PATH):
        return {"audio": False, "reason": "soundfont not installed"}
    try:
        subprocess.run(
            [FLUIDSYNTH_BIN, "-ni", "-F", str(wav_path), "-r", "44100",
             SOUNDFONT_PATH, str(midi_path)],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"[Showcase] FluidSynth render failed: {e}")
        return {"audio": False, "reason": "render failed"}
    return {"audio": True, "filename": wav_name}
