import os
import uuid
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import FileResponse

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
    return FileResponse(
        path=str(filepath),
        media_type="audio/midi",
        filename=safe_name,
        headers={"Content-Disposition": f'attachment; filename="{safe_name}"'},
    )
