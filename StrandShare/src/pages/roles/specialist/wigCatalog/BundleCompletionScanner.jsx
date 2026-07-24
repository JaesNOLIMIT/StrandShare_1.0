import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Camera,
  CameraOff,
  CheckCircle2,
  ImagePlus,
  Loader2,
  ScanLine,
  X,
} from 'lucide-react';
import jsQR from 'jsqr';

import { parseBundleWaybillQrPayload } from '../../../../lib/hairSubmissionWorkflow';

const MAX_DECODE_WIDTH = 960;
const CAMERA_SCAN_INTERVAL_MS = 240;
const INVALID_QR_NOTICE_COOLDOWN_MS = 2500;

function displayWaybill(parsed, fallback = '') {
  return String(parsed?.bundleWaybillCode || fallback || '').trim().toUpperCase();
}

function drawSourceToCanvas(canvas, source, sourceWidth, sourceHeight) {
  const scale = Math.min(1, MAX_DECODE_WIDTH / Math.max(1, sourceWidth));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, width, height);
  return { context, width, height };
}

async function decodeCanvas(canvas, context, width, height, nativeDetector) {
  if (nativeDetector) {
    try {
      const detections = await nativeDetector.detect(canvas);
      const nativeValue = String(detections?.[0]?.rawValue || '').trim();
      if (nativeValue) return nativeValue;
    } catch {
      // Some browsers expose BarcodeDetector but reject canvas input.
    }
  }

  const frame = context.getImageData(0, 0, width, height);
  return String(jsQR(frame.data, width, height, {
    inversionAttempts: 'attemptBoth',
  })?.data || '').trim();
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('The selected image could not be opened.'));
    };
    image.src = objectUrl;
  });
}

