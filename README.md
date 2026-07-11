# Social Flow — Development Setup

AI-powered content generation for Shopify & Etsy sellers.
Generates Pinterest Pins and Instagram posts from product URLs.

## Project Structure

```
Pinterest flow/
├── web/          # Next.js 15 frontend (Vercel)
├── api/          # FastAPI backend (Railway)
└── 竞品/         # Competitor reference screenshots
```

## Quick Start

### Prerequisites
- Node.js 20+
- Python 3.12+
- Redis (local or Upstash)
- Supabase account

### 1. Backend

```bash
cd api
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # Mac/Linux

pip install -r requirements.txt
playwright install chromium

cp .env.example .env
# Fill in your API keys in .env

# Run DB migrations
# Paste supabase_schema.sql into Supabase SQL editor

# Start API
uvicorn app.main:app --reload --port 8000

# Start worker (separate terminal)
python -m arq app.workers.task_worker.WorkerSettings
```

### 2. Frontend

```bash
cd web
cp .env.local.example .env.local   # or edit .env.local directly
npm install
npm run dev
# Opens at http://localhost:3000
```

## Key API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/tasks` | Create generation task |
| `GET`  | `/api/tasks` | List tasks |
| `GET`  | `/api/tasks/{id}` | Get task status |
| `GET`  | `/api/tasks/{id}/stream` | SSE real-time status |
| `PATCH`| `/api/tasks/{id}` | Update copy/assets |
| `POST` | `/api/tasks/{id}/publish` | Publish to platforms |
| `GET`  | `/api/auth/pinterest` | Start Pinterest OAuth |
| `GET`  | `/api/auth/instagram` | Start Instagram OAuth |
| `GET`  | `/api/auth/status` | Get connection status |

## Frontend Routes

| Route | Description |
|-------|-------------|
| `/` | Landing page |
| `/dashboard` | Task queue + new task form |
| `/preview/[taskId]` | Review and publish generated content |
| `/settings` | Platform connections + preferences |

## Environment Variables

See `api/.env.example` and `web/.env.local`.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 15 + Tailwind CSS → Vercel |
| Backend | Python 3.12 + FastAPI → Railway |
| AI Scene Gen | Flux.1 Schnell → RunPod Serverless |
| Segmentation | SAM 2 → Replicate API |
| Copywriting | OpenAI GPT-4o |
| Database | Supabase (PostgreSQL) |
| Storage | Supabase Storage + CDN |
| Queue | Upstash Redis + ARQ |
| Auth | Supabase Auth |
| Monitoring | Sentry + PostHog |

## Development Notes

- AI image generation requires RunPod endpoint with ComfyUI + Flux.1 Schnell
- Pinterest OAuth requires approved Developer App
- Instagram OAuth requires Meta App with `instagram_content_publish` permission
- SAM 2 segmentation is MVP-deferred; images use direct Flux inference
