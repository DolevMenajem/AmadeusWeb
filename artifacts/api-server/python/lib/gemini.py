"""
Gemini client — works both on Replit (via AI Integrations proxy) and locally (via direct API key).

On Replit:  AI_INTEGRATIONS_GEMINI_BASE_URL + AI_INTEGRATIONS_GEMINI_API_KEY are set automatically.
Locally:    Set GEMINI_API_KEY in your .env file (get a free key at https://aistudio.google.com/apikey).
"""
import os
from google import genai

LECTURER_MODEL = "gemini-2.5-flash"

_base_url = os.environ.get("AI_INTEGRATIONS_GEMINI_BASE_URL")
_replit_key = os.environ.get("AI_INTEGRATIONS_GEMINI_API_KEY")
_local_key = os.environ.get("GEMINI_API_KEY")

if _base_url and _replit_key:
    # Running on Replit — use AI Integrations proxy (no personal API key needed)
    client = genai.Client(api_key=_replit_key, http_options={"base_url": _base_url})
elif _local_key:
    # Running locally — use a direct Google Gemini API key
    client = genai.Client(api_key=_local_key)
else:
    raise RuntimeError(
        "No Gemini credentials found.\n"
        "  Local: set GEMINI_API_KEY in your .env file (https://aistudio.google.com/apikey)\n"
        "  Replit: AI_INTEGRATIONS_GEMINI_BASE_URL and AI_INTEGRATIONS_GEMINI_API_KEY are set automatically."
    )


async def generate_lecturer_feedback(
    target_genre: str,
    features: dict,
) -> str:
    tempo = features.get("estimatedTempo", 120)
    total_notes = features.get("totalNotes", 80)
    duration = features.get("durationSeconds", 30)
    pitch_range = features.get("pitchRange", 0)
    density = features.get("notesPerSecond", 0)
    polyphony = features.get("maxPolyphony", 1)
    velocity_variance = features.get("velocityVariance", 0)

    dynamics = "high dynamic variation" if velocity_variance > 30 else "somewhat flat, robotic dynamics"

    prompt = (
        f"You are a university music lecturer evaluating a student's composition. "
        f"The student stated they are writing in the style of '{target_genre}'.\n"
        f"Metrics: {duration}s, ~{tempo} BPM, {total_notes} notes, pitch range of {pitch_range} semitones, "
        f"{density} notes/sec, max chord polyphony of {polyphony}, exhibiting {dynamics}.\n\n"
        f"You MUST respond ONLY with a raw JSON object. Do not include markdown blocks, backticks, or any other text. "
        f"Use this exact schema:\n"
        f"{{\n"
        f'  "overallScore": <integer 0-100>,\n'
        f'  "rhythmScore": <integer 0-100>,\n'
        f'  "harmonyScore": <integer 0-100>,\n'
        f'  "melodyScore": <integer 0-100>,\n'
        f'  "complexityScore": <integer 0-100>,\n'
        f'  "lecturerFeedback": "<string 3-4 sentences of feedback>",\n'
        f'  "summary": "<string 1 short sentence summary>",\n'
        f'  "suggestions": ["<string suggestion 1>", "<string suggestion 2>"]\n'
        f"}}\n"
    )

    response = await client.aio.models.generate_content(
        model=LECTURER_MODEL,
        contents=[{"role": "user", "parts": [{"text": prompt}]}],
        config={"max_output_tokens": 8192},
    )
    return response.text or "{}"
