import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Camera,
  CameraOff,
  CheckCircle2,
  Eraser,
  ImagePlus,
  Layers,
  Loader2,
  Pencil,
  Power,
  RefreshCw,
  ScanLine,
  Sparkles,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { FilesetResolver, FaceLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';
import jsQR from 'jsqr';

import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import { logAuditAction } from '../../../lib/auditLogger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const WIGS_TABLE = 'Wigs';
const WIG_SPECS_TABLE = 'Wig_Specifications';
const FILTERS_TABLE = 'Wig_AI_Filters';
const SOURCES_BUCKET = 'wig_ai_sources';
const FILTERS_BUCKET = 'wig_ai_filters';
const AI_SERVER_BASE_URL =
  process.env.REACT_APP_AI_SERVER_URL || 'http://127.0.0.1:8000';

const TAB_CREATE = 'create';
const TAB_ACTIVE = 'active';

// Match the option sets used elsewhere in the specialist UI
// (UploadWigStocksPage / HairstyleMakingPage).
const TEXTURE_OPTIONS = ['Straight', 'Wavy', 'Curly', 'Coily'];
const COLOR_OPTIONS = ['Black', 'Dark Brown', 'Light Brown', 'Auburn', 'Blonde', 'Grey'];
const DENSITY_OPTIONS = ['Light', 'Medium', 'Heavy'];
const CAP_SIZE_OPTIONS = ['XS', 'S', 'M', 'L', 'XL'];

const VIEW_DEFS = [
  { key: 'front', label: 'Front', required: true },
  { key: 'side', label: 'Side', required: true },
  { key: 'top', label: 'Top', required: false },
  { key: 'back', label: 'Back', required: false },
];

const STATUS_LABEL = {
  processing: 'AI is generating the filter...',
  pending_review: 'Ready for review',
  approved: 'Approved',
  rejected: 'Rejected -- ready to retry',
  failed: 'Generation failed',
  superseded: 'Replaced by newer version',
};

// 2D layered output from the AI pipeline. Each layer is a PNG anchored to
// face landmarks at render time; per-layer offset/rotation/opacity/visibility
// are tunable by the specialist.
const LAYER_DEFS = [
  { key: 'back_hair',   label: 'Back Hair',   z: 1, anchor: 'head_top',    anchorAttachment: 'top',    defaultVisible: true,  baseScale: 1.75 },
  { key: 'face_mask',   label: 'Face Mask',   z: 2, anchor: 'face_center', anchorAttachment: 'center', defaultVisible: false, baseScale: 1.0  },
  { key: 'full_wig',    label: 'Full Wig',    z: 5, anchor: 'head_top',    anchorAttachment: 'top',    defaultVisible: true,  baseScale: 1.70 },
  { key: 'front_bangs', label: 'Front Bangs', z: 7, anchor: 'forehead',    anchorAttachment: 'top',    defaultVisible: true,  baseScale: 1.45 },
  { key: 'hair_mask',   label: 'Hair Mask',   z: 9, anchor: 'head_top',    anchorAttachment: 'top',    defaultVisible: false, baseScale: 1.70 },
];
const LAYER_KEYS = LAYER_DEFS.map((l) => l.key);
const NON_VISUAL_LAYER_KEYS = new Set(['hair_mask', 'face_mask']);
const USER_EDITABLE_LAYER_KEYS = ['full_wig', 'back_hair', 'front_bangs'];

const DEFAULT_LAYER_FIT = Object.freeze({
  offsetX: 0,
  offsetY: 0,
  scale: 1.0,
  rotation: 0,
  opacity: 1.0,
  visible: true,
});

const DEFAULT_LAYER_FITS = Object.freeze(
  LAYER_DEFS.reduce((acc, l) => {
    acc[l.key] = { ...DEFAULT_LAYER_FIT, visible: l.defaultVisible };
    return acc;
  }, {}),
);

const MIN_LAYER_SCALE = 0.3;
const MAX_LAYER_SCALE = 3.0;

function lockLayerFitScale(fitMap) {
  // The wig auto-scales to face width via baseScale; `scale` is a manual
  // multiplier on top of that, clamped to a sane range. Defaults to 1.0.
  const out = {};
  for (const key of LAYER_KEYS) {
    const incoming = (fitMap && typeof fitMap === 'object' && fitMap[key]) || {};
    const def = LAYER_DEFS.find((l) => l.key === key);
    const rawScale = Number.isFinite(incoming.scale) ? incoming.scale : 1.0;
    out[key] = {
      ...DEFAULT_LAYER_FIT,
      visible: def?.defaultVisible ?? true,
      ...incoming,
      scale: Math.max(MIN_LAYER_SCALE, Math.min(MAX_LAYER_SCALE, rawScale)),
    };
  }
  return out;
}

function mergeLayerFits(stored) {
  return lockLayerFitScale(stored);
}

const POLL_INTERVAL_MS = 2500;
const MEDIAPIPE_WASM =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm';
const FACE_LANDMARKER_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const SELFIE_SEGMENTER_MODEL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite';

// MediaPipe FaceMesh face-oval perimeter, in order.
const FACE_OVAL_INDICES = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365,
  379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93,
  234, 127, 162, 21, 54, 103, 67, 109,
];

const LAYER_PATH_COLUMNS = {
  full_wig:    'Layer_Full_Wig_Path',
  back_hair:   'Layer_Back_Hair_Path',
  front_bangs: 'Layer_Front_Bangs_Path',
  hair_mask:   'Layer_Hair_Mask_Path',
  face_mask:   'Layer_Face_Mask_Path',
};

function createInitialStockModalState() {
  return {
    open: false,
    wig: null,
    qty: '1',
    reason: 'Stock replenishment',
    saving: false,
    error: '',
  };
}

function createBundleScannerModalState() {
  return {
    open: false,
    manualCode: '',
    saving: false,
    error: '',
    success: '',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function withColorAlpha(colorValue, alpha, fallback = '#7f1d1d') {
  const safeAlpha = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
  const input = String(colorValue || '').trim();
  const hexMatch = input.match(/^#([0-9a-f]{6})$/i);
  if (!hexMatch) {
    if (fallback === colorValue) return `rgba(127, 29, 29, ${safeAlpha})`;
    return withColorAlpha(fallback, safeAlpha, fallback);
  }
  const [hex] = hexMatch.slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
}

function fileExtension(file) {
  const fromName = (file?.name || '').split('.').pop();
  if (fromName && fromName.length <= 5) return fromName.toLowerCase();
  if (file?.type === 'image/png') return 'png';
  if (file?.type === 'image/webp') return 'webp';
  return 'jpg';
}

function buildSourcePath(authUserId, draftKey, viewKey, ext) {
  // Matches the RLS path convention in 089_wig_ai_filter_storage.sql.
  return `${authUserId}/wig-ai-sources/${draftKey}/${viewKey}.${ext}`;
}

function publicFilterUrl(path) {
  if (!path || !supabase) return null;
  const { data } = supabase.storage.from(FILTERS_BUCKET).getPublicUrl(path);
  return data?.publicUrl || null;
}

function buildLayerUrls(filter) {
  if (!filter) return {};
  return Object.entries(LAYER_PATH_COLUMNS).reduce((acc, [layerKey, column]) => {
    acc[layerKey] = publicFilterUrl(filter[column]);
    return acc;
  }, {});
}

function getManilaSqlTimestamp(dateValue = new Date()) {
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (Number.isNaN(date.getTime())) {
    return getManilaSqlTimestamp(new Date());
  }
  const utcMs = date.getTime() + (date.getTimezoneOffset() * 60 * 1000);
  const manilaShiftedDate = new Date(utcMs + (8 * 60 * 60 * 1000));
  return manilaShiftedDate.toISOString().slice(0, 19).replace('T', ' ');
}

function describeDbError(err, fallback = 'Operation failed.') {
  if (!err) return fallback;
  const parts = [];
  if (err.message) parts.push(String(err.message));
  if (err.details) parts.push(String(err.details));
  if (err.hint) parts.push(`Hint: ${String(err.hint)}`);
  if (err.code) parts.push(`Code: ${String(err.code)}`);
  return parts.length ? parts.join(' | ') : fallback;
}

function hasGeneratedLayers(filter) {
  if (!filter) return false;
  return Object.values(LAYER_PATH_COLUMNS).some((col) => filter[col]);
}

function shortDraftKey() {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// MediaPipe + camera hook
// ---------------------------------------------------------------------------
function useFaceTracking(videoRef, enabled) {
  const landmarkerRef = useRef(null);
  const segmenterRef = useRef(null);
  const rafRef = useRef(null);
  const landmarksRef = useRef(null);
  // Offscreen canvas holding the latest person silhouette as an alpha mask
  // (white where person, transparent where background). Used to keep back
  // hair behind the real person along their exact outline.
  const personMaskRef = useRef(null);
  const personMaskReadyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let stream = null;
    let lastSegTs = -1;
    let mountedVideo = null;

    // Reusable mask canvas + scratch ImageData.
    const maskCanvas = document.createElement('canvas');
    const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
    let maskImageData = null;
    personMaskRef.current = maskCanvas;

    async function start() {
      if (!enabled || !videoRef.current) return;
      setError('');
      setReady(false);
      personMaskReadyRef.current = false;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) return;
        mountedVideo = videoRef.current;
        if (!mountedVideo) return;
        mountedVideo.srcObject = stream;
        await mountedVideo.play();

        const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
        if (cancelled) return;
        const landmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: FACE_LANDMARKER_MODEL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        });
        if (cancelled) { landmarker.close(); return; }
        landmarkerRef.current = landmarker;

        // Person segmentation (selfie). Best-effort: if it fails to load we
        // fall back to face-oval-only occlusion in the renderer.
        try {
          const segmenter = await ImageSegmenter.createFromOptions(vision, {
            baseOptions: { modelAssetPath: SELFIE_SEGMENTER_MODEL, delegate: 'GPU' },
            runningMode: 'VIDEO',
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          });
          if (cancelled) { segmenter.close(); return; }
          segmenterRef.current = segmenter;
        } catch (segErr) {
          // eslint-disable-next-line no-console
          console.warn('Selfie segmenter unavailable; using face-oval occlusion only.', segErr);
        }

        setReady(true);

        const handleSegmentation = (result) => {
          const masks = result?.confidenceMasks;
          const mask = masks && masks[0];
          if (!mask) return;
          const mw = mask.width;
          const mh = mask.height;
          const floatArr = mask.getAsFloat32Array();
          if (maskCanvas.width !== mw) maskCanvas.width = mw;
          if (maskCanvas.height !== mh) maskCanvas.height = mh;
          if (!maskImageData || maskImageData.width !== mw || maskImageData.height !== mh) {
            maskImageData = maskCtx.createImageData(mw, mh);
            // RGB stays white; only alpha varies.
            for (let i = 0; i < floatArr.length; i += 1) {
              maskImageData.data[i * 4] = 255;
              maskImageData.data[i * 4 + 1] = 255;
              maskImageData.data[i * 4 + 2] = 255;
            }
          }
          const data = maskImageData.data;
          for (let i = 0; i < floatArr.length; i += 1) {
            // Slightly sharpen the boundary so the silhouette edge is crisp.
            const c = floatArr[i];
            data[i * 4 + 3] = c <= 0 ? 0 : c >= 1 ? 255 : Math.round(c * 255);
          }
          maskCtx.putImageData(maskImageData, 0, 0);
          personMaskReadyRef.current = true;
        };

        const tick = () => {
          if (cancelled) return;
          const video = videoRef.current;
          const lm = landmarkerRef.current;
          const seg = segmenterRef.current;
          if (video && video.readyState >= 2 && !video.paused) {
            const ts = performance.now();
            if (lm) {
              try {
                const result = lm.detectForVideo(video, ts);
                landmarksRef.current = result?.faceLandmarks?.[0] || null;
              } catch {
                landmarksRef.current = null;
              }
            }
            if (seg && ts !== lastSegTs) {
              lastSegTs = ts;
              try {
                seg.segmentForVideo(video, ts, handleSegmentation);
              } catch {
                /* keep last mask */
              }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
      } catch (err) {
        setError(err?.message || 'Could not access camera.');
      }
    }

    start();
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (landmarkerRef.current) {
        try { landmarkerRef.current.close(); } catch { /* ignore */ }
        landmarkerRef.current = null;
      }
      if (segmenterRef.current) {
        try { segmenterRef.current.close(); } catch { /* ignore */ }
        segmenterRef.current = null;
      }
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (mountedVideo) mountedVideo.srcObject = null;
      setReady(false);
      landmarksRef.current = null;
      personMaskReadyRef.current = false;
    };
  }, [enabled, videoRef]);

  return { ready, error, landmarksRef, personMaskRef, personMaskReadyRef };
}

