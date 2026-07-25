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
SUPABASE_SERVICE_ROLE_KEY=your-server-only-key
WIG_AI_FILTERS_BUCKET=wig_ai_filters
REMBG_MODEL=birefnet-general
CLIP_MODEL=openai/clip-vit-base-patch32
LOCAL_MODELS_ONLY=0
MAX_UPLOAD_MB=15
ALLOWED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000,https://donivra.vercel.app
```

After the model files are cached, `LOCAL_MODELS_ONLY=1` prevents accidental
model downloads and makes offline model loading explicit.

## Run

The normal development command starts the web app, SMTP helper, and local AI:

```powershell
npm start
```

Run only the AI service:

```powershell
npm run ai:start
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

The deployed site checks this loopback service automatically. A web page
cannot launch a Windows process, so the AI service must already be running
(or be configured to start when the specialist signs in to Windows). If the
page reports that Local AI is offline, start it with `npm run ai:start`; the
page checks again automatically and also provides a **Check again** button.

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
