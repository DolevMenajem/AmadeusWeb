import os
import struct
import random
from pathlib import Path

# --- FIXED: Use absolute pathing to find the true api-server/uploads directory
UPLOADS_DIR = str(Path(__file__).resolve().parent.parent.parent / "uploads")

SCALES = {
    "major":      [60, 62, 64, 65, 67, 69, 71, 72],
    "minor":      [60, 62, 63, 65, 67, 68, 70, 72],
    "blues":      [60, 63, 65, 66, 67, 70, 72, 75],
    "pentatonic": [60, 62, 64, 67, 69, 72, 74, 76],
    "dorian":     [60, 62, 63, 65, 67, 69, 70, 72],
}

GENRE_SCALE = {
    "jazz": "dorian", "classical": "major", "blues": "blues",
    "electronic": "pentatonic", "bossa-nova": "major", "rock": "minor",
    "ambient": "pentatonic", "latin": "major", "funk": "dorian", "folk": "major",
}

def _var_len(value: int) -> bytes:
    result = []
    result.append(value & 0x7F)
    value >>= 7
    while value:
        result.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(reversed(result))

def _make_midi(notes: list[tuple[int, int, int]]) -> bytes:
    ticks_per_beat = 480
    tempo = 500000  # 120 BPM

    track_events = bytearray()
    for pitch, velocity, dur in notes:
        track_events += _var_len(0)
        track_events += bytes([0x90, pitch, velocity])
        track_events += _var_len(dur)
        track_events += bytes([0x80, pitch, 0])
    track_events += _var_len(0) + bytes([0xFF, 0x2F, 0x00])

    tempo_track = bytearray()
    tempo_track += _var_len(0) + bytes([0xFF, 0x51, 0x03]) + struct.pack(">I", tempo)[1:]
    tempo_track += _var_len(0) + bytes([0xFF, 0x2F, 0x00])

    def make_chunk(tag: bytes, data: bytes) -> bytes:
        return tag + struct.pack(">I", len(data)) + data

    header = struct.pack(">HHH", 1, ticks_per_beat, ticks_per_beat)
    midi = make_chunk(b"MThd", header)
    midi += make_chunk(b"MTrk", bytes(tempo_track))
    midi += make_chunk(b"MTrk", bytes(track_events))
    return midi

def generate_output_midi(job_id: int, job_type: str, target_genre: str | None = None, bars_to_extend: int | None = None) -> str:
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    filename = f"output_{job_id}_{job_type}.mid"
    filepath = os.path.join(UPLOADS_DIR, filename)

    scale_key = GENRE_SCALE.get(target_genre or "", "major") if target_genre else "major"
    scale = SCALES.get(scale_key, SCALES["major"])

    bars = min(bars_to_extend or 8, 16)
    ticks_per_beat = 480
    notes_per_bar = 4
    total_notes = bars * notes_per_bar
    dur_map = {"4": ticks_per_beat, "8": ticks_per_beat // 2, "2": ticks_per_beat * 2}
    durations = ["4", "4", "8", "8", "2", "4"]

    notes = []
    prev_idx = random.randint(0, len(scale) - 1)
    for _ in range(total_notes):
        if random.random() < 0.08:
            continue
        step = random.randint(-2, 2)
        idx = max(0, min(len(scale) - 1, prev_idx + step))
        prev_idx = idx
        pitch = scale[idx]
        if random.random() < 0.15:
            pitch += 12 if random.random() < 0.5 else -12
        pitch = max(48, min(84, pitch))
        velocity = random.randint(70, 110)
        dur_key = random.choice(durations)
        dur_ticks = dur_map[dur_key]
        notes.append((pitch, velocity, dur_ticks))

    midi_bytes = _make_midi(notes)
    with open(filepath, "wb") as f:
        f.write(midi_bytes)

    return filename

def extract_midi_features(filepath: str) -> dict:
    import mido
    mid = mido.MidiFile(filepath)
    
    total_notes = 0
    pitches: set[int] = set()
    tempos = []
    velocities = []
    
    highest_pitch = 0
    lowest_pitch = 127
    
    current_poly_count = 1
    max_polyphony = 1

    for track in mid.tracks:
        for msg in track:
            if msg.type == "note_on" and msg.velocity > 0:
                total_notes += 1
                pitches.add(msg.note)
                velocities.append(msg.velocity)
                
                # Pitch Tracking
                if msg.note > highest_pitch: highest_pitch = msg.note
                if msg.note < lowest_pitch: lowest_pitch = msg.note
                
                # Polyphony Tracking (notes played at the exact same time)
                if getattr(msg, 'time', 0) < 5:
                    current_poly_count += 1
                else:
                    if current_poly_count > max_polyphony:
                        max_polyphony = current_poly_count
                    current_poly_count = 1
                    
            elif msg.type == "set_tempo":
                tempos.append(round(60_000_000 / msg.tempo))
                
    avg_tempo = round(sum(tempos) / len(tempos)) if tempos else 120
    duration_sec = round(mid.length, 1)
    
    pitch_range = highest_pitch - lowest_pitch if total_notes > 0 else 0
    note_density = round(total_notes / duration_sec, 2) if duration_sec > 0 else 0
    
    # Calculate Velocity Variance (Dynamic Range)
    velocity_variance = (max(velocities) - min(velocities)) if velocities else 0

    return {
        "totalNotes": total_notes,
        "uniquePitches": len(pitches),
        "estimatedTempo": avg_tempo,
        "durationSeconds": duration_sec,
        "pitchRange": pitch_range,          
        "notesPerSecond": note_density,
        "maxPolyphony": max_polyphony,
        "velocityVariance": velocity_variance
    }