// ---------------------------------------------------------------------------
// Layer image pre-loading
// ---------------------------------------------------------------------------
function useLayerImages(urlByLayer) {
  const imagesRef = useRef({});
  const prevUrlsRef = useRef({});
  useEffect(() => {
    const prev = prevUrlsRef.current;
    const next = { ...imagesRef.current };
    // Drop layers whose URL disappeared.
    Object.keys(next).forEach((k) => {
      if (!urlByLayer?.[k]) delete next[k];
    });
    // Only (re)load layers whose URL actually changed -- avoids reloading
    // every layer image (and the resulting flicker) each time a single layer
    // is edited in the eraser.
    Object.entries(urlByLayer || {}).forEach(([key, url]) => {
      if (!url) return;
      if (prev[key] === url && next[key]) return;
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.src = url;
      next[key] = img;
    });
    imagesRef.current = next;
    prevUrlsRef.current = { ...(urlByLayer || {}) };
  }, [urlByLayer]);
  return imagesRef;
}

// ---------------------------------------------------------------------------
// Canvas rendering
// ---------------------------------------------------------------------------
function computeAnchor(layer, landmarks, w, h) {
  const lm10  = landmarks[10];
  const lm152 = landmarks[152];
  const lm234 = landmarks[234];
  const lm454 = landmarks[454];
  const lm127 = landmarks[127];
  const lm356 = landmarks[356];
  const lm1   = landmarks[1];
  if (!lm10 || !lm152 || !lm234 || !lm454) return null;

  const faceCenterX = ((lm234.x + lm454.x) / 2) * w;
  const faceTopY    = lm10.y * h;
  const faceBotY    = lm152.y * h;
  const faceWidthRaw = Math.abs(lm454.x - lm234.x) * w;
  const headWidthRaw = (lm127 && lm356) ? Math.abs(lm356.x - lm127.x) * w : faceWidthRaw;
  const trackedWidth = Math.max(faceWidthRaw, headWidthRaw * 0.96);
  const faceHeight   = Math.abs(faceBotY - faceTopY);
  const angle = Math.atan2(lm454.y - lm234.y, lm454.x - lm234.x);

  // Yaw approximation from how far the nose is shifted within the face.
  const halfFaceNorm = Math.max(0.001, Math.abs(lm454.x - lm234.x) / 2);
  const yawNormRaw = lm1 ? ((lm1.x - ((lm234.x + lm454.x) / 2)) / halfFaceNorm) : 0;
  const yawNorm = Math.max(-1, Math.min(1, yawNormRaw));
  // Compensate the apparent narrowing of the face when turned so the wig
  // doesn't shrink, and slide the wig toward the turn direction so it tracks
  // the head rotation instead of staying centred (stronger than before).
  const widthComp = 1 + (Math.abs(yawNorm) * 0.34);
  const shiftedCenterX = faceCenterX + (yawNorm * trackedWidth * 0.18);

  let x = shiftedCenterX;
  let y = (faceTopY + faceBotY) / 2;
  if (layer.anchor === 'head_top') {
    y = faceTopY - faceHeight * 0.24;
  } else if (layer.anchor === 'forehead') {
    // Bangs sit further forward on the head, so they slide a bit more.
    x = shiftedCenterX + (yawNorm * trackedWidth * 0.10);
    y = faceTopY - faceHeight * 0.09;
  } else if (layer.anchor === 'face_center') {
    if (lm1) { x = lm1.x * w; y = lm1.y * h; }
  }
  return {
    x,
    y,
    faceWidth: trackedWidth * widthComp,
    faceHeight,
    angle,
    yawNorm,
  };
}

function drawSingleLayer(ctx, layer, fit, img, landmarks, vw, vh, mirror) {
  if (NON_VISUAL_LAYER_KEYS.has(layer.key) && !fit.visible) return;
  const anchor = computeAnchor(layer, landmarks, vw, vh);
  if (!anchor) return;
  const drawX = mirror ? (vw - anchor.x) : anchor.x;
  const drawY = anchor.y;
  const baseSize = anchor.faceWidth * layer.baseScale;
  const drawW = baseSize * fit.scale;
  const drawH = drawW * (img.naturalHeight / img.naturalWidth);
  const rotation = (mirror ? -anchor.angle : anchor.angle) + fit.rotation;

  let imgOffsetY = -drawH / 2;
  if (layer.anchorAttachment === 'top') imgOffsetY = 0;
  else if (layer.anchorAttachment === 'bottom') imgOffsetY = -drawH;

  const yawAbs = Math.abs(anchor.yawNorm);
  const yawDir = anchor.yawNorm < 0 ? -1 : 1;
  // Skew direction in canvas space. Flipped so the wig leans into the turn the
  // same way the head does (was leaning the opposite way before).
  const skewDir = (mirror ? 1 : -1) * yawDir;

  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, fit.opacity));
  ctx.translate(drawX + fit.offsetX, drawY + fit.offsetY);
  ctx.rotate(rotation);

  // Per-layer perspective fake when the head turns: horizontal foreshortening
  // (squash) + a slight vertical shear in the turn direction so the wig reads
  // as rotating with the head rather than staying flat-on.
  if (layer.key === 'full_wig') {
    const squashX = Math.max(0.58, 1 - (yawAbs * 0.42));
    ctx.transform(squashX, skewDir * yawAbs * 0.10, 0, 1 + (yawAbs * 0.07), 0, 0);
  } else if (layer.key === 'front_bangs') {
    const squashX = Math.max(0.62, 1 - (yawAbs * 0.38));
    ctx.transform(squashX, skewDir * yawAbs * 0.12, 0, 1, 0, 0);
  } else if (layer.key === 'back_hair') {
    // Back hair widens slightly and leans the opposite way (it wraps around).
    ctx.transform(1 + (yawAbs * 0.08), -skewDir * yawAbs * 0.06, 0, 1 + (yawAbs * 0.03), 0, 0);
  }

  ctx.drawImage(img, -drawW / 2, imgOffsetY, drawW, drawH);
  ctx.restore();
}

// Fallback occlusion (used only before the first segmentation mask arrives or
// if the segmenter failed to load): redraw the user's face region over the
// back hair using the face oval. No hard torso rectangle.
function reDrawFaceOvalOcclusion(ctx, video, landmarks, vw, vh, mirror) {
  if (!landmarks) return;
  ctx.save();
  ctx.beginPath();
  let started = false;
  for (const idx of FACE_OVAL_INDICES) {
    const lm = landmarks[idx];
    if (!lm) continue;
    const x = mirror ? (vw - lm.x * vw) : lm.x * vw;
    const y = lm.y * vh;
    if (!started) { ctx.moveTo(x, y); started = true; }
    else { ctx.lineTo(x, y); }
  }
  if (started) {
    ctx.closePath();
    ctx.clip();
    if (mirror) { ctx.translate(vw, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, vw, vh);
  }
  ctx.restore();
}

// Person-silhouette occlusion: redraw the user (video) over the back hair,
// masked to their exact body outline from MediaPipe selfie segmentation. This
// is what keeps back hair behind the whole person -- head, neck, shoulders,
// torso -- with soft, accurate edges instead of a hard polygon.
function compositePersonOcclusion(ctx, personCanvas, video, maskCanvas, vw, vh, mirror) {
  if (!maskCanvas || !maskCanvas.width) return false;
  if (personCanvas.width !== vw) personCanvas.width = vw;
  if (personCanvas.height !== vh) personCanvas.height = vh;
  const pctx = personCanvas.getContext('2d');
  if (!pctx) return false;

  pctx.setTransform(1, 0, 0, 1, 0, 0);
  pctx.globalCompositeOperation = 'source-over';
  pctx.clearRect(0, 0, vw, vh);

  // Mirrored video into the scratch canvas.
  pctx.save();
  if (mirror) { pctx.translate(vw, 0); pctx.scale(-1, 1); }
  pctx.drawImage(video, 0, 0, vw, vh);
  pctx.restore();

  // Keep only the person pixels (mask drawn with the same mirror transform so
  // it lines up with the mirrored video).
  pctx.globalCompositeOperation = 'destination-in';
  pctx.save();
  if (mirror) { pctx.translate(vw, 0); pctx.scale(-1, 1); }
  pctx.imageSmoothingEnabled = true;
  pctx.drawImage(maskCanvas, 0, 0, vw, vh);
  pctx.restore();
  pctx.globalCompositeOperation = 'source-over';

  // Stamp the masked person onto the main canvas, over the back hair.
  ctx.drawImage(personCanvas, 0, 0);
  return true;
}

// Exponential-moving-average smoothing for the face landmarks. MediaPipe
// landmarks jitter a few pixels frame-to-frame; smoothing makes the wig glide
// with the head instead of vibrating. Higher alpha = snappier but jitterier.
const LANDMARK_SMOOTHING_ALPHA = 0.45;

function smoothLandmarks(prev, raw) {
  if (!raw) return prev;
  if (!prev || prev.length !== raw.length) {
    return raw.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 }));
  }
  const a = LANDMARK_SMOOTHING_ALPHA;
  for (let i = 0; i < raw.length; i += 1) {
    prev[i].x += (raw[i].x - prev[i].x) * a;
    prev[i].y += (raw[i].y - prev[i].y) * a;
    prev[i].z += ((raw[i].z ?? 0) - prev[i].z) * a;
  }
  return prev;
}

