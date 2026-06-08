# MIDI ML Studio

A web platform for AI-powered MIDI music processing — users submit MIDI files and receive AI-generated continuations, genre transformations, musical evaluations, and live extensions.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080, served at `/api`)
- `pnpm --filter @workspace/midi-ml run dev` — run the frontend (port 19247, served at `/`)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + Tailwind CSS + shadcn/ui + wouter
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — OpenAPI spec (source of truth for all API contracts)
- `lib/db/src/schema/` — Drizzle ORM schema (jobs.ts, genres.ts)
- `lib/api-client-react/src/generated/` — generated React Query hooks
- `lib/api-zod/src/generated/` — generated Zod validation schemas
- `artifacts/api-server/src/routes/` — Express route handlers (jobs, genres, stats, health)
- `artifacts/midi-ml/src/` — React frontend (pages: dashboard, extend, transform, evaluate, live, jobs)

## Architecture decisions

- OpenAPI-first: all API contracts are defined in `openapi.yaml` before writing any code. Codegen produces both React Query hooks (frontend) and Zod schemas (backend validation).
- MIDI processing is simulated server-side via async `setTimeout` callbacks that transition job statuses: pending → processing → completed/failed. Real ML model integration would replace this.
- Genre list is stored in the DB (`genres` table) to allow future admin management.
- Jobs use a `jsonb` column (`evaluation_result`) for flexible evaluation score storage.
- Frontend polls individual job status using `useGetJob` with `enabled: !!id` to track processing progress.

## Product

- **Music Extension** — upload a MIDI file, choose 1–64 bars to extend, get an AI-continued MIDI back
- **Genre Transform** — upload MIDI + pick a target genre (Jazz, Classical, Blues, etc.), get the piece re-styled
- **Music Evaluation** — upload MIDI, receive scored analysis (rhythm, harmony, melody, complexity) with suggestions
- **Live Extension** — fast 1–8 bar extension for real-time performance use cases
- **Jobs Dashboard** — track all past jobs, download completed outputs

## Gotchas

- Run `pnpm --filter @workspace/api-spec run codegen` after every spec change before touching frontend or backend code
- The `jobs/extend`, `jobs/transform`, `jobs/evaluate`, `jobs/live-extend` routes must come before `jobs/:id` in the router or Express will match the string as an ID
- Enum values in Drizzle (`pgEnum`) must be pushed to the DB before inserting rows that use them
