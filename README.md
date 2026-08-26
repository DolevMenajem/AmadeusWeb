# Amadeus — AI-Powered Tri-Brain Music Studio

Amadeus is a full-stack web platform utilizing a custom "Tri-Brain" PyTorch architecture to process, extend, and evaluate MIDI music. 

| Mode | What it does |
|---|---|
| **Offline Extension** | Extend your piece by 1–64 bars using a choice of three distinct AI architectures (REMI, Octuple, TSD). |
| **Evaluate & Feedback** | Concurrently extracts musical features and evaluates the piece through three academic lenses (Theory, Rhythm, Genre) via Gemini 2.5 Flash, cached locally via SHA-256 hashing. |
| **Live Studio (Jam)** | A real-time, hardware-synced environment. Plug in a USB MIDI keyboard to play and record alongside the AI, featuring a WebAudio dynamic metronome. |

---

## Directory structure

```text
amadeus/
├── artifacts/
│   ├── api-server/             # Python/FastAPI backend
│   │   ├── server.py           # Uvicorn entrypoint — run this to start the API
│   │   ├── python/
│   │   │   ├── main.py         # FastAPI app — mounts all routers
│   │   │   ├── evaluation_cache.json # Local SHA-256 cache for LLM evaluations
│   │   │   ├── routers/
│   │   │   │   ├── health.py   # GET /api/healthz
│   │   │   │   ├── upload.py   # POST /api/upload
│   │   │   │   ├── genres.py   # GET /api/genres
│   │   │   │   ├── jobs.py     # POST/GET /api/jobs/* (extend, transform, evaluate, live-extend)
│   │   │   │   ├── stats.py    # GET /api/stats
│   │   │   │   └── websocket.py# WS  /ws/live
│   │   │   ├── lib/
│   │   │   │   ├── db.py       # Async SQLAlchemy / asyncpg connection pool
│   │   │   │   ├── gemini.py   # Gemini client (Multi-lens persona routing)
│   │   │   │   └── midi_gen.py # MIDI feature extraction + generation helpers
│   │   │   └── models/
│   │   │       ├── classifier_model.py        # Genre classifier
│   │   │       ├── composer_engine.py         # Tri-Brain PyTorch Wrapper
│   │   │       ├── checkpoint_best.pt         # Brain A: REMI Model Weights
│   │   │       ├── Compose10k.json            # Brain A: REMI Tokenizer
│   │   │       ├── checkpoint_best_octuple.pt # Brain B: Octuple Model Weights
│   │   │       ├── Compose_Octuple.json       # Brain B: Octuple Tokenizer
│   │   │       ├── checkpoint_best_tsd.pt     # Brain C: TSD Model Weights
│   │   │       └── Compose_TSD.json           # Brain C: TSD Tokenizer
│   │   └── uploads/            # Uploaded + generated MIDI and WAV files (git-ignored)
│   │
│   └── midi-ml/                # React + Vite frontend
│       ├── src/
│       │   ├── pages/          # evaluate.tsx, extend.tsx, transform.tsx, live.tsx, jobs.tsx, home.tsx
│       │   ├── components/     # Shared UI — ArchitectureModal, DebugTerminal, MidiVisualizer, etc.
│       │   └── App.tsx         # Router (wouter) + React Query provider
│       ├── vite.config.ts
│       └── index.html
│
├── lib/
│   ├── api-spec/               # OpenAPI spec — source of truth for all API contracts
│   │   └── openapi.yaml        # Edit this first, then run codegen
│   ├── api-client-react/       # Generated React Query hooks (do not edit manually)
│   ├── api-zod/                # Generated Zod validation schemas (do not edit manually)
│   └── db/                     # Drizzle ORM schema + migration config
│       └── src/schema/
│           ├── jobs.ts         # jobs table
│           └── genres.ts       # genres table
│
├── scripts/                    # Shared utility scripts (pnpm workspace package)
├── requirements.txt            # Python dependencies (includes torch, miditok, symusic)
├── .env.example                # Copy to .env and fill in values
├── pnpm-workspace.yaml         # pnpm monorepo config + catalog pins
└── tsconfig.json               # Root TypeScript solution file (libs only)
```

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | 22+ | https://nodejs.org or use `nvm` |
| pnpm | 10+ | `npm install -g pnpm` |
| Python | 3.11+ | https://python.org or use `pyenv` |
| PostgreSQL | 15+ | https://postgresql.org or use Docker (see below) |
| **FluidSynth** | Latest | **Required for rendering `.wav` files.** (Mac: `brew install fluidsynth`, Windows: download binary, Linux: `apt install fluidsynth`) |

---

## 1. Clone and configure environment

```bash
git clone <repo-url>
cd amadeus

# Copy the example env file
cp .env.example .env
```

Open `.env` and fill in the two required values:

```dotenv
# Your PostgreSQL connection string
DATABASE_URL=postgresql://postgres:password@localhost:5432/amadeus

# Free Gemini API key — [https://aistudio.google.com/apikey](https://aistudio.google.com/apikey)
# Required for Evaluate & Feedback. All other features work without it.
GEMINI_API_KEY=your_key_here
```

### Quick PostgreSQL via Docker (optional)

If you don't have PostgreSQL installed locally:

```bash
docker run -d \
  --name amadeus-pg \
  -e POSTGRES_DB=amadeus \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  postgres:16
```

---

## 2. Install Node.js dependencies

```bash
pnpm install
```

This installs all workspace packages: the frontend, the shared libraries, and the codegen tools.

---

## 3. Install Python ML dependencies

```bash
python3 -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

---

## 4. Set up the database

Push the Drizzle schema to your PostgreSQL database (creates the `jobs` and `genres` tables):

```bash
pnpm --filter @workspace/db run push
```

You should see Drizzle confirm the tables were created.

---

## 5. Run the backend

Open a terminal and start the FastAPI server:

```bash
python3 artifacts/api-server/server.py
```

The API will be available at **http://localhost:8080**.

Check it is running:

```bash
curl http://localhost:8080/api/healthz
# {"status":"ok"}
```

---

## 6. Run the frontend

Open a second terminal and start the Vite dev server:

```bash
pnpm --filter @workspace/midi-ml run dev
```

Open **http://localhost:19247** in your browser.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 7, Recharts, Tailwind CSS 4, shadcn/ui, wouter, TanStack Query |
| Hardware I/O | Web MIDI API, WebAudio API, Tone.js |
| Backend | Python 3.11, FastAPI, Uvicorn, Asyncio Concurrent Tasks |
| Database | PostgreSQL 15, SQLAlchemy (asyncpg), Drizzle ORM (schema + migrations) |
| AI & ML | PyTorch, Miditok, Symusic, Google Gemini 2.5 Flash |
| Monorepo | pnpm workspaces, Node.js 22, TypeScript 5.9 |