function LayeredCanvas({ videoRef, landmarksRef, personMaskRef, personMaskReadyRef, layerUrls, fitByLayer, mirror = true }) {
  const canvasRef = useRef(null);
  const personCanvasRef = useRef(null);
  if (!personCanvasRef.current && typeof document !== 'undefined') {
    personCanvasRef.current = document.createElement('canvas');
  }
  const imagesRef = useLayerImages(layerUrls);
  // Use a ref for fit values so slider drags don't restart the rAF loop.
  const fitRef = useRef(fitByLayer);
  useEffect(() => { fitRef.current = fitByLayer; }, [fitByLayer]);

  useEffect(() => {
    let raf = 0;
    let smoothed = null;
    const sortedLayers = [...LAYER_DEFS].sort((a, b) => a.z - b.z);

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) return;
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh || video.readyState < 2) return;

      if (canvas.width !== vw)  canvas.width = vw;
      if (canvas.height !== vh) canvas.height = vh;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const fits = fitRef.current;

      // 1. Mirrored video.
      ctx.save();
      if (mirror) { ctx.translate(vw, 0); ctx.scale(-1, 1); }
      ctx.drawImage(video, 0, 0, vw, vh);
      ctx.restore();

      const rawLandmarks = landmarksRef.current;
      if (!rawLandmarks) { smoothed = null; return; }
      smoothed = smoothLandmarks(smoothed, rawLandmarks);
      const landmarks = smoothed;

      // 2. Back hair (drawn first so it sits behind everything else).
      const backLayer = sortedLayers.find((l) => l.key === 'back_hair');
      const backFit = fits?.back_hair;
      const backImg = imagesRef.current.back_hair;
      if (backLayer && backFit?.visible && backImg && backImg.complete && backImg.naturalWidth) {
        drawSingleLayer(ctx, backLayer, backFit, backImg, landmarks, vw, vh, mirror);
      }

      // 3. Occlude back hair behind the real person. Prefer the segmentation
      //    silhouette; fall back to the face oval until the first mask lands.
      const maskReady = personMaskReadyRef?.current && personMaskRef?.current;
      let occluded = false;
      if (maskReady) {
        occluded = compositePersonOcclusion(
          ctx, personCanvasRef.current, video, personMaskRef.current, vw, vh, mirror,
        );
      }
      if (!occluded) {
        reDrawFaceOvalOcclusion(ctx, video, landmarks, vw, vh, mirror);
      }

      // 4. Remaining layers in z-order.
      for (const layer of sortedLayers) {
        if (layer.key === 'back_hair') continue;
        const fit = fits?.[layer.key];
        if (!fit || !fit.visible) continue;
        const img = imagesRef.current[layer.key];
        if (!img || !img.complete || !img.naturalWidth) continue;
        drawSingleLayer(ctx, layer, fit, img, landmarks, vw, vh, mirror);
      }
    };

    draw();
    return () => cancelAnimationFrame(raf);
  }, [videoRef, landmarksRef, personMaskRef, personMaskReadyRef, layerUrls, mirror, imagesRef]);

  return <canvas ref={canvasRef} className="h-full w-full object-contain" />;
}

// ---------------------------------------------------------------------------
// Source upload tile
// ---------------------------------------------------------------------------
function SourceUploader({ view, file, onChange, primaryColor }) {
  const inputRef = useRef(null);
  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  return (
    <div
      className="rounded-xl border-2 border-dashed p-3 transition"
      style={{
        borderColor: file ? withColorAlpha(primaryColor, 0.6) : withColorAlpha(primaryColor, 0.2),
        background: file ? withColorAlpha(primaryColor, 0.04) : 'transparent',
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">
          {view.label}
          {view.required ? <span className="ml-1 text-red-500">*</span> : null}
        </p>
        {file && (
          <button
            type="button"
            className="text-xs text-red-500 hover:underline"
            onClick={() => onChange(null)}
          >
            Remove
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => onChange(e.target.files?.[0] || null)}
      />
      {file ? (
        <img
          src={previewUrl}
          alt={`${view.label} preview`}
          className="mt-2 h-32 w-full rounded-md object-cover"
        />
      ) : (
        <button
          type="button"
          className="mt-2 flex h-32 w-full flex-col items-center justify-center gap-1 rounded-md text-xs text-slate-500 hover:bg-slate-100"
          onClick={() => inputRef.current?.click()}
        >
          <ImagePlus size={20} />
          <span>Click to upload</span>
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fit slider
// ---------------------------------------------------------------------------
function FitSlider({ label, value, min, max, step, onChange }) {
  return (
    <label className="block">
      <div className="flex items-center justify-between text-xs font-medium">
        <span>{label}</span>
        <span className="tabular-nums text-slate-500">{Number(value).toFixed(2)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mt-1 w-full"
      />
    </label>
  );
}

// ---------------------------------------------------------------------------
// Layer fit panel (accordion)
// ---------------------------------------------------------------------------
function LayerFitPanel({ layer, fit, onChange, expanded, onToggleExpanded }) {
  const update = (patch) => onChange({ ...fit, ...patch });
  return (
    <div className="rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold"
        onClick={onToggleExpanded}
      >
        <span className="inline-flex items-center gap-2">
          <Layers size={12} /> {layer.label}
          {!fit.visible && <span className="rounded-full bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-600">hidden</span>}
        </span>
        <span className="text-slate-400">{expanded ? 'âˆ’' : '+'}</span>
      </button>
      {expanded ? (
        <div className="space-y-2 border-t px-3 py-2">
          <label className="flex items-center justify-between text-xs">
            <span>Visible</span>
            <input
              type="checkbox"
              checked={Boolean(fit.visible)}
              onChange={(e) => update({ visible: e.target.checked })}
            />
          </label>
          <FitSlider label="Offset X (px)" min={-400} max={400} step={1} value={fit.offsetX} onChange={(v) => update({ offsetX: v })} />
          <FitSlider label="Offset Y (px)" min={-400} max={400} step={1} value={fit.offsetY} onChange={(v) => update({ offsetY: v })} />
          <FitSlider label="Rotation"     min={-Math.PI} max={Math.PI} step={0.02} value={fit.rotation} onChange={(v) => update({ rotation: v })} />
          <FitSlider label="Opacity"      min={0}   max={1}    step={0.01} value={fit.opacity}  onChange={(v) => update({ opacity: v })} />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layer eraser (manual touch-up of generated layer)
// ---------------------------------------------------------------------------
function LayerEraseEditor({ layerKey, baseUrl, stagedUrl, brushSize, setBrushSize, onEditedDataUrl }) {
  const canvasRef = useRef(null);
  const wrapperRef = useRef(null);
  const drawingRef = useRef(false);
  const lastPosRef = useRef(null);
  const lastCommitRef = useRef(0);
  // Latest staged edit, read via ref so our own commits don't retrigger the
  // load effect (which would wipe the strokes the user just made).
  const stagedUrlRef = useRef(stagedUrl);
  const [loadError, setLoadError] = useState('');
  useEffect(() => { stagedUrlRef.current = stagedUrl; }, [stagedUrl]);

  const loadFromUrl = useCallback((url, markClean) => {
    const canvas = canvasRef.current;
    if (!canvas || !url) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      canvas.width = img.naturalWidth || 1024;
      canvas.height = img.naturalHeight || 1024;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      if (markClean) onEditedDataUrl?.(layerKey, null, false);
    };
    img.onerror = () => setLoadError('Could not load layer image.');
    img.src = url;
  }, [layerKey, onEditedDataUrl]);

  // Reload only when the layer or its underlying AI image changes -- NOT on
  // every erase commit. Resumes a prior staged edit if there is one.
  useEffect(() => {
    setLoadError('');
    loadFromUrl(stagedUrlRef.current || baseUrl, false);
  }, [layerKey, baseUrl, loadFromUrl]);

  const eventToCanvas = (event) => {
    const canvas = canvasRef.current;
    const wrap = wrapperRef.current;
    if (!canvas || !wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const t = event.touches?.[0];
    const cx = (t ? t.clientX : event.clientX) - rect.left;
    const cy = (t ? t.clientY : event.clientY) - rect.top;
    const sx = canvas.width / rect.width;
    const sy = canvas.height / rect.height;
    return { x: cx * sx, y: cy * sy, sx };
  };

  const eraseAt = (pos) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx || !pos) return;
    const last = lastPosRef.current || pos;
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1, brushSize * pos.sx);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    ctx.restore();
    lastPosRef.current = pos;
  };

  const commit = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const dataUrl = canvas.toDataURL('image/png');
      onEditedDataUrl?.(layerKey, dataUrl, true);
    } catch (err) {
      setLoadError(err?.message || 'Could not export edited layer.');
    }
  };

  // Throttle the toDataURL + live-preview propagation so dragging stays
  // smooth (toDataURL on a 1024px canvas every move event would stutter).
  const maybeLiveCommit = () => {
    const now = performance.now();
    if (now - lastCommitRef.current >= 120) {
      lastCommitRef.current = now;
      commit();
    }
  };

  const onPointerDown = (e) => {
    e.preventDefault();
    drawingRef.current = true;
    lastPosRef.current = eventToCanvas(e);
    eraseAt(lastPosRef.current);
  };
  const onPointerMove = (e) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    eraseAt(eventToCanvas(e));
    maybeLiveCommit();
  };
  const onPointerUp = () => {
    if (drawingRef.current) {
      drawingRef.current = false;
      lastPosRef.current = null;
      commit(); // final, authoritative commit
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="inline-flex items-center gap-1 font-semibold">
          <Eraser size={12} /> Layer Eraser
        </span>
        <div className="flex items-center gap-2">
          <span>Brush</span>
          <input
            type="range"
            min={4}
            max={120}
            step={1}
            value={brushSize}
            onChange={(e) => setBrushSize(parseInt(e.target.value, 10))}
          />
          <span className="tabular-nums w-10 text-right">{brushSize}px</span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded border px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
          onClick={() => loadFromUrl(baseUrl, true)}
        >
          Restore layer
        </button>
      </div>
      {loadError ? (
        <p className="mt-2 text-xs text-red-600">{loadError}</p>
      ) : null}
      <div
        ref={wrapperRef}
        className="mt-2 max-h-[60vh] overflow-auto rounded-md border bg-slate-50"
        onMouseDown={onPointerDown}
        onMouseMove={onPointerMove}
        onMouseUp={onPointerUp}
        onMouseLeave={onPointerUp}
        onTouchStart={onPointerDown}
        onTouchMove={onPointerMove}
        onTouchEnd={onPointerUp}
        style={{ touchAction: 'none', cursor: 'crosshair' }}
      >
        <canvas ref={canvasRef} className="block h-auto w-full max-w-full" />
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Drag on the layer to erase unwanted parts. Changes are staged in this
        editor first.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active Filters tab
// ---------------------------------------------------------------------------
function ActiveFiltersTab({
  filters,
  wigsById,
  onToggleActive,
  onDelete,
  onEdit,
  onAddStock,
  onOpenBundleScanner,
  loading,
  refresh,
  primaryColor,
}) {
  const grouped = useMemo(() => {
    const map = new Map();
    filters.forEach((f) => {
      const groupKey = f.Wig_ID === null || f.Wig_ID === undefined
        ? `draft-${f.Filter_ID}`
        : `wig-${f.Wig_ID}`;
      const current = map.get(groupKey);
      if (current) current.list.push(f);
      else map.set(groupKey, { groupKey, wigId: f.Wig_ID ?? null, list: [f] });
    });
    return Array.from(map.values()).map(({ groupKey, wigId, list }) => ({
      groupKey,
      wigId,
      wig: wigId ? wigsById.get(wigId) : null,
      list: list.sort((a, b) => b.Version - a.Version),
    }));
  }, [filters, wigsById]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-slate-500">
        <Loader2 className="mr-2 animate-spin" size={16} /> Loading filters...
      </div>
    );
  }

  if (grouped.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center text-sm text-slate-500">
        <Layers className="mx-auto mb-2" size={24} />
        No filters yet. Generate one from the <strong>Create</strong> tab.
        <div className="mt-3">
          <button type="button" className="text-xs font-semibold underline" style={{ color: '#0f172a' }} onClick={refresh}>Refresh</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          Toggle one version per wig to make it visible to the mobile app.
          Filters must be deactivated before their fit can be edited.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-semibold hover:bg-slate-50"
            style={{ borderColor: '#0f172a', color: '#0f172a' }}
            onClick={onOpenBundleScanner}
            title="Scan bundle waybill to complete wig stock"
          >
            <ScanLine size={13} /> Scan Bundle
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs font-semibold"
            style={{ color: '#0f172a' }}
            onClick={refresh}
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      </div>

      {grouped.map(({ groupKey, wigId, wig, list }) => (
        <div key={groupKey} className="rounded-2xl border bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold">
                {wig?.Wig_Code || wig?.Wig_Name || list[0]?.Pending_Wig_Name || (wigId ? `Wig #${wigId}` : 'Unapproved Draft')}
              </p>
              <p className="text-xs text-slate-500">
                {list.length} version(s)
                {wigId ? ` - Stock ${Number(wig?.Stock_Count || 0)}` : ''}
              </p>
            </div>
            {wigId ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold hover:bg-slate-50"
                style={{ borderColor: '#0f172a', color: '#0f172a' }}
                onClick={() => onAddStock?.(wig)}
                title="Increase stock count for this wig"
              >
                + Stock
              </button>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.map((f) => {
              const thumb = publicFilterUrl(f.Thumbnail_Path);
              return (
                <div
                  key={f.Filter_ID}
                  className="flex gap-3 rounded-lg border p-3"
                  style={{
                    borderColor: f.Is_Active ? withColorAlpha(primaryColor, 0.6) : '#e5e7eb',
                    background: f.Is_Active ? withColorAlpha(primaryColor, 0.04) : 'transparent',
                  }}
                >
                  <div className="h-16 w-16 flex-shrink-0 overflow-hidden rounded-md bg-slate-100">
                    {thumb ? (
                      <img src={thumb} alt="thumb" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-slate-400">
                        <Sparkles size={18} />
                      </div>
                    )}
                  </div>
                  <div className="flex-1">
                    <p className="text-xs font-semibold">v{f.Version}</p>
                    <p className="text-xs text-slate-500">{STATUS_LABEL[f.Status] || f.Status}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {(f.Wig_ID && (
                        f.Status === 'approved'
                        || f.Status === 'superseded'
                        || f.Status === 'pending_review'
                        || f.Is_Active
                      )) ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-white"
                          style={{ background: f.Is_Active ? '#dc2626' : '#0f172a' }}
                          onClick={() => onToggleActive(f)}
                        >
                          <Power size={12} /> {f.Is_Active ? 'Deactivate' : 'Set Active'}
                        </button>
                      ) : null}
                      {hasGeneratedLayers(f) && !f.Is_Active ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-semibold hover:bg-slate-50"
                          style={{ borderColor: '#0f172a', color: '#0f172a' }}
                          onClick={() => onEdit?.(f)}
                          title="Adjust fit -- only available while filter is inactive"
                        >
                          <Pencil size={12} /> Edit fit
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-slate-500 hover:bg-slate-50"
                        onClick={() => onDelete(f)}
                      >
                        <Trash2 size={12} /> Delete
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Try-on editor (used by Create and Edit modes)
// ---------------------------------------------------------------------------
function TryOnEditor({
  filter,
  layerUrls,
  fit,
  setFit,
  primaryColor,
  saving,
  mode = 'create',
  onApprove,
  onRedo,
  onSave,
  onCancel,
}) {
  const videoRef = useRef(null);
  const [cameraOn, setCameraOn] = useState(true);
  const [expandedLayer, setExpandedLayer] = useState('full_wig');
  const [editLayerKey, setEditLayerKey] = useState(USER_EDITABLE_LAYER_KEYS[0]);
  const [eraserBrushSize, setEraserBrushSize] = useState(26);
  const [editedLayerDataUrls, setEditedLayerDataUrls] = useState({});
  const { ready, error, landmarksRef, personMaskRef, personMaskReadyRef } = useFaceTracking(videoRef, cameraOn);

  const effectiveLayerUrls = useMemo(() => {
    const merged = { ...(layerUrls || {}) };
    Object.entries(editedLayerDataUrls).forEach(([k, v]) => {
      if (typeof v === 'string' && v.startsWith('data:')) merged[k] = v;
    });
    return merged;
  }, [layerUrls, editedLayerDataUrls]);

  const updateLayerFit = useCallback((layerKey, newFit) => {
    setFit(lockLayerFitScale({ ...fit, [layerKey]: newFit }));
  }, [fit, setFit]);

  // Overall scale = a single multiplier applied uniformly to every layer.
  const overallScale = fit?.full_wig?.scale ?? 1.0;
  const setOverallScale = useCallback((value) => {
    const next = {};
    for (const key of LAYER_KEYS) {
      next[key] = { ...(fit[key] || DEFAULT_LAYER_FIT), scale: value };
    }
    setFit(lockLayerFitScale(next));
  }, [fit, setFit]);

  const handleEditedLayerDataUrl = useCallback((layerKey, dataUrl, isDirty = true) => {
    setEditedLayerDataUrls((prev) => {
      const next = { ...prev };
      if (!isDirty) { delete next[layerKey]; return next; }
      next[layerKey] = dataUrl;
      return next;
    });
  }, []);

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[2fr_1fr]">
      <div className="relative overflow-hidden rounded-xl bg-black" style={{ minHeight: 360 }}>
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full opacity-0"
          playsInline
          muted
        />
        <LayeredCanvas
          videoRef={videoRef}
          landmarksRef={landmarksRef}
          personMaskRef={personMaskRef}
          personMaskReadyRef={personMaskReadyRef}
          layerUrls={effectiveLayerUrls}
          fitByLayer={fit}
          mirror
        />

        <div className="absolute top-2 left-2 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white">
          {ready ? <><Camera size={12} /> Tracking</>
            : error ? <><CameraOff size={12} /> {error}</>
            : <><Loader2 size={12} className="animate-spin" /> Starting camera...</>}
        </div>
        <button
          type="button"
          className="absolute top-2 right-2 rounded-full bg-black/50 p-2 text-white"
          onClick={() => setCameraOn((v) => !v)}
          title={cameraOn ? 'Pause camera' : 'Resume camera'}
        >
          {cameraOn ? <CameraOff size={14} /> : <Camera size={14} />}
        </button>
      </div>

      <div className="space-y-3 rounded-xl border bg-white p-4">
        <div>
          <h3 className="text-sm font-semibold">Layered fit</h3>
          <p className="mt-1 text-xs text-slate-500">
            The wig auto-fits your head; use Overall scale to fine-tune, then
            adjust position / rotation / opacity per layer.
          </p>
        </div>

        <div className="rounded-lg border bg-slate-50 p-3">
          <FitSlider
            label="Overall scale"
            min={MIN_LAYER_SCALE}
            max={MAX_LAYER_SCALE}
            step={0.01}
            value={overallScale}
            onChange={setOverallScale}
          />
        </div>

        <div className="space-y-2">
          {LAYER_DEFS.map((layer) => (
            <LayerFitPanel
              key={layer.key}
              layer={layer}
              fit={fit[layer.key] || DEFAULT_LAYER_FIT}
              expanded={expandedLayer === layer.key}
              onToggleExpanded={() => setExpandedLayer(expandedLayer === layer.key ? '' : layer.key)}
              onChange={(newFit) => updateLayerFit(layer.key, newFit)}
            />
          ))}
        </div>

        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-xs font-semibold">Editable layer</p>
          <div className="grid grid-cols-3 gap-1">
            {USER_EDITABLE_LAYER_KEYS.map((layerKey) => {
              const label = LAYER_DEFS.find((l) => l.key === layerKey)?.label || layerKey;
              const active = editLayerKey === layerKey;
              return (
                <button
                  key={layerKey}
                  type="button"
                  className="rounded border px-2 py-1 text-[11px] font-semibold"
                  style={{
                    borderColor: active ? '#0f172a' : '#d1d5db',
                    background: active ? '#0f172a' : '#fff',
                    color: active ? '#fff' : '#334155',
                  }}
                  onClick={() => setEditLayerKey(layerKey)}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <LayerEraseEditor
            layerKey={editLayerKey}
            baseUrl={(layerUrls && layerUrls[editLayerKey]) || null}
            stagedUrl={editedLayerDataUrls[editLayerKey] || null}
            brushSize={eraserBrushSize}
            setBrushSize={setEraserBrushSize}
            onEditedDataUrl={handleEditedLayerDataUrl}
          />
        </div>

        <div className="flex gap-2 pt-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => setFit(lockLayerFitScale({}))}
            className="rounded-md border px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
          >
            Reset
          </button>
          {mode === 'create' ? (
            <>
              <button
                type="button"
                disabled={saving}
                onClick={onRedo}
                className="rounded-md border px-3 py-1.5 text-xs font-semibold text-red-600 hover:bg-red-50"
              >
                Redo with AI
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => onApprove?.(editedLayerDataUrls)}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold text-white"
                style={{ background: '#0f172a' }}
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                Approve
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                disabled={saving}
                onClick={onCancel}
                className="rounded-md border px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={() => onSave?.(editedLayerDataUrls)}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold text-white"
                style={{ background: '#0f172a' }}
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                Save fit
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Uploads any locally-edited layer data URLs to storage and returns the
// patch of `Layer_*_Path` columns to update on the filter row.
async function uploadEditedLayerDataUrls({ filterRow, editedLayerDataUrls }) {
  if (!filterRow || !editedLayerDataUrls || !supabase) return {};
  const { data: sessionData } = await supabase.auth.getSession();
  const currentAuthUserId = sessionData?.session?.user?.id || '';
  if (!currentAuthUserId) throw new Error('Session expired. Please sign in again before approving.');
  const patch = {};
  for (const [layerKey, dataUrl] of Object.entries(editedLayerDataUrls)) {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) continue;
    const column = LAYER_PATH_COLUMNS[layerKey];
    if (!column) continue;
    const blob = await (await fetch(dataUrl)).blob();
    const unique = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const editedPath = `${currentAuthUserId}/wig-ai-filters/filter-${filterRow.Filter_ID}/v${filterRow.Version || 1}/${layerKey}-edited-${unique}.png`;
    const { error: upErr } = await supabase.storage
      .from(FILTERS_BUCKET)
      .upload(editedPath, blob, { upsert: false, contentType: 'image/png' });
    if (upErr) {
      throw new Error(`Layer upload failed (${layerKey}): ${describeDbError(upErr, 'RLS/storage error')}`);
    }
    patch[column] = editedPath;
    if (layerKey === 'full_wig') {
      patch.Thumbnail_Path = editedPath;
    }
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Create Filter tab
// ---------------------------------------------------------------------------
const DEFAULT_WIG_FORM = Object.freeze({
  wigName: '',
  wigCode: '',
  hairLength: '',
  hairColor: COLOR_OPTIONS[0],
  hairTexture: TEXTURE_OPTIONS[0],
  hairDensity: DENSITY_OPTIONS[1],
  capSize: CAP_SIZE_OPTIONS[2],
  style: '',
});

function CreateFilterTab({
  authUserId,
  userIdInt,
  userProfile,
  primaryColor,
  onAfterApprove,
}) {
  const [wigForm, setWigForm] = useState({ ...DEFAULT_WIG_FORM });
  const [sources, setSources] = useState({ front: null, side: null, top: null, back: null });
  const [submitting, setSubmitting] = useState(false);
  const [currentFilter, setCurrentFilter] = useState(null);
  const [fit, setFit] = useState(() => lockLayerFitScale({}));
  const [notice, setNotice] = useState({ kind: '', message: '' });
  const [approveSaving, setApproveSaving] = useState(false);
  const pollTimerRef = useRef(null);

  useEffect(() => () => {
    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
  }, []);

  useEffect(() => {
    if (currentFilter?.Fit_Settings && typeof currentFilter.Fit_Settings === 'object') {
      setFit(mergeLayerFits(currentFilter.Fit_Settings));
    }
  }, [currentFilter?.Filter_ID]);  // eslint-disable-line react-hooks/exhaustive-deps

  const layerUrls = useMemo(() => buildLayerUrls(currentFilter), [currentFilter]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const pollFilter = useCallback(async (filterId) => {
    if (!supabase) return;
    const { data, error } = await supabase
      .from(FILTERS_TABLE)
      .select('*')
      .eq('Filter_ID', filterId)
      .maybeSingle();
    if (error) {
      setNotice({ kind: 'error', message: error.message });
      stopPolling();
      return;
    }
    if (!data) return;
    setCurrentFilter(data);
    if (data.Status === 'pending_review' || data.Status === 'approved' || data.Status === 'failed') {
      stopPolling();
    }
  }, [stopPolling]);

  const startPolling = useCallback((filterId) => {
    stopPolling();
    pollFilter(filterId);
    pollTimerRef.current = setInterval(() => pollFilter(filterId), POLL_INTERVAL_MS);
  }, [pollFilter, stopPolling]);

  const handleSetSource = useCallback((key, file) => {
    setSources((prev) => ({ ...prev, [key]: file }));
  }, []);

  const updateWigForm = (patch) => setWigForm((prev) => ({ ...prev, ...patch }));

  const canSubmit =
    !!wigForm.wigName.trim() &&
    !!sources.front &&
    !!sources.side &&
    !submitting &&
    !currentFilter;

  const handleSubmit = async () => {
    if (!supabase || !canSubmit) return;
    setSubmitting(true);
    setNotice({ kind: '', message: '' });
    try {
      const lengthValueRaw = wigForm.hairLength === '' ? null : Number(wigForm.hairLength);
      const sanitizedLength = Number.isFinite(lengthValueRaw) ? lengthValueRaw : null;

      // 1. Upload source images to a draft folder keyed by timestamp+random.
      const draftKey = shortDraftKey();
      const uploadedPaths = {};
      for (const view of VIEW_DEFS) {
        const file = sources[view.key];
        if (!file) {
          if (view.required) throw new Error(`${view.label} image is required.`);
          continue;
        }
        const ext = fileExtension(file);
        const path = buildSourcePath(authUserId, draftKey, view.key, ext);
        const { error: upErr } = await supabase.storage
          .from(SOURCES_BUCKET)
          .upload(path, file, { upsert: true, contentType: file.type || 'image/jpeg' });
        if (upErr) throw upErr;
        uploadedPaths[view.key] = path;
      }

      // 2. Insert Wig_AI_Filters row with Pending_* draft fields. The actual
      //    Wigs / Wig_Specifications rows are created later at Approve time.
      const insertPayload = {
        Wig_ID: null,
        Version: 1,
        Status: 'processing',
        Source_Front_Path: uploadedPaths.front,
        Source_Side_Path: uploadedPaths.side,
        Source_Top_Path: uploadedPaths.top || null,
        Source_Back_Path: uploadedPaths.back || null,
        Fit_Settings: lockLayerFitScale(DEFAULT_LAYER_FITS),
        Created_By_User_ID: userIdInt,
        Pending_Wig_Name: wigForm.wigName.trim(),
        Pending_Wig_Code: wigForm.wigCode.trim() || null,
        Pending_Hair_Length: sanitizedLength,
        Pending_Hair_Color: wigForm.hairColor || null,
        Pending_Hair_Texture: wigForm.hairTexture || null,
        Pending_Hair_Density: wigForm.hairDensity || null,
        Pending_Cap_Size: wigForm.capSize || null,
        Pending_Style: wigForm.style.trim() || null,
      };
      const { data: inserted, error: insErr } = await supabase
        .from(FILTERS_TABLE)
        .insert(insertPayload)
        .select()
        .single();
      if (insErr) throw insErr;

      // 3. Kick off AI server.
      const aiResp = await fetch(`${AI_SERVER_BASE_URL}/generate-filter`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filter_id: inserted.Filter_ID,
          auth_user_id: authUserId,
          source_front_path: inserted.Source_Front_Path,
          source_side_path: inserted.Source_Side_Path,
          source_top_path: inserted.Source_Top_Path,
          source_back_path: inserted.Source_Back_Path,
          version: inserted.Version,
          hair_color: wigForm.hairColor || null,
          hair_texture: wigForm.hairTexture || null,
          hair_density: wigForm.hairDensity || null,
          cap_size: wigForm.capSize || null,
          style: wigForm.style.trim() || null,
          hair_length: sanitizedLength,
        }),
      });
      if (!aiResp.ok) {
        const text = await aiResp.text();
        throw new Error(`AI server: ${text || aiResp.status}`);
      }

      setCurrentFilter(inserted);
      setFit(lockLayerFitScale(inserted.Fit_Settings));
      startPolling(inserted.Filter_ID);
      void logAuditAction({
        action: 'wig_ai_filter_submitted',
        description: `filter_id=${inserted.Filter_ID} staged_for_approval=true`,
        resource: 'wig_ai_studio',
        userProfile,
      });
    } catch (err) {
      setNotice({ kind: 'error', message: err?.message || 'Could not submit. Please try again.' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = () => {
    stopPolling();
    setCurrentFilter(null);
    setSources({ front: null, side: null, top: null, back: null });
    setFit(lockLayerFitScale({}));
    setWigForm({ ...DEFAULT_WIG_FORM });
    setNotice({ kind: '', message: '' });
  };

  const handleApprove = async (editedLayerDataUrls = {}) => {
    if (!currentFilter || !supabase) return;
    setApproveSaving(true);
    try {
      let wigId = currentFilter.Wig_ID || null;
      const approvedFit = lockLayerFitScale(fit);

      // First time approving this draft -> create the Wig + Wig_Specifications.
      if (!wigId) {
        const pendingWigName = String(currentFilter.Pending_Wig_Name || '').trim();
        if (!pendingWigName) throw new Error('Missing staged wig name. Please redo generation.');

        // Auto-generate a unique Wig_Code if the user left it blank. The
        // existing set_wig_code_from_bundle_submission trigger fills blanks
        // with WIG-{year}-{Wig_ID padded} but Wig_ID isn't assigned during
        // BEFORE INSERT, so blank inserts collide on the unique index.
        const generatedWigCode = String(currentFilter.Pending_Wig_Code || '').trim()
          || `AI-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase()}`;

        // Stock_Count defaults to 1 (the wig physically exists). Specialist
        // can increase stock later from Active Filters using "+ Stock".
        const wigInsertPayload = {
          Wig_Name: pendingWigName,
          Wig_Code: generatedWigCode,
          Stock_Count: 1,
          Wig_Status: 'available',
          Created_By: userIdInt,
          Added_By: userIdInt,
        };
        const { data: newWig, error: wigErr } = await supabase
          .from(WIGS_TABLE)
          .insert(wigInsertPayload)
          .select()
          .single();
        if (wigErr) throw wigErr;
        wigId = newWig.Wig_ID;

        const pendingLengthValue = currentFilter.Pending_Hair_Length === null
          || currentFilter.Pending_Hair_Length === undefined
          || currentFilter.Pending_Hair_Length === ''
            ? null
            : Number(currentFilter.Pending_Hair_Length);
        const specPayload = {
          Wig_ID: wigId,
          Hair_Length: Number.isFinite(pendingLengthValue) ? pendingLengthValue : null,
          Hair_Color: currentFilter.Pending_Hair_Color || null,
          Hair_Texture: currentFilter.Pending_Hair_Texture || null,
          Hair_Density: currentFilter.Pending_Hair_Density || null,
          Cap_Size: currentFilter.Pending_Cap_Size || null,
          Style: (currentFilter.Pending_Style || '').trim() || null,
        };
        const { error: specErr } = await supabase
          .from(WIG_SPECS_TABLE)
          .insert(specPayload);
        if (specErr) throw specErr;
      }

      const editedLayerPathPatch = await uploadEditedLayerDataUrls({
        filterRow: currentFilter,
        editedLayerDataUrls,
      });

      const { error } = await supabase
        .from(FILTERS_TABLE)
        .update({
          Wig_ID: wigId,
          Status: 'approved',
          Is_Active: false,
          Fit_Settings: approvedFit,
          Approved_By_User_ID: userIdInt,
          Approved_At: getManilaSqlTimestamp(),
          Pending_Wig_Name: null,
          Pending_Wig_Code: null,
          Pending_Hair_Length: null,
          Pending_Hair_Color: null,
          Pending_Hair_Texture: null,
          Pending_Hair_Density: null,
          Pending_Cap_Size: null,
          Pending_Style: null,
          ...editedLayerPathPatch,
        })
        .eq('Filter_ID', currentFilter.Filter_ID);
      if (error) throw error;

      setFit(approvedFit);
      void logAuditAction({
        action: 'wig_ai_filter_approved',
        description: `filter_id=${currentFilter.Filter_ID} wig_id=${wigId}`,
        resource: 'wig_ai_studio',
        userProfile,
      });
      setNotice({
        kind: 'success',
        message: 'Filter approved. It is saved as inactive; set it active from Active Filters when ready.',
      });
      onAfterApprove?.();
      handleReset();
    } catch (err) {
      setNotice({ kind: 'error', message: err?.message || 'Could not approve. Please try again.' });
    } finally {
      setApproveSaving(false);
    }
  };

  const handleRedo = async () => {
    if (!currentFilter || !supabase) return;
    try {
      await supabase
        .from(FILTERS_TABLE)
        .update({ Status: 'rejected' })
        .eq('Filter_ID', currentFilter.Filter_ID);
      void logAuditAction({
        action: 'wig_ai_filter_rejected',
        description: `filter_id=${currentFilter.Filter_ID}`,
        resource: 'wig_ai_studio',
        userProfile,
      });
    } catch { /* non-fatal */ }
    handleReset();
  };

  const status = currentFilter?.Status;

  return (
    <div className="space-y-4">
      {notice.message ? (
        <div
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${
            notice.kind === 'error'
              ? 'border-red-200 bg-red-50 text-red-700'
              : 'border-emerald-200 bg-emerald-50 text-emerald-700'
          }`}
        >
          {notice.kind === 'error' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
          <span>{notice.message}</span>
          <button
            type="button"
            className="ml-auto text-slate-500 hover:text-slate-700"
            onClick={() => setNotice({ kind: '', message: '' })}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}

      {!currentFilter && (
        <div className="space-y-4">
          <div className="rounded-2xl border bg-white p-4">
            <h3 className="text-sm font-semibold">1. New wig details</h3>
            <p className="mt-1 text-xs text-slate-500">
              The wig record is created when you approve the generated filter.
              Stock starts at 1 and can be adjusted in Inventory.
            </p>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              <label className="block">
                <span className="text-xs font-medium">Wig name <span className="text-red-500">*</span></span>
                <input
                  type="text"
                  className="mt-1 w-full rounded-md border px-2 py-2 text-sm"
                  value={wigForm.wigName}
                  onChange={(e) => updateWigForm({ wigName: e.target.value })}
                  placeholder="e.g. Long Wavy Black"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium">Wig code (optional)</span>
                <input
                  type="text"
                  className="mt-1 w-full rounded-md border px-2 py-2 text-sm"
                  value={wigForm.wigCode}
                  onChange={(e) => updateWigForm({ wigCode: e.target.value })}
                  placeholder="e.g. SS-2026-001"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium">Hair length (in inches)</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  className="mt-1 w-full rounded-md border px-2 py-2 text-sm"
                  value={wigForm.hairLength}
                  onChange={(e) => updateWigForm({ hairLength: e.target.value })}
                  placeholder="e.g. 14"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium">Hair color</span>
                <select
                  className="mt-1 w-full rounded-md border px-2 py-2 text-sm"
                  value={wigForm.hairColor}
                  onChange={(e) => updateWigForm({ hairColor: e.target.value })}
                >
                  {COLOR_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium">Hair texture</span>
                <select
                  className="mt-1 w-full rounded-md border px-2 py-2 text-sm"
                  value={wigForm.hairTexture}
                  onChange={(e) => updateWigForm({ hairTexture: e.target.value })}
                >
                  {TEXTURE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium">Hair density</span>
                <select
                  className="mt-1 w-full rounded-md border px-2 py-2 text-sm"
                  value={wigForm.hairDensity}
                  onChange={(e) => updateWigForm({ hairDensity: e.target.value })}
                >
                  {DENSITY_OPTIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium">Cap size</span>
                <select
                  className="mt-1 w-full rounded-md border px-2 py-2 text-sm"
                  value={wigForm.capSize}
                  onChange={(e) => updateWigForm({ capSize: e.target.value })}
                >
                  {CAP_SIZE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-xs font-medium">Style (optional)</span>
                <input
                  type="text"
                  className="mt-1 w-full rounded-md border px-2 py-2 text-sm"
                  value={wigForm.style}
                  onChange={(e) => updateWigForm({ style: e.target.value })}
                  placeholder="e.g. Layered Bob"
                />
              </label>
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-4">
            <h3 className="text-sm font-semibold">2. Upload reference photos</h3>
            <p className="mt-1 text-xs text-slate-500">
              Front + Side are required. Top + Back improve back-of-head quality (optional).
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              {VIEW_DEFS.map((v) => (
                <SourceUploader
                  key={v.key}
                  view={v}
                  file={sources[v.key]}
                  onChange={(file) => handleSetSource(v.key, file)}
                  primaryColor={primaryColor}
                />
              ))}
            </div>
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={!canSubmit}
                onClick={handleSubmit}
                className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                style={{ background: '#0f172a' }}
              >
                {submitting ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                Generate Filter
              </button>
            </div>
          </div>
        </div>
      )}

      {currentFilter && status === 'processing' && (
        <div className="flex flex-col items-center justify-center rounded-2xl border bg-white p-10 text-center">
          <Loader2 className="animate-spin" size={32} style={{ color: '#0f172a' }} />
          <p className="mt-3 text-sm font-semibold">AI is generating your filter</p>
          <p className="mt-1 text-xs text-slate-500">
            Typical time: 30-90 seconds. You can leave this tab open.
          </p>
          <button
            type="button"
            className="mt-4 text-xs underline text-slate-500"
            onClick={handleReset}
            title="The AI keeps generating in the background; check the Active Filters tab when it is done."
          >
            Hide and start a new one
          </button>
        </div>
      )}

      {currentFilter && status === 'failed' && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-center">
          <AlertCircle className="mx-auto" size={28} />
          <p className="mt-2 text-sm font-semibold text-red-700">
            Filter generation failed. Please try again.
          </p>
          {currentFilter.Error_Message ? (
            <p className="mt-1 text-xs text-red-600 break-all">{String(currentFilter.Error_Message).slice(0, 280)}</p>
          ) : null}
          <button
            type="button"
            className="mt-4 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold text-white"
            style={{ background: '#0f172a' }}
            onClick={handleReset}
          >
            <RefreshCw size={12} /> Try again
          </button>
        </div>
      )}

      {currentFilter
        && (status === 'pending_review' || status === 'approved')
        && hasGeneratedLayers(currentFilter) && (
        <TryOnEditor
          filter={currentFilter}
          layerUrls={layerUrls}
          fit={fit}
          setFit={setFit}
          onApprove={handleApprove}
          onRedo={handleRedo}
          primaryColor={primaryColor}
          saving={approveSaving}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit Filter modal (opened from Active Filters tab; filter must be inactive)
// ---------------------------------------------------------------------------
function EditFilterModal({ filter, wig, userProfile, primaryColor, onClose, onSaved }) {
  const [fit, setFit] = useState(() => mergeLayerFits(filter?.Fit_Settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const layerUrls = useMemo(() => buildLayerUrls(filter), [filter]);
  const hasLayers = useMemo(() => hasGeneratedLayers(filter), [filter]);

  const handleSave = async (editedLayerDataUrls = {}) => {
    if (!supabase) return;
    setSaving(true);
    setError('');
    try {
      const editedLayerPathPatch = await uploadEditedLayerDataUrls({
        filterRow: filter,
        editedLayerDataUrls,
      });
      const shouldPromoteToApproved = Boolean(filter?.Wig_ID) && filter?.Status === 'pending_review';
      const approvedByUserIdRaw = userProfile?.user_id ?? userProfile?.User_ID ?? userProfile?.User_ID_Int;
      const approvedByUserId = Number(approvedByUserIdRaw);
      const approvalPatch = shouldPromoteToApproved
        ? {
          Status: 'approved',
          Is_Active: false,
          Approved_At: getManilaSqlTimestamp(),
          ...(Number.isFinite(approvedByUserId) ? { Approved_By_User_ID: approvedByUserId } : {}),
        }
        : {};
      const payload = { Fit_Settings: fit, ...editedLayerPathPatch, ...approvalPatch };
      const { error: upErr } = await supabase
        .from(FILTERS_TABLE)
        .update(payload)
        .eq('Filter_ID', filter.Filter_ID);
      if (upErr) {
        const message = String(upErr?.message || '').toLowerCase();
        if (message.includes('row-level security')) {
          const rpcPayload = {
            p_filter_id: Number(filter.Filter_ID),
            p_fit_settings: fit,
            p_layer_full_wig_path: editedLayerPathPatch.Layer_Full_Wig_Path ?? null,
            p_layer_back_hair_path: editedLayerPathPatch.Layer_Back_Hair_Path ?? null,
            p_layer_front_bangs_path: editedLayerPathPatch.Layer_Front_Bangs_Path ?? null,
            p_layer_hair_mask_path: editedLayerPathPatch.Layer_Hair_Mask_Path ?? null,
            p_layer_face_mask_path: editedLayerPathPatch.Layer_Face_Mask_Path ?? null,
            p_thumbnail_path: editedLayerPathPatch.Thumbnail_Path ?? null,
            p_status: shouldPromoteToApproved ? 'approved' : null,
            p_is_active: shouldPromoteToApproved ? false : null,
            p_approved_at: shouldPromoteToApproved ? getManilaSqlTimestamp() : null,
            p_approved_by_user_id: (shouldPromoteToApproved && Number.isFinite(approvedByUserId)) ? approvedByUserId : null,
          };
          let { error: rpcErr } = await supabase.rpc('save_wig_ai_filter_fit', rpcPayload);
          if (rpcErr) {
            const rpcMsg = String(rpcErr?.message || '').toLowerCase();
            if (rpcMsg.includes('function') && rpcMsg.includes('save_wig_ai_filter_fit')) {
              // Backward-compat fallback for older RPC signature deployed in DB.
              const legacyPayload = {
                p_filter_id: Number(filter.Filter_ID),
                p_fit_settings: fit,
                p_layer_full_wig_path: editedLayerPathPatch.Layer_Full_Wig_Path ?? null,
                p_layer_back_hair_path: editedLayerPathPatch.Layer_Back_Hair_Path ?? null,
                p_layer_front_bangs_path: editedLayerPathPatch.Layer_Front_Bangs_Path ?? null,
                p_layer_hair_mask_path: editedLayerPathPatch.Layer_Hair_Mask_Path ?? null,
                p_layer_face_mask_path: editedLayerPathPatch.Layer_Face_Mask_Path ?? null,
                p_thumbnail_path: editedLayerPathPatch.Thumbnail_Path ?? null,
              };
              const legacy = await supabase.rpc('save_wig_ai_filter_fit', legacyPayload);
              rpcErr = legacy.error;
            }
          }
          if (rpcErr) throw rpcErr;
        } else {
          throw upErr;
        }
      }
      void logAuditAction({
        action: 'wig_ai_filter_fit_edited',
        description: `filter_id=${filter.Filter_ID}`,
        resource: 'wig_ai_studio',
        userProfile,
      });
      onSaved?.();
    } catch (err) {
      setError(describeDbError(err, 'Could not save. Please try again.'));
    } finally {
      setSaving(false);
    }
  };

  const modalTree = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-[1px]">
      <div className="flex max-h-[95vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <p className="text-xs font-semibold tracking-wider text-slate-500">EDIT FIT</p>
            <h2 className="text-lg font-semibold">
              {wig?.Wig_Name || `Wig #${filter.Wig_ID}`} <span className="text-xs text-slate-400">v{filter.Version}</span>
            </h2>
          </div>
          <button
            type="button"
            className="rounded-full p-2 text-slate-500 hover:bg-slate-100"
            onClick={onClose}
            aria-label="Close edit modal"
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-auto p-4">
          {error ? (
            <div className="mb-3 flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              <AlertCircle size={14} /> {error}
            </div>
          ) : null}
          {hasLayers ? (
            <TryOnEditor
              filter={filter}
              layerUrls={layerUrls}
              fit={fit}
              setFit={setFit}
              primaryColor={primaryColor}
              saving={saving}
              mode="edit"
              onSave={handleSave}
              onCancel={onClose}
            />
          ) : (
            <p className="text-sm text-slate-500">This filter has no generated layers yet.</p>
          )}
        </div>
      </div>
    </div>
  );
  if (typeof document === 'undefined') return modalTree;
  return createPortal(modalTree, document.body);
}

function CompleteFromBundleModal({
  open,
  manualCode,
  saving,
  error,
  success,
  onManualCodeChange,
  onSubmitScan,
  onClose,
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scannerCanvasRef = useRef(null);
  const isScanProcessingRef = useRef(false);
  const lastScanRef = useRef({ raw: '', at: 0 });
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [cameraMessage, setCameraMessage] = useState('Camera is off. Start scanner to read a bundle waybill QR.');
  const [cameraTone, setCameraTone] = useState('info');

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const handleToggleCamera = useCallback(async () => {
    if (isCameraOn) {
      stopCamera();
      setIsCameraOn(false);
      setCameraTone('info');
      setCameraMessage('Camera is off. Start scanner to read a bundle waybill QR.');
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraTone('error');
      setCameraMessage('Camera API is unavailable on this browser/device.');
      return;
    }

    setIsStartingCamera(true);
    setCameraTone('info');
    setCameraMessage('Initializing camera scanner...');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        await videoRef.current.play();
      }
      setIsCameraOn(true);
      setCameraTone('success');
      setCameraMessage('Scanner is running. Point camera at a bundle waybill QR.');
    } catch (err) {
      setCameraTone('error');
      setCameraMessage(err?.message || 'Could not access camera.');
    } finally {
      setIsStartingCamera(false);
    }
  }, [isCameraOn, stopCamera]);

  useEffect(() => {
    if (!open || !isCameraOn) return undefined;

    const intervalId = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || isScanProcessingRef.current || saving) return;

      const frameWidth = video.videoWidth;
      const frameHeight = video.videoHeight;
      if (!frameWidth || !frameHeight) return;

      try {
        if (!scannerCanvasRef.current) scannerCanvasRef.current = document.createElement('canvas');
        const canvas = scannerCanvasRef.current;
        canvas.width = frameWidth;
        canvas.height = frameHeight;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;

        ctx.drawImage(video, 0, 0, frameWidth, frameHeight);
        const imageData = ctx.getImageData(0, 0, frameWidth, frameHeight);
        const code = jsQR(imageData.data, frameWidth, frameHeight, { inversionAttempts: 'attemptBoth' });
        const decoded = String(code?.data || '').trim();
        if (!decoded) return;

        const now = Date.now();
        if (lastScanRef.current.raw === decoded && now - lastScanRef.current.at < 2500) return;
        lastScanRef.current = { raw: decoded, at: now };

        isScanProcessingRef.current = true;
        Promise.resolve(onSubmitScan?.(decoded)).finally(() => {
          isScanProcessingRef.current = false;
        });
      } catch {
        // ignore frame-level scanner errors
      }
    }, 280);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isCameraOn, onSubmitScan, open, saving]);

  useEffect(() => {
    if (open) return undefined;
    stopCamera();
    setIsCameraOn(false);
    setCameraTone('info');
    setCameraMessage('Camera is off. Start scanner to read a bundle waybill QR.');
    return undefined;
  }, [open, stopCamera]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  if (!open) return null;

  const toneClasses = cameraTone === 'error'
    ? 'border-red-200 bg-red-50 text-red-700'
    : cameraTone === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : 'border-sky-200 bg-sky-50 text-sky-700';

  const modalTree = (
    <div className="fixed inset-0 z-[2147483000] flex items-center justify-center bg-black/70 p-4 backdrop-blur-[1px]">
      <div className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5">
        <div className="flex items-center justify-between px-5 pb-2 pt-3">
          <div>
            <p className="text-xs font-semibold tracking-wider text-slate-500">WIG AI STOCK SCANNER</p>
            <h2 className="text-lg font-semibold">Complete Wig from Bundle Waybill</h2>
          </div>
          <button
            type="button"
            className="rounded-full p-2 text-slate-500 hover:bg-slate-100"
            onClick={onClose}
            disabled={saving}
            aria-label="Close bundle scan modal"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-[220px,1fr]">
            <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-900">
              <div className="relative aspect-square w-full">
                <video ref={videoRef} className={`h-full w-full object-cover ${isCameraOn ? '' : 'hidden'}`} autoPlay playsInline muted />
                {!isCameraOn ? (
                  <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-slate-300">
                    Camera preview
                  </div>
                ) : null}
              </div>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => { void handleToggleCamera(); }}
                disabled={isStartingCamera || saving}
                className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold text-white transition disabled:opacity-60"
                style={{ backgroundColor: isCameraOn ? '#dc2626' : '#0f172a' }}
              >
                {isStartingCamera ? <Loader2 size={12} className="animate-spin" /> : isCameraOn ? <CameraOff size={12} /> : <Camera size={12} />}
                {isCameraOn ? 'Stop Camera' : 'Start Camera'}
              </button>

              <div className={`rounded-md border px-3 py-2 text-xs ${toneClasses}`}>
                <span className="inline-flex items-start gap-1.5">
                  <AlertCircle size={12} className="mt-0.5" />
                  {cameraMessage}
                </span>
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={manualCode}
                  onChange={(event) => onManualCodeChange?.(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void onSubmitScan?.(manualCode);
                    }
                  }}
                  placeholder="Scan or enter bundle waybill code"
                  className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs transition focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-100"
                  disabled={saving}
                />
                <button
                  type="button"
                  onClick={() => { void onSubmitScan?.(manualCode); }}
                  disabled={!String(manualCode || '').trim() || saving}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-60"
                >
                  {saving ? <Loader2 size={12} className="animate-spin" /> : <ScanLine size={12} />}
                  Scan
                </button>
              </div>

              <p className="text-[11px] text-slate-500">
                One valid scan adds <strong>+1 stock</strong> to the wig matched by this bundle&apos;s <strong>Wig_Specification_ID</strong>, then marks the bundle and linked hair submissions as <strong>Wig Created</strong>.
              </p>
            </div>
          </div>

          {error ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          ) : null}
          {success ? (
            <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">{success}</p>
          ) : null}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-3 pt-2">
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            onClick={onClose}
            disabled={saving}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return modalTree;
  return createPortal(modalTree, document.body);
}

function AddStockModal({
  open,
  wig,
  qty,
  reason,
  saving,
  error,
  onQtyChange,
  onReasonChange,
  onCancel,
  onSubmit,
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-[1px]">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5">
        <div className="flex items-center justify-between px-5 pb-2 pt-3">
          <div>
            <p className="text-xs font-semibold tracking-wider text-slate-500">WIG STOCK</p>
            <h2 className="text-lg font-semibold">Add stock</h2>
          </div>
          <button
            type="button"
            className="rounded-full p-2 text-slate-500 hover:bg-slate-100"
            onClick={onCancel}
            disabled={saving}
            aria-label="Close stock modal"
          >
            <X size={18} />
          </button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <div className="rounded-lg border bg-slate-50 px-3 py-2 text-xs text-slate-600">
            Target: <span className="font-semibold text-slate-800">{wig?.Wig_Code || wig?.Wig_Name || `Wig #${wig?.Wig_ID}`}</span>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-slate-700">Quantity to add</span>
            <input
              type="number"
              min="1"
              step="1"
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
              value={qty}
              onChange={(e) => onQtyChange?.(e.target.value)}
              disabled={saving}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-700">Reason (optional)</span>
            <input
              type="text"
              maxLength={220}
              className="mt-1 w-full rounded-md border px-3 py-2 text-sm"
              value={reason}
              onChange={(e) => onReasonChange?.(e.target.value)}
              disabled={saving}
            />
          </label>
          {error ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 pb-3 pt-2">
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-semibold text-white"
            style={{ background: '#0f172a' }}
            onClick={onSubmit}
            disabled={saving}
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : null}
            Save stock
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoModal({ open, title, message, onClose }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-[1px]">
      <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5">
        <div className="flex items-center justify-between px-5 pb-2 pt-3">
          <h2 className="text-base font-semibold text-slate-900">{title || 'Notice'}</h2>
          <button
            type="button"
            className="rounded-full p-2 text-slate-500 hover:bg-slate-100"
            onClick={onClose}
            aria-label="Close message modal"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4">
          <p className="text-sm text-slate-700">{message || 'Something happened.'}</p>
        </div>
        <div className="flex justify-end px-5 pb-3 pt-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-sm font-semibold text-white"
            style={{ background: '#0f172a' }}
            onClick={onClose}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function WigAiStudioPage({ userProfile }) {
  const { primaryColor } = useTheme() || {};
  const [tab, setTab] = useState(TAB_CREATE);
  const [wigs, setWigs] = useState([]);
  const [filters, setFilters] = useState([]);
  const [loadingWigs, setLoadingWigs] = useState(false);
  const [loadingFilters, setLoadingFilters] = useState(false);
  const [authUserId, setAuthUserId] = useState('');
  const [userIdInt, setUserIdInt] = useState(null);
  const [editingFilter, setEditingFilter] = useState(null);
  const [stockModal, setStockModal] = useState(() => createInitialStockModalState());
  const [bundleScannerModal, setBundleScannerModal] = useState(() => createBundleScannerModalState());
  const [infoModal, setInfoModal] = useState({ open: false, title: '', message: '' });

  const openInfoModal = useCallback((title, message) => {
    setInfoModal({
      open: true,
      title: String(title || 'Notice'),
      message: String(message || ''),
    });
  }, []);

  const closeInfoModal = useCallback(() => {
    setInfoModal({ open: false, title: '', message: '' });
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadIdentity() {
      if (!supabase) return;
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData?.session?.user?.id || '';
      if (cancelled) return;
      setAuthUserId(uid);
      if (uid) {
        const { data: u } = await supabase
          .from('users')
          .select('user_id')
          .eq('auth_user_id', uid)
          .maybeSingle();
        if (!cancelled && u?.user_id) setUserIdInt(u.user_id);
      }
    }
    loadIdentity();
    return () => { cancelled = true; };
  }, []);

  const loadWigs = useCallback(async () => {
    if (!supabase) return;
    setLoadingWigs(true);
    try {
      const { data, error } = await supabase
        .from(WIGS_TABLE)
        .select('*')
        .order('Wig_ID', { ascending: false })
        .limit(500);
      if (error) throw error;
      setWigs(data || []);
    } catch {
      setWigs([]);
    } finally {
      setLoadingWigs(false);
    }
  }, []);

  const loadFilters = useCallback(async () => {
    if (!supabase) return;
    setLoadingFilters(true);
    try {
      const { data, error } = await supabase
        .from(FILTERS_TABLE)
        .select('*')
        .in('Status', ['approved', 'pending_review', 'superseded'])
        .order('Created_At', { ascending: false })
        .limit(500);
      if (error) throw error;
      setFilters(data || []);
    } catch {
      setFilters([]);
    } finally {
      setLoadingFilters(false);
    }
  }, []);

  useEffect(() => {
    loadWigs();
    loadFilters();
  }, [loadWigs, loadFilters]);

  const wigsById = useMemo(() => {
    const m = new Map();
    wigs.forEach((w) => m.set(w.Wig_ID, w));
    return m;
  }, [wigs]);

  const handleToggleActive = async (filter) => {
    if (!supabase) return;
    if (!filter.Wig_ID) {
      openInfoModal('Cannot activate filter', 'Filter has no Wig record yet. Approve the draft first.');
      return;
    }
    const next = !filter.Is_Active;
    const payload = next
      ? { Is_Active: true, Status: 'approved' }
      : { Is_Active: false };
    const { error } = await supabase
      .from(FILTERS_TABLE)
      .update(payload)
      .eq('Filter_ID', filter.Filter_ID);
    if (error) {
      openInfoModal('Update failed', error.message || 'Could not update filter state.');
      return;
    }
    void logAuditAction({
      action: next ? 'wig_ai_filter_activated' : 'wig_ai_filter_deactivated',
      description: `filter_id=${filter.Filter_ID}`,
      resource: 'wig_ai_studio',
      userProfile,
    });
    loadFilters();
  };

  const handleAddStock = (wig) => {
    if (!wig?.Wig_ID) return;
    setStockModal({
      open: true,
      wig,
      qty: '1',
      reason: 'Stock replenishment',
      saving: false,
      error: '',
    });
  };

  const handleSubmitStock = async () => {
    if (!supabase || !stockModal?.wig?.Wig_ID) return;
    const qty = Number.parseInt(String(stockModal.qty || '').trim(), 10);
    if (!Number.isFinite(qty) || qty <= 0) {
      setStockModal((prev) => ({ ...prev, error: 'Please enter a positive whole number.' }));
      return;
    }

    const wigId = Number(stockModal.wig.Wig_ID);
    const reason = String(stockModal.reason || '').trim();
    setStockModal((prev) => ({ ...prev, saving: true, error: '' }));

    try {
      const { data: currentWig, error: currentErr } = await supabase
        .from(WIGS_TABLE)
        .select('Wig_ID, Stock_Count')
        .eq('Wig_ID', wigId)
        .single();
      if (currentErr) throw currentErr;

      const previousStock = Math.max(0, Number(currentWig?.Stock_Count || 0));
      const nextStock = previousStock + qty;
      const nextStatus = nextStock > 0 ? 'available' : 'not available';

      const { error: updateErr } = await supabase
        .from(WIGS_TABLE)
        .update({
          Stock_Count: nextStock,
          Wig_Status: nextStatus,
        })
        .eq('Wig_ID', wigId);
      if (updateErr) throw updateErr;

      void logAuditAction({
        action: 'wig_stock_added',
        description: `wig_id=${wigId} delta=+${qty}${reason ? ` reason=${reason}` : ''}`,
        resource: 'wig_ai_studio',
        userProfile,
      });

      setStockModal(createInitialStockModalState());
      await loadWigs();
      await loadFilters();
    } catch (err) {
      setStockModal((prev) => ({
        ...prev,
        saving: false,
        error: err?.message || 'Could not add stock.',
      }));
    }
  };

  const handleCloseStockModal = () => {
    setStockModal((prev) => (prev.saving ? prev : createInitialStockModalState()));
  };

  const openBundleScannerModal = useCallback(() => {
    setBundleScannerModal({
      open: true,
      manualCode: '',
      saving: false,
      error: '',
      success: '',
    });
  }, []);

  const closeBundleScannerModal = useCallback(() => {
    setBundleScannerModal((prev) => (prev.saving ? prev : createBundleScannerModalState()));
  }, []);

  const handleCompleteFromBundleScan = useCallback(async (rawPayload) => {
    const payload = String(rawPayload || '').trim();
    if (!payload || !supabase) return;

    setBundleScannerModal((prev) => ({
      ...prev,
      saving: true,
      error: '',
      success: '',
    }));

    try {
      const result = await supabase.rpc('complete_wig_stock_from_bundle_scan', {
        p_waybill_payload: payload,
      });
      if (result.error) throw result.error;

      const data = result.data || {};
      const bundle = data.bundle || {};
      const wig = data.wig || {};
      const bundleCode = bundle.Bundle_Waybill_Code || `WB-${bundle.Bundle_ID}`;
      const wigLabel = wig.Wig_Code || wig.Wig_Name || `Wig #${wig.Wig_ID}`;
      const previousStock = Number(data.previous_stock ?? 0);
      const nextStock = Number(data.next_stock ?? previousStock + 1);
      const memberCount = Number(data.member_count || 0);

      void logAuditAction({
        action: 'wig_ai_bundle_scan_complete',
        description: `bundle_id=${bundle.Bundle_ID} bundle_code=${bundleCode} wig_id=${wig.Wig_ID} stock:${previousStock}->${nextStock} members=${memberCount}`,
        resource: 'wig_ai_studio',
        userProfile,
      });

      setBundleScannerModal((prev) => ({
        ...prev,
        manualCode: '',
        saving: false,
        error: '',
        success: `Bundle ${bundleCode} completed. ${wigLabel} stock updated: ${previousStock} -> ${nextStock}.`,
      }));

      await loadWigs();
      await loadFilters();
    } catch (err) {
      setBundleScannerModal((prev) => ({
        ...prev,
        saving: false,
        error: err?.message || 'Could not complete stock from bundle scan.',
        success: '',
      }));
    }
  }, [loadFilters, loadWigs, userProfile]);

  const handleDeleteFilter = async (filter) => {
    if (!supabase) return;
    if (!window.confirm(`Delete filter v${filter.Version}? The layer PNGs stay in storage.`)) return;
    const { error } = await supabase
      .from(FILTERS_TABLE)
      .delete()
      .eq('Filter_ID', filter.Filter_ID);
    if (error) {
      openInfoModal('Delete failed', error.message || 'Could not delete filter.');
      return;
    }
    loadFilters();
  };

  if (!isSupabaseConfigured) {
    return (
      <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-6 text-sm text-yellow-800">
        Supabase is not configured. Set <code>REACT_APP_SUPABASE_URL</code> and
        <code> REACT_APP_SUPABASE_ANON_KEY</code> in <code>.env.local</code> and reload.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="inline-flex rounded-lg border bg-white p-1 shadow-sm">
        <button
          type="button"
          className="rounded-md px-4 py-1.5 text-sm font-semibold transition"
          style={{
            background: tab === TAB_CREATE ? '#0f172a' : 'transparent',
            color: tab === TAB_CREATE ? '#fff' : '#475569',
          }}
          onClick={() => setTab(TAB_CREATE)}
        >
          <span className="inline-flex items-center gap-1.5">
            <Wand2 size={14} /> Create Filter
          </span>
        </button>
        <button
          type="button"
          className="rounded-md px-4 py-1.5 text-sm font-semibold transition"
          style={{
            background: tab === TAB_ACTIVE ? '#0f172a' : 'transparent',
            color: tab === TAB_ACTIVE ? '#fff' : '#475569',
          }}
          onClick={() => setTab(TAB_ACTIVE)}
        >
          <span className="inline-flex items-center gap-1.5">
            <Layers size={14} /> Active Filters
          </span>
        </button>
      </div>

      {tab === TAB_CREATE ? (
        <CreateFilterTab
          authUserId={authUserId}
          userIdInt={userIdInt}
          userProfile={userProfile}
          primaryColor={primaryColor}
          onAfterApprove={() => { loadFilters(); loadWigs(); }}
        />
      ) : (
        <ActiveFiltersTab
          filters={filters}
          wigsById={wigsById}
          onToggleActive={handleToggleActive}
          onDelete={handleDeleteFilter}
          onEdit={(f) => setEditingFilter(f)}
          onAddStock={handleAddStock}
          onOpenBundleScanner={openBundleScannerModal}
          loading={loadingFilters}
          refresh={loadFilters}
          primaryColor={primaryColor}
        />
      )}

      {editingFilter ? (
        <EditFilterModal
          filter={editingFilter}
          wig={wigsById.get(editingFilter.Wig_ID)}
          userProfile={userProfile}
          primaryColor={primaryColor}
          onClose={() => setEditingFilter(null)}
          onSaved={() => { setEditingFilter(null); loadFilters(); }}
        />
      ) : null}

      <AddStockModal
        open={stockModal.open}
        wig={stockModal.wig}
        qty={stockModal.qty}
        reason={stockModal.reason}
        saving={stockModal.saving}
        error={stockModal.error}
        onQtyChange={(value) => setStockModal((prev) => ({ ...prev, qty: value, error: '' }))}
        onReasonChange={(value) => setStockModal((prev) => ({ ...prev, reason: value }))}
        onCancel={handleCloseStockModal}
        onSubmit={handleSubmitStock}
      />

      <CompleteFromBundleModal
        open={bundleScannerModal.open}
        manualCode={bundleScannerModal.manualCode}
        saving={bundleScannerModal.saving}
        error={bundleScannerModal.error}
        success={bundleScannerModal.success}
        onManualCodeChange={(value) => setBundleScannerModal((prev) => ({
          ...prev,
          manualCode: value,
          error: '',
          success: prev.success,
        }))}
        onSubmitScan={handleCompleteFromBundleScan}
        onClose={closeBundleScannerModal}
      />

      <InfoModal
        open={infoModal.open}
        title={infoModal.title}
        message={infoModal.message}
        onClose={closeInfoModal}
      />

      {loadingWigs && (
        <p className="text-xs text-slate-400">
          <Loader2 size={12} className="mr-1 inline animate-spin" /> Loading wigs...
        </p>
      )}
    </div>
  );
}

