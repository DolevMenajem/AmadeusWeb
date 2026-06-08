import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()


@router.websocket("/ws/live")
async def live_ws(websocket: WebSocket):
    await websocket.accept()

    async def stream_feedback():
        messages = [
            "Detecting key signature...",
            "Analysing rhythmic patterns...",
            "Evaluating harmonic structure...",
            "Assessing melodic contour...",
            "Generating real-time feedback...",
        ]
        idx = 0
        while True:
            await asyncio.sleep(2)
            try:
                await websocket.send_json({
                    "type": "evaluation",
                    "message": messages[idx % len(messages)],
                    "bpm": 120 + (idx * 3 % 30),
                    "pitchActivity": round(0.4 + (idx * 0.1 % 0.5), 2),
                })
                idx += 1
            except Exception:
                break

    feedback_task = asyncio.create_task(stream_feedback())

    try:
        while True:
            data = await websocket.receive_bytes()
            # MIDI byte stream received from client
            # TODO: pass to real-time ML model for analysis
            await websocket.send_json({
                "type": "ack",
                "bytesReceived": len(data),
            })
    except WebSocketDisconnect:
        pass
    finally:
        feedback_task.cancel()
