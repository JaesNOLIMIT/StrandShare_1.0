# Wig Catalog Studio - Local AI

This service runs the Specialist Wig Catalog Studio AI on the workstation at
`127.0.0.1:8000`. It does not call a paid or hosted inference API.

## What runs locally

- **BiRefNet General through rembg** removes the wig background and preserves
  fine hair edges.
- **OpenAI CLIP ViT-B/32** suggests only high-confidence visible attributes and
  creates a 512-value visual fingerprint.
- The fingerprint plus the specialist's entered attributes finds similar
  inventory items.
- **MediaPipe Face Landmarker** runs in the browser for portrait try-on
  placement. The portrait is never uploaded.

The raw wig photograph is sent only from the browser to this local service.
The service deletes its temporary copy after processing. The transparent PNG
is staged in the `wig_ai_filters` bucket so the specialist can review it, and
it becomes the catalog image only after final confirmation.

## Machine profile

The implementation is tuned for the development laptop:

- NVIDIA GeForce RTX 3050 Laptop GPU, 4 GB VRAM
- Python 3.10
- CUDA-enabled PyTorch 2.4.1

CLIP uses the GPU. BiRefNet uses local ONNX inference and remains usable when
the ONNX GPU provider is unavailable.

## Windows setup

From the project root:

```powershell
npm run ai:setup
```

The setup script:

1. Creates `ai-server\.venv` if needed.
2. Installs the CUDA 11.8 PyTorch build and local image dependencies.
3. Downloads BiRefNet and CLIP model weights once.

Fill in `ai-server\.env`:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-server-only-secret-key
WIG_AI_FILTERS_BUCKET=wig_ai_filters
REMBG_MODEL=birefnet-general
CLIP_MODEL=openai/clip-vit-base-patch32
LOCAL_MODELS_ONLY=0
MAX_UPLOAD_MB=15
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,https://donivra.vercel.app
```

After the model files are cached, `LOCAL_MODELS_ONLY=1` prevents accidental
model downloads and makes offline model loading explicit.

## Install the on/off controls once

From the project root, run:

```powershell
npm run ai:install-controls
```

This creates:

- a tiny controller that starts automatically when this Windows user signs in;
- **Donivra AI On** and **Donivra AI Off** desktop shortcuts; and
- the controller endpoint at `127.0.0.1:8010` used by the Specialist page.

The controller starts the AI worker automatically at Windows sign-in. The model
may take a little time to warm up, but Wig Catalog Studio does not need a first
click to start it. **Turn AI Off** stops the worker; it stays off until you turn
it back on or restart the controller. This uses GPU and RAM while running. Set
`AI_ALWAYS_ON=0` in `ai-server/.env` to restore the optional idle shutdown
(`AI_IDLE_TIMEOUT_MINUTES`).

The deployed Vercel page calls these loopback endpoints through the browser.
Nothing is hosted in the cloud, and the AI is unavailable while this computer
is off. Allow Local Network Access if the browser prompts for it.

Useful commands:

```powershell
npm run ai:start
npm run ai:stop
npm run ai:status
npm run ai:controller:start
npm run ai:controller:stop
```

Verify:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/health
```

Expected response includes:

```json
{
  "status": "ok",
  "mode": "local-only",
  "background_model": "birefnet-general",
  "analysis_model": "openai/clip-vit-base-patch32"
}
```

`npm start` ensures the controller is available; the controller starts the
worker unless it was explicitly turned off during this controller session.

## API

### `POST /analyze-wig`

Multipart form fields:

- `wig_photo`: the raw photo (maximum 15 MB)
- `filter_id`: staging row ID
- `auth_user_id`: specialist `auth.uid()`
- `version`: filter version
- `inventory_json`: existing inventory images, fingerprints, and attributes
- `attributes_json`: current editable form values

The endpoint returns immediately and processes in the FastAPI background task.
The UI polls the corresponding `Wig_AI_Filters` row until it becomes
`pending_review` or `failed`.

### `GET /status/{filter_id}`

Returns processing state, transparent image paths, suggestions, and duplicate
matches.

### `GET /health`

Reports local service and configured model names.

## Quality rules

- AI suggestions never overwrite a specialist-entered value.
- Cap size is not inferred from a photograph because there is no reliable
  physical scale.
- Hair length is only an approximate visual suggestion and must be verified.
- Duplicate detection is a warning. A likely match requires explicit
  specialist confirmation but does not block a genuinely distinct item.
- Try-on is a fast landmark-based placement of the real transparent wig, not a
  diffusion-generated portrait. This fits 4 GB VRAM, preserves the user's face,
  and supports manual size, position, rotation, and opacity adjustment.

## Optional Docker run

Docker is not installed on the current workstation, so the PowerShell workflow
above is the primary path. The included Dockerfile and compose file remain
available for another CUDA-capable machine.
