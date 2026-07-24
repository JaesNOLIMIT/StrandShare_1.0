import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ImagePlus,
  Loader2,
  RotateCcw,
  ScanFace,
  Upload,
} from 'lucide-react';
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';

const MEDIAPIPE_WASM =
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm';
const FACE_MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

export const DEFAULT_TRY_ON_FIT = Object.freeze({
  full_wig: {
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    visible: true,
  },
});

let faceLandmarkerPromise = null;

async function getFaceLandmarker() {
  if (!faceLandmarkerPromise) {
    faceLandmarkerPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM);
      return FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: FACE_MODEL,
          delegate: 'GPU',
        },
        runningMode: 'IMAGE',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      });
    })();
  }
  return faceLandmarkerPromise;
}

function Slider({ label, value, min, max, step, onChange, suffix = '' }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center justify-between text-[11px] font-medium text-slate-600">
        <span>{label}</span>
        <span className="font-mono text-slate-500">{Number(value).toFixed(step < 1 ? 2 : 0)}{suffix}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-slate-900"
      />
    </label>
  );
}

export default function PhotoTryOn({
  wigImageUrl,
  fit,
  setFit,
  onPortraitReady,
}) {
  const inputRef = useRef(null);
  const canvasRef = useRef(null);
  const portraitImageRef = useRef(null);
  const wigImageRef = useRef(null);
  const [portraitFile, setPortraitFile] = useState(null);
  const [landmarks, setLandmarks] = useState(null);
  const [detectionState, setDetectionState] = useState('idle');
  const [message, setMessage] = useState('Upload a clear, front-facing portrait.');

  const portraitUrl = useMemo(
    () => (portraitFile ? URL.createObjectURL(portraitFile) : ''),
    [portraitFile],
  );

  useEffect(() => () => {
    if (portraitUrl) URL.revokeObjectURL(portraitUrl);
  }, [portraitUrl]);

  useEffect(() => {
    onPortraitReady?.(Boolean(portraitFile));
  }, [onPortraitReady, portraitFile]);

  const fullFit = fit?.full_wig || DEFAULT_TRY_ON_FIT.full_wig;

  const patchFit = useCallback((patch) => {
    setFit((previous) => ({
      ...(previous || DEFAULT_TRY_ON_FIT),
      full_wig: {
        ...DEFAULT_TRY_ON_FIT.full_wig,
        ...(previous?.full_wig || {}),
        ...patch,
      },
    }));
  }, [setFit]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const portrait = portraitImageRef.current;
    const wig = wigImageRef.current;
    if (!canvas || !portrait?.complete || !portrait.naturalWidth) return;

    const maxSide = 1100;
    const scaleToCanvas = Math.min(
      1,
      maxSide / Math.max(portrait.naturalWidth, portrait.naturalHeight),
    );
    const width = Math.max(1, Math.round(portrait.naturalWidth * scaleToCanvas));
    const height = Math.max(1, Math.round(portrait.naturalHeight * scaleToCanvas));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const context = canvas.getContext('2d');
    context.clearRect(0, 0, width, height);
    context.drawImage(portrait, 0, 0, width, height);
    if (!wig?.complete || !wig.naturalWidth || !fullFit.visible) return;

    let faceCenterX = width * 0.5;
    let foreheadY = height * 0.25;
    let faceWidth = width * 0.34;
    if (landmarks?.length) {
      const left = landmarks[234];
      const right = landmarks[454];
      const forehead = landmarks[10];
      faceCenterX = ((left.x + right.x) / 2) * width;
      foreheadY = forehead.y * height;
      faceWidth = Math.max(40, Math.hypot(
        (right.x - left.x) * width,
        (right.y - left.y) * height,
      ));
    }

    const targetWidth = faceWidth * 1.82 * Number(fullFit.scale || 1);
    const targetHeight = targetWidth * (wig.naturalHeight / wig.naturalWidth);
    const centerX = faceCenterX + (Number(fullFit.offsetX || 0) * faceWidth);
    const topY = foreheadY - (targetHeight * 0.22) + (Number(fullFit.offsetY || 0) * faceWidth);
    const centerY = topY + (targetHeight / 2);

    context.save();
    context.globalAlpha = Number(fullFit.opacity ?? 1);
    context.translate(centerX, centerY);
    context.rotate((Number(fullFit.rotation || 0) * Math.PI) / 180);
    context.drawImage(
      wig,
      -targetWidth / 2,
      -targetHeight / 2,
      targetWidth,
      targetHeight,
    );
    context.restore();
  }, [fullFit, landmarks]);

  useEffect(() => {
    draw();
  }, [draw, portraitUrl, wigImageUrl]);

  const handlePortraitLoad = useCallback(async () => {
    draw();
    const image = portraitImageRef.current;
    if (!image) return;
    setDetectionState('detecting');
    setMessage('Finding face landmarks locally...');
    try {
      const landmarker = await getFaceLandmarker();
      const result = landmarker.detect(image);
      const detected = result?.faceLandmarks?.[0] || null;
      setLandmarks(detected);
      if (detected) {
        setDetectionState('ready');
        setMessage('Face detected. Fine-tune the wig if needed.');
      } else {
        setDetectionState('manual');
        setMessage('No face detected. You can still position the wig manually.');
      }
    } catch (error) {
      setLandmarks(null);
      setDetectionState('manual');
      setMessage(error?.message || 'Face detection unavailable; use manual controls.');
    }
  }, [draw]);

  const resetFit = () => {
    setFit({
      full_wig: { ...DEFAULT_TRY_ON_FIT.full_wig },
    });
  };

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <ScanFace size={18} className="text-slate-800" />
            <h3 className="text-sm font-semibold text-slate-900">Private photo try-on</h3>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            Your portrait stays in this browser and is never uploaded.
          </p>
        </div>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          <Upload size={14} /> {portraitFile ? 'Replace portrait' : 'Upload portrait'}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0] || null;
            setPortraitFile(file);
            setLandmarks(null);
            setDetectionState(file ? 'loading' : 'idle');
            setMessage(file ? 'Loading portrait...' : 'Upload a clear, front-facing portrait.');
          }}
        />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(250px,0.7fr)]">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-slate-950">
          {portraitUrl ? (
            <div className="relative">
              <canvas ref={canvasRef} className="block max-h-[560px] w-full object-contain" />
              <img
                ref={portraitImageRef}
                src={portraitUrl}
                alt=""
                className="hidden"
                onLoad={handlePortraitLoad}
              />
              <img
                ref={wigImageRef}
                src={wigImageUrl}
                alt=""
                crossOrigin="anonymous"
                className="hidden"
                onLoad={draw}
              />
              <div className="absolute bottom-3 left-3 rounded-full bg-black/65 px-3 py-1 text-[11px] text-white backdrop-blur">
                {detectionState === 'detecting' || detectionState === 'loading' ? (
                  <Loader2 size={11} className="mr-1 inline animate-spin" />
                ) : (
                  <ScanFace size={11} className="mr-1 inline" />
                )}
                {message}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="flex min-h-[360px] w-full flex-col items-center justify-center gap-3 text-slate-300 hover:bg-slate-900"
            >
              <span className="rounded-full bg-white/10 p-4">
                <ImagePlus size={28} />
              </span>
              <span className="text-sm font-semibold">Upload a front-facing portrait</span>
              <span className="max-w-xs text-xs text-slate-400">
                Use even lighting, keep your full head visible, and face the camera.
              </span>
            </button>
          )}
        </div>

        <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-semibold text-slate-800">Fit controls</p>
              <p className="text-[11px] text-slate-500">Auto-positioned from face landmarks</p>
            </div>
            <button
              type="button"
              onClick={resetFit}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-slate-600 hover:bg-white"
            >
              <RotateCcw size={12} /> Reset
            </button>
          </div>
          <Slider
            label="Size"
            value={fullFit.scale}
            min={0.55}
            max={1.8}
            step={0.01}
            onChange={(value) => patchFit({ scale: value })}
          />
          <Slider
            label="Horizontal position"
            value={fullFit.offsetX}
            min={-1}
            max={1}
            step={0.01}
            onChange={(value) => patchFit({ offsetX: value })}
          />
          <Slider
            label="Vertical position"
            value={fullFit.offsetY}
            min={-1}
            max={1}
            step={0.01}
            onChange={(value) => patchFit({ offsetY: value })}
          />
          <Slider
            label="Rotation"
            value={fullFit.rotation}
            min={-35}
            max={35}
            step={1}
            suffix="°"
            onChange={(value) => patchFit({ rotation: value })}
          />
          <Slider
            label="Opacity"
            value={fullFit.opacity}
            min={0.35}
            max={1}
            step={0.01}
            onChange={(value) => patchFit({ opacity: value })}
          />
          <p className="rounded-lg border border-slate-200 bg-white p-3 text-[11px] leading-relaxed text-slate-500">
            This is a fast local placement preview, not a generated photo. It preserves
            the real wig image and avoids changing the person&apos;s face.
          </p>
        </div>
      </div>
    </section>
  );
}