export default function BundleCompletionScanner({
  open,
  manualCode,
  saving,
  error,
  success,
  onManualCodeChange,
  onSubmit,
  onClose,
  primaryColor,
}) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scannerCanvasRef = useRef(null);
  const nativeDetectorRef = useRef(null);
  const isFrameProcessingRef = useRef(false);
  const lastInvalidQrRef = useRef({ value: '', at: 0 });
  const fileInputRef = useRef(null);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [isReadingImage, setIsReadingImage] = useState(false);
  const [cameraStatus, setCameraStatus] = useState({
    kind: 'info',
    message: 'Start the camera, upload a QR image, or enter the bundle waybill code.',
  });

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setIsCameraOn(false);
  }, []);

  const submitBundlePayload = useCallback(async (rawValue, { stopAfterRead = false } = {}) => {
    const value = String(rawValue || '').trim();
    const parsed = parseBundleWaybillQrPayload(value);

    if (!parsed) {
      setCameraStatus({
        kind: 'warning',
        message: 'A QR was detected, but it is not a Donivra bundle waybill. Try the bundle QR again.',
      });
      return false;
    }

    const waybillLabel = displayWaybill(parsed, value);
    if (waybillLabel) onManualCodeChange?.(waybillLabel);

    if (stopAfterRead) stopCamera();
    setCameraStatus({
      kind: 'info',
      message: `${waybillLabel || 'Bundle QR'} detected. Verifying and updating inventory...`,
    });

    const completed = await onSubmit?.(value);
    if (completed) {
      setCameraStatus({
        kind: 'success',
        message: `${waybillLabel || 'Bundle QR'} was completed successfully. The scanner stopped to prevent a duplicate scan.`,
      });
      return true;
    }

    setCameraStatus({
      kind: 'error',
      message: 'The QR was read, but the bundle was not completed. Review the error below, then try again.',
    });
    return false;
  }, [onManualCodeChange, onSubmit, stopCamera]);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus({
        kind: 'error',
        message: 'Camera scanning is unavailable in this browser. Upload the QR image or enter its WB code.',
      });
      return;
    }

    setIsStartingCamera(true);
    setCameraStatus({ kind: 'info', message: 'Starting the camera...' });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.muted = true;
        videoRef.current.playsInline = true;
        await videoRef.current.play();
      }
      setIsCameraOn(true);
      setCameraStatus({
        kind: 'success',
        message: 'Scanner is ready. Keep the whole QR inside the red guide and hold it still.',
      });
    } catch (cameraError) {
      stopCamera();
      setCameraStatus({
        kind: 'error',
        message: cameraError?.message || 'The camera could not be opened.',
      });
    } finally {
      setIsStartingCamera(false);
    }
  }, [stopCamera]);

  const toggleCamera = useCallback(async () => {
    if (isCameraOn) {
      stopCamera();
      setCameraStatus({
        kind: 'info',
        message: 'Camera stopped. You can restart it, upload a QR image, or enter the WB code.',
      });
      return;
    }
    await startCamera();
  }, [isCameraOn, startCamera, stopCamera]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.BarcodeDetector) return;
    try {
      nativeDetectorRef.current = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch {
      nativeDetectorRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!open || !isCameraOn) return undefined;

    const intervalId = window.setInterval(async () => {
      const video = videoRef.current;
      if (
        !video
        || video.readyState < 2
        || saving
        || isFrameProcessingRef.current
      ) {
        return;
      }

      const sourceWidth = video.videoWidth;
      const sourceHeight = video.videoHeight;
      if (!sourceWidth || !sourceHeight) return;

      isFrameProcessingRef.current = true;
      try {
        if (!scannerCanvasRef.current) {
          scannerCanvasRef.current = document.createElement('canvas');
        }
        const canvas = scannerCanvasRef.current;
        const drawn = drawSourceToCanvas(
          canvas,
          video,
          sourceWidth,
          sourceHeight,
        );
        if (!drawn) return;

        const decoded = await decodeCanvas(
          canvas,
          drawn.context,
          drawn.width,
          drawn.height,
          nativeDetectorRef.current,
        );
        if (!decoded) return;

        const parsed = parseBundleWaybillQrPayload(decoded);
        if (!parsed) {
          const now = Date.now();
          if (
            lastInvalidQrRef.current.value !== decoded
            || now - lastInvalidQrRef.current.at > INVALID_QR_NOTICE_COOLDOWN_MS
          ) {
            lastInvalidQrRef.current = { value: decoded, at: now };
            setCameraStatus({
              kind: 'warning',
              message: 'That QR is readable, but it is not a Donivra bundle waybill.',
            });
          }
          return;
        }

        await submitBundlePayload(decoded, { stopAfterRead: true });
      } catch {
        // Ignore individual video-frame failures and keep scanning.
      } finally {
        isFrameProcessingRef.current = false;
      }
    }, CAMERA_SCAN_INTERVAL_MS);

    return () => window.clearInterval(intervalId);
  }, [isCameraOn, open, saving, submitBundlePayload]);

  const handleImageUpload = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setIsReadingImage(true);
    setCameraStatus({ kind: 'info', message: 'Reading the selected QR image...' });
    try {
      const image = await loadImageFile(file);
      if (!scannerCanvasRef.current) {
        scannerCanvasRef.current = document.createElement('canvas');
      }
      const canvas = scannerCanvasRef.current;
      const drawn = drawSourceToCanvas(
        canvas,
        image,
        image.naturalWidth,
        image.naturalHeight,
      );
      if (!drawn) throw new Error('The QR image could not be processed.');

      const decoded = await decodeCanvas(
        canvas,
        drawn.context,
        drawn.width,
        drawn.height,
        nativeDetectorRef.current,
      );
      if (!decoded) {
        setCameraStatus({
          kind: 'warning',
          message: 'No readable QR was found in that image. Use a sharper, well-lit image with the entire code visible.',
        });
        return;
      }
      await submitBundlePayload(decoded, { stopAfterRead: true });
    } catch (imageError) {
      setCameraStatus({
        kind: 'error',
        message: imageError?.message || 'The QR image could not be read.',
      });
    } finally {
      setIsReadingImage(false);
    }
  }, [submitBundlePayload]);

  const submitManualCode = useCallback(async () => {
    const value = String(manualCode || '').trim();
    if (!value || saving) return;
    await submitBundlePayload(value, { stopAfterRead: true });
  }, [manualCode, saving, submitBundlePayload]);

  useEffect(() => {
    if (open) return undefined;
    stopCamera();
    setCameraStatus({
      kind: 'info',
      message: 'Start the camera, upload a QR image, or enter the bundle waybill code.',
    });
    return undefined;
  }, [open, stopCamera]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  if (!open) return null;

  const cameraTone = cameraStatus.kind === 'error'
    ? 'border-red-200 bg-red-50 text-red-700'
    : cameraStatus.kind === 'success'
      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
      : cameraStatus.kind === 'warning'
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-sky-200 bg-sky-50 text-sky-700';

  const modal = (
    <div
      className="fixed inset-0 z-[2147483000] m-0 flex h-screen w-screen items-center justify-center overflow-y-auto bg-slate-950/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bundle-scanner-title"
    >
      <div className="w-full max-w-3xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
              Wig catalog stock scanner
            </p>
            <h2 id="bundle-scanner-title" className="mt-1 text-lg font-semibold text-slate-900">
              Scan Completed Bundle
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              Scan the bundle waybill—not a donor QR—to complete the selected wig variant.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-full p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
            aria-label="Close bundle scanner"
          >
            <X size={17} />
          </button>
        </div>

        <div className="space-y-4 p-5">
          <div className="grid gap-4 md:grid-cols-[minmax(300px,1.1fr),minmax(280px,0.9fr)]">
            <div className="space-y-2">
              <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-950">
                <div className="relative aspect-[4/3]">
                  <video
                    ref={videoRef}
                    className={`h-full w-full bg-black object-contain ${isCameraOn ? '' : 'hidden'}`}
                    autoPlay
                    playsInline
                    muted
                  />
                  {!isCameraOn ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-5 text-center text-slate-300">
                      <ScanLine size={34} />
                      <p className="text-xs">Camera preview</p>
                      <p className="max-w-[220px] text-[10px] text-slate-400">
                        The full QR must be visible and in focus.
                      </p>
                    </div>
                  ) : (
                    <div className="pointer-events-none absolute inset-[12%]">
                      <span className="scanner-corner absolute left-0 top-0 h-7 w-7 border-l-2 border-t-2" />
                      <span className="scanner-corner absolute right-0 top-0 h-7 w-7 border-r-2 border-t-2" />
                      <span className="scanner-corner absolute bottom-0 left-0 h-7 w-7 border-b-2 border-l-2" />
                      <span className="scanner-corner absolute bottom-0 right-0 h-7 w-7 border-b-2 border-r-2" />
                      <span className="scanner-beam" />
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => { void toggleCamera(); }}
                  disabled={saving || isStartingCamera || isReadingImage}
                  className="inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
                  style={{ backgroundColor: isCameraOn ? '#dc2626' : (primaryColor || '#0f172a') }}
                >
                  {isStartingCamera ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : isCameraOn ? (
                    <CameraOff size={14} />
                  ) : (
                    <Camera size={14} />
                  )}
                  {isCameraOn ? 'Stop camera' : 'Start camera'}
                </button>

                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={saving || isReadingImage}
                  className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
                >
                  {isReadingImage ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <ImagePlus size={14} />
                  )}
                  Upload QR image
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={handleImageUpload}
                  className="hidden"
                />
              </div>
            </div>

            <div className="space-y-3">
              <div className={`rounded-lg border px-3 py-2.5 text-xs ${cameraTone}`}>
                <span className="flex items-start gap-2">
                  {cameraStatus.kind === 'success' ? (
                    <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
                  ) : (
                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  )}
                  {cameraStatus.message}
                </span>
              </div>

              <div>
                <label htmlFor="bundle-waybill-code" className="text-xs font-semibold text-slate-700">
                  Bundle waybill code
                </label>
                <div className="mt-1 flex gap-2">
                  <input
                    id="bundle-waybill-code"
                    type="text"
                    value={manualCode}
                    onChange={(event) => onManualCodeChange?.(event.target.value.toUpperCase())}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void submitManualCode();
                      }
                    }}
                    placeholder="WB + 6 characters"
                    disabled={saving}
                    autoComplete="off"
                    spellCheck="false"
                    className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold uppercase tracking-wide"
                  />
                  <button
                    type="button"
                    onClick={() => { void submitManualCode(); }}
                    disabled={saving || !String(manualCode || '').trim()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-45"
                  >
                    {saving ? <Loader2 size={13} className="animate-spin" /> : <ScanLine size={13} />}
                    Complete
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-slate-500">
                  Example: WB12AB34. The printed QR contains this same bundle code.
                </p>
              </div>

              <div className="rounded-lg bg-slate-50 p-3 text-[11px] leading-relaxed text-slate-600">
                A valid scan adds <strong>+1</strong> only to the wig specification selected
                during bundling. It marks the bundle and all linked submissions as
                <strong> Wig Created</strong>. The scanner stops immediately after reading one
                valid QR to prevent duplicate submissions.
              </div>
            </div>
          </div>

          {error ? (
            <p className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-xs text-red-700">
              <AlertCircle size={14} className="mt-0.5 shrink-0" />
              {error}
            </p>
          ) : null}

          {success ? (
            <p className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-xs text-emerald-700">
              <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
              {success}
            </p>
          ) : null}
        </div>

        <div className="flex justify-end border-t border-slate-200 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return modal;
  return createPortal(modal, document.body);
}
