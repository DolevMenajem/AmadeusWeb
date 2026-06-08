# Amadeus — AI-Powered MIDI Music Studio

Amadeus is a full-stack web platform that uses AI to process MIDI music files. Upload a MIDI and choose from four modes:

| Mode | What it does |
|---|---|
| **Extension** | Extend your piece by 1–64 bars using AI continuation |
| **Genre Transform** | Re-style the piece in Jazz, Classical, Blues, and more |
| **Evaluate & Feedback** | Extract musical features and get personalised feedback from the AI Lecturer (powered by Gemini) |
| **Live Extend** | Ping-pong real-time session — exchange 1–8 bar extensions interactively |

---

## Directory structure

```
amadeus/
├── artifacts/
│   ├── api-server/             # Python/FastAPI backend
│   │   ├── server.py           # Uvicorn entrypoint — run this to start the API
│   │   ├── python/
│   │   │   ├── main.py         # FastAPI app — mounts all routers
│   │   │   ├── routers/
│   │   │   │   ├── health.py   # GET /api/healthz
│   │   │   │   ├── upload.py   # POST /api/upload
│   │   │   │   ├── genres.py   # GET /api/genres
│   │   │   │   ├── jobs.py     # POST/GET /api/jobs/* (extend, transform, evaluate, live-extend)
│   │   │   │   ├── stats.py    # GET /api/stats
│   │   │   │   └── websocket.py# WS  /ws/live
│   │   │   ├── lib/
│   │   │   │   ├── db.py       # Async SQLAlchemy / asyncpg connection pool
│   │   │   │   ├── gemini.py   # Gemini client (Replit proxy OR local API key)
│   │   │   │   └── midi_gen.py # MIDI feature extraction + generation helpers
│   │   │   └── models/
│   │   │       └── classifier_model.py  # Drop your PyTorch .pth model here
│   │   └── uploads/            # Uploaded + generated MIDI files (git-ignored)
│   │
│   └── midi-ml/                # React + Vite frontend
│       ├── src/
│       │   ├── pages/          # evaluate.tsx, extend.tsx, transform.tsx, live.tsx, jobs.tsx, home.tsx
│       │   ├── components/     # Shared UI — MidiPlayer, MidiFileUpload, Layout, etc.
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
├── requirements.txt            # Python dependencies
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

# Free Gemini API key — https://aistudio.google.com/apikey
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

## 3. Install Python dependencies

```bash
pip install -r requirements.txt
```

Or, if you prefer a virtual environment:

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

## 7. Using the app

1. **Dashboard** — overview and recent jobs
2. **Extension** — upload a `.mid` or `.midi` file, choose bars to add, submit. The in-browser player lets you hear the result immediately.
3. **Genre Transform** — upload a MIDI, pick a target genre from the dropdown, submit.
4. **Evaluate & Feedback** — upload a MIDI and press "Evaluate Composition". Amadeus extracts features (tempo, note density, pitch range) and calls Gemini to generate personalised lecturer feedback.
5. **Live Extend** — a chat-style session where you upload a seed MIDI and receive back-and-forth AI extensions.
6. **All Jobs** — full history with download links for completed outputs.

---

## Development workflows

### Regenerate API hooks after changing the OpenAPI spec

The frontend hooks and backend Zod schemas are generated from `lib/api-spec/openapi.yaml`. After editing the spec, run:

```bash
pnpm --filter @workspace/api-spec run codegen
```

This updates both `lib/api-client-react/src/generated/` and `lib/api-zod/src/generated/`.

### Typecheck the whole project

```bash
pnpm run typecheck
```

### Adding a new job type

1. Add the route and request/response schemas to `lib/api-spec/openapi.yaml`.
2. Run `pnpm --filter @workspace/api-spec run codegen`.
3. Add the route handler in `artifacts/api-server/python/routers/jobs.py`.
4. Add the frontend page in `artifacts/midi-ml/src/pages/` and register it in `App.tsx`.

### Plugging in a real PyTorch model

The genre classifier in `artifacts/api-server/python/models/classifier_model.py` is a commented-out placeholder. To use a real model:

1. Train or download a `.pth` file that accepts a feature vector and outputs genre logits.
2. Place it at `artifacts/api-server/python/models/genre_classifier.pth`.
3. Follow the instructions in `classifier_model.py` to uncomment and adapt the loading code.
4. Replace the mock prediction in `artifacts/api-server/python/routers/jobs.py` (`evaluate_job` function) with a call to your model.

---

## Environment variables reference

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `GEMINI_API_KEY` | For Evaluate | Direct Google Gemini API key (local dev) |
| `AI_INTEGRATIONS_GEMINI_BASE_URL` | Replit only | Set automatically by Replit AI Integrations |
| `AI_INTEGRATIONS_GEMINI_API_KEY` | Replit only | Set automatically by Replit AI Integrations |
| `PORT` | No | API server port (default: `8080`) |

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite 7, Tailwind CSS 4, shadcn/ui, wouter, TanStack Query |
| MIDI playback | Tone.js + @tonejs/midi |
| Backend | Python 3.11, FastAPI, Uvicorn |
| Database | PostgreSQL 15, SQLAlchemy (asyncpg), Drizzle ORM (schema + migrations) |
| AI | Google Gemini 2.5 Flash (via google-genai) |
| MIDI processing | mido (Python) |
| API contract | OpenAPI 3.1 (Orval codegen → React Query hooks + Zod schemas) |
| Monorepo | pnpm workspaces, Node.js 22, TypeScript 5.9 |
