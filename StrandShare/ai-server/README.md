# Wig AI Studio - AI Server

Local Python service that converts a wig reference photo into a 3D `.glb`
filter for AR try-on. Triggered by the Specialist's Wig AI Studio page; the
React Native mobile app never talks to it directly -- it only reads the final
`.glb` from Supabase Storage.

## Stack

- **FastAPI** for the HTTP layer
- **rembg / U2Net** for background removal
- **TripoSR** (Stability AI, MIT licensed) for image-to-3D
- **trimesh** for mesh export and thumbnail render
- **Supabase service-role client** for storage I/O and row updates
- **CUDA 11.8 + PyTorch 2.4.1** for GPU inference

Tuned to run on an **NVIDIA RTX 3050 Laptop (4 GB VRAM)**: fp16, attention
chunking, 512 px input, marching-cubes resolution 192. Per-wig inference is
roughly 30-90 s. On a beefier Hostinger GPU VPS you can raise
`TRIPOSR_MC_RESOLUTION` and `TRIPOSR_RENDER_RESOLUTION` in `.env` for nicer
meshes without code changes.

## Local run

```bash
cd ai-server
cp .env.example .env
# fill in SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
docker compose up --build
```

The first build downloads CUDA + Python deps (~5 GB) and the first request
downloads model weights (~1.5 GB) into the `models` volume. After that,
restarts are fast.

Verify:

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok"}
```

Windows note:

- If `python` shows "Python was not found...", use `py -3` commands instead.
- Example: `py -3 -m compileall ai-server/app`

## Frontend env

In your React app's `.env.local`:

```
REACT_APP_AI_SERVER_URL=http://127.0.0.1:8000
```

## Deploying to Hostinger

1. Provision a GPU VPS (any tier with an RTX/A-series card with >=4 GB VRAM).
2. Install Docker + the NVIDIA Container Toolkit.
3. `git pull` the repo, `cd StrandShare/ai-server`, populate `.env`.
4. `docker compose up -d`.
5. Point `REACT_APP_AI_SERVER_URL` at `https://<your-host>:8000` (put it
   behind your existing reverse proxy / TLS).

No code change between local and Hostinger -- only `.env` and
`ALLOWED_ORIGINS`.

## API

### `POST /generate-filter`

Request body:

```json
{
  "filter_id": 12,
  "auth_user_id": "a1b2c3d4-...",
  "source_front_path": "a1b2c3d4-.../wig-ai-sources/draft-ab12cd/front.png",
  "source_side_path":  "a1b2c3d4-.../wig-ai-sources/draft-ab12cd/side.png",
  "source_top_path":   null,
  "source_back_path":  null,
  "version": 1
}
```

Response (immediate):

```json
{ "filter_id": 12, "status": "processing", "message": "Pipeline queued..." }
```

### `GET /status/{filter_id}`

Mirrors the matching row in `Wig_AI_Filters`. Frontend can equivalently
subscribe via Supabase Realtime; this endpoint is a fallback / debug aid.

### `GET /health`

Liveness probe used by `docker-compose` healthcheck.

## Project layout

```
ai-server/
  Dockerfile
  docker-compose.yml
  requirements.txt
  .env.example
  app/
    __init__.py
    main.py               # FastAPI app, /generate-filter, /status, /health
    pipeline.py           # rembg layered pipeline -> 5 PNG layers
    supabase_client.py    # storage download/upload + Wig_AI_Filters updates
    config.py             # env-loaded settings
```

## Failure handling

Any exception inside the background pipeline is caught in
`main._run_job_safely`. The corresponding `Wig_AI_Filters` row is updated to
`Status = 'failed'` with a truncated error message, which the Specialist UI
surfaces as **"Please try again."** with a Retry button.
