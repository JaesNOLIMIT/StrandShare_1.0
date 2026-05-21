import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Boxes,
  Camera,
  CameraOff,
  CheckCircle2,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  ScanLine,
  Trash2,
  Upload,
} from 'lucide-react';
import jsQR from 'jsqr';
import { useTheme } from '../../../context/ThemeContext';
import { isSupabaseConfigured, supabase } from '../../../lib/supabaseClient';
import { logAuditAction } from '../../../lib/auditLogger';
import {
  HAIR_BUNDLE_STATUS,
  completeWigBundle,
  parseBundleWaybillQrPayload,
} from '../../../lib/hairSubmissionWorkflow';

const HAIR_SUBMISSION_BUNDLES_TABLE = 'Hair_Submission_Bundles';
const HAIR_SUBMISSIONS_TABLE = 'Hair_Submissions';
const WIGS_TABLE = 'Wigs';
const WIG_SPECIFICATIONS_TABLE = 'Wig_Specifications';
const COMPLETED_WIGS_BUCKET = 'completed_wigs';
const SCAN_DEBOUNCE_MS = 2500;

const TABS = [
  { id: 'complete', label: 'Complete Wig from Bundle', icon: ScanLine },
  { id: 'inventory', label: 'Inventory', icon: Boxes },
];

const TEXTURE_OPTIONS = ['Straight', 'Wavy', 'Curly', 'Coily'];
const COLOR_OPTIONS = ['Black', 'Dark Brown', 'Light Brown', 'Auburn', 'Blonde', 'Grey'];
const CAP_SIZE_OPTIONS = [
  { value: 'Small', label: 'Small (21-21.5 inches)' },
  { value: 'Medium', label: 'Medium (22-22.5 inches)' },
  { value: 'Large', label: 'Large (23-23.5 inches)' },
];
const WIG_STATUS_OPTIONS = ['In Production', 'Ready for Release', 'Wig Allocated', 'Releasing', 'Released'];

function withColorAlpha(colorValue, alpha, fallback = '#0275d8') {
  const safeAlpha = Math.max(0, Math.min(1, Number.isFinite(alpha) ? alpha : 1));
  const input = String(colorValue || '').trim();
  const hexMatch = input.match(/^#([0-9a-f]{6})$/i);
  if (hexMatch) {
    const r = parseInt(hexMatch[1].slice(0, 2), 16);
    const g = parseInt(hexMatch[1].slice(2, 4), 16);
    const b = parseInt(hexMatch[1].slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${safeAlpha})`;
  }
  return withColorAlpha(fallback, safeAlpha, '#0275d8');
}

function safeFileName(name) {
  return String(name || '').trim().replace(/[^a-zA-Z0-9._-]/g, '-').slice(-80) || 'wig.jpg';
}

function fileExtension(file) {
  const name = String(file?.name || '').toLowerCase();
  const lastDot = name.lastIndexOf('.');
  if (lastDot < 0) return 'jpg';
  const ext = name.slice(lastDot + 1).replace(/[^a-z0-9]/g, '');
  return ext || 'jpg';
}

function formatDateTime(value) {
  if (!value) return 'N/A';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'N/A';
  return parsed.toLocaleString('en-PH', { timeZone: 'Asia/Manila', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function normalizeSpecValue(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeWigStatus(value) {
  const key = String(value || '').trim().toLowerCase();
  if (!key) return 'In Production';
  if (key === 'in production' || key === 'in_production') return 'In Production';
  if (key === 'ready for release' || key === 'ready_for_release' || key === 'available') return 'Ready for Release';
  if (key === 'wig allocated' || key === 'wig_allocated' || key === 'allocated') return 'Wig Allocated';
  if (key === 'releasing') return 'Releasing';
  if (key === 'released') return 'Released';
  return 'In Production';
}

function isBundleCompletedStatus(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_\s-]+/g, ' ');
  return normalized === 'wig completed' || normalized === 'wig created';
}

function buildSpecSignature(row) {
  const lengthValue = row?.Hair_Length === null || row?.Hair_Length === undefined ? '' : String(row.Hair_Length).trim();
  return [
    lengthValue,
    normalizeSpecValue(row?.Hair_Color),
    normalizeSpecValue(row?.Hair_Texture),
    normalizeSpecValue(row?.Hair_Density),
    normalizeSpecValue(row?.Style),
    normalizeSpecValue(row?.Cap_Size),
  ].join('|');
}

function isEmptySpecSignature(signature) {
  return !String(signature || '').replace(/\|/g, '').trim();
}

function isCountedAsAvailableStock(wigStatusValue) {
  const status = normalizeWigStatus(wigStatusValue);
  return status === 'In Production' || status === 'Ready for Release';
}

const initialPhotoState = { file: null, previewUrl: '' };

export default function UploadWigStocksPage({ userProfile }) {
  const { theme } = useTheme();
  const primaryColor = theme?.primaryColor || '#0275d8';
  const tertiaryColor = theme?.tertiaryColor || '#10b981';
  const primaryTextColor = theme?.primaryTextColor || '#0f172a';
  const secondaryTextColor = theme?.secondaryTextColor || '#64748b';
  const tertiaryTextColor = theme?.tertiaryTextColor || '#94a3b8';
  const headingFont = theme?.secondaryFontFamily || theme?.fontFamily || 'Poppins';
  const bodyFont = theme?.fontFamily || 'Poppins';

  const rootStyle = { color: primaryTextColor, fontFamily: `${bodyFont}, sans-serif` };
  const headingStyle = { color: primaryTextColor, fontFamily: `${headingFont}, sans-serif` };
  const labelStyle = { color: primaryTextColor };
  const inputStyle = { color: primaryTextColor, fontFamily: `${bodyFont}, sans-serif` };

  const [activeTab, setActiveTab] = useState(TABS[0].id);
  const [notice, setNotice] = useState({ kind: '', text: '' });

  // ----- Tab 1: Complete Wig from Bundle -----
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scannerCanvasRef = useRef(null);
  const lastScanRef = useRef({ raw: '', at: 0 });
  const isScanProcessingRef = useRef(false);
  const [isCameraOn, setIsCameraOn] = useState(false);
  const [isStartingCamera, setIsStartingCamera] = useState(false);
  const [cameraStatus, setCameraStatus] = useState({ tone: 'info', message: 'Camera is off. Turn on to scan a bundle waybill.' });
  const [pendingBundles, setPendingBundles] = useState([]);
  const [scannedBundle, setScannedBundle] = useState(null);
  const [bundleMemberCount, setBundleMemberCount] = useState(0);
  const [photoFront, setPhotoFront] = useState(initialPhotoState);
  const [photoSide, setPhotoSide] = useState(initialPhotoState);
  const [photoTop, setPhotoTop] = useState(initialPhotoState);
  const [wigForm, setWigForm] = useState({
    wigName: '',
    hairLength: '',
    hairColor: '',
    hairTexture: '',
    hairDensity: '',
    hairStyle: '',
    capSize: '',
    notes: '',
  });
  const [isCompletingWig, setIsCompletingWig] = useState(false);
  const [manualCode, setManualCode] = useState('');

  // ----- Tab 3: Inventory -----
  const [inventory, setInventory] = useState([]);
  const [isLoadingInventory, setIsLoadingInventory] = useState(false);
  const [updatingStatusByWigId, setUpdatingStatusByWigId] = useState({});

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  // ----- Loading: pending bundles + inventory -----
  const loadPendingBundles = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    try {
      const result = await supabase
        .from(HAIR_SUBMISSION_BUNDLES_TABLE)
        .select('Bundle_ID, Status, Bundle_Waybill_Code, Notes, Created_At')
        .eq('Status', HAIR_BUNDLE_STATUS.IN_PRODUCTION)
        .order('Created_At', { ascending: true });
      if (result.error) throw result.error;
      setPendingBundles(result.data || []);
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to load pending bundles.' });
    }
  }, []);

  const loadInventory = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) return;
    setIsLoadingInventory(true);
    try {
      const wigsResult = await supabase
        .from(WIGS_TABLE)
        .select('Wig_ID, Wig_Code, Wig_Name, Bundle_ID, Total_Donated_Hairs, Total_Bundles_Used, Wig_Status, Completed_At, Added_By, Production_Notes, Wig_Front_Image_Path, Wig_Side_Image_Path, Wig_Top_Image_Path')
        .order('Completed_At', { ascending: false, nullsFirst: false })
        .limit(300);
      if (wigsResult.error) throw wigsResult.error;
      const wigRows = wigsResult.data || [];

      const wigIds = Array.from(new Set(wigRows.map((row) => Number(row.Wig_ID || 0)).filter(Boolean)));
      const specsByWigId = new Map();
      if (wigIds.length) {
        const specsResult = await supabase
          .from(WIG_SPECIFICATIONS_TABLE)
          .select('Wig_ID, Hair_Length, Hair_Color, Hair_Texture, Hair_Density, Style, Cap_Size')
          .in('Wig_ID', wigIds);
        if (specsResult.error) throw specsResult.error;
        (specsResult.data || []).forEach((row) => {
          specsByWigId.set(Number(row.Wig_ID), row);
        });
      }

      const stockCountBySignature = new Map();
      const withSpecs = wigRows.map((row) => {
        const normalizedStatus = normalizeWigStatus(row.Wig_Status);
        const spec = specsByWigId.get(Number(row.Wig_ID)) || {};
        const merged = {
          ...row,
          Wig_Status: normalizedStatus,
          Hair_Length: spec.Hair_Length ?? null,
          Hair_Color: spec.Hair_Color ?? null,
          Hair_Texture: spec.Hair_Texture ?? null,
          Hair_Density: spec.Hair_Density ?? null,
          Style: spec.Style ?? null,
          Cap_Size: spec.Cap_Size ?? null,
        };
        const signature = buildSpecSignature(merged);
        if (!isEmptySpecSignature(signature) && isCountedAsAvailableStock(normalizedStatus)) {
          stockCountBySignature.set(signature, (stockCountBySignature.get(signature) || 0) + 1);
        }
        return merged;
      }).map((row) => {
        const signature = buildSpecSignature(row);
        const frontPhotoUrl = row.Wig_Front_Image_Path ? supabase.storage.from(COMPLETED_WIGS_BUCKET).getPublicUrl(row.Wig_Front_Image_Path).data?.publicUrl : '';
        const sidePhotoUrl = row.Wig_Side_Image_Path ? supabase.storage.from(COMPLETED_WIGS_BUCKET).getPublicUrl(row.Wig_Side_Image_Path).data?.publicUrl : '';
        const topPhotoUrl = row.Wig_Top_Image_Path ? supabase.storage.from(COMPLETED_WIGS_BUCKET).getPublicUrl(row.Wig_Top_Image_Path).data?.publicUrl : '';
        return {
          ...row,
          Stock_Count: isEmptySpecSignature(signature) ? 0 : (stockCountBySignature.get(signature) || 0),
          frontPhotoUrl,
          sidePhotoUrl,
          topPhotoUrl,
        };
      });

      setInventory(withSpecs);
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to load wig inventory.' });
    } finally {
      setIsLoadingInventory(false);
    }
  }, []);

  useEffect(() => {
    void loadPendingBundles();
    void loadInventory();
    return () => stopCamera();
  }, [loadInventory, loadPendingBundles, stopCamera]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return undefined;
    const channel = supabase
      .channel('qa-wig-stocks-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: WIGS_TABLE }, () => {
        void loadInventory();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: WIG_SPECIFICATIONS_TABLE }, () => {
        void loadInventory();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [loadInventory]);

  // ----- Scanner -----
  const loadBundleMembers = useCallback(async (bundleId) => {
    const result = await supabase
      .from(HAIR_SUBMISSIONS_TABLE)
      .select('Submission_ID')
      .eq('Bundle_ID', bundleId);
    if (!result.error) {
      setBundleMemberCount((result.data || []).length);
    } else {
      setBundleMemberCount(0);
    }
  }, []);

  const handleSelectBundle = useCallback(async (bundle) => {
    const code = bundle.Bundle_Waybill_Code || `WB${String(Number(bundle.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`;
    setScannedBundle(bundle);
    await loadBundleMembers(bundle.Bundle_ID);
    setCameraStatus({
      tone: 'success',
      message: `Bundle ${code} loaded. Upload front/side/top photos and fill the wig details below.`,
    });
  }, [loadBundleMembers]);

  const handleScannedText = useCallback(async (decodedText) => {
    if (isScanProcessingRef.current) return;
    isScanProcessingRef.current = true;
    try {
      const parsed = parseBundleWaybillQrPayload(decodedText);
      if (!parsed || (!parsed.bundleId && !parsed.bundleWaybillCode)) {
        setCameraStatus({ tone: 'error', message: 'Scan did not match a wig bundle waybill.' });
        return;
      }

      let lookup = null;
      if (parsed.bundleId) {
        lookup = await supabase
          .from(HAIR_SUBMISSION_BUNDLES_TABLE)
          .select('Bundle_ID, Status, Bundle_Waybill_Code, Notes, Created_At')
          .eq('Bundle_ID', parsed.bundleId)
          .maybeSingle();
      } else {
        lookup = await supabase
          .from(HAIR_SUBMISSION_BUNDLES_TABLE)
          .select('Bundle_ID, Status, Bundle_Waybill_Code, Notes, Created_At')
          .eq('Bundle_Waybill_Code', parsed.bundleWaybillCode)
          .maybeSingle();
      }

      if (lookup?.error) throw lookup.error;
      const bundle = lookup?.data;
      if (!bundle?.Bundle_ID) {
        setCameraStatus({ tone: 'error', message: `No bundle found for ${parsed.bundleWaybillCode || parsed.bundleId}.` });
        return;
      }
      const bundleCode = bundle.Bundle_Waybill_Code || `WB${String(Number(bundle.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`;

      const statusKey = String(bundle.Status || '').toLowerCase();
      if (isBundleCompletedStatus(statusKey)) {
        setCameraStatus({ tone: 'info', message: `Bundle ${bundleCode} is already Wig Created. No action available.` });
        return;
      }
      if (statusKey === HAIR_BUNDLE_STATUS.DRAFT.toLowerCase()) {
        setCameraStatus({ tone: 'warning', message: `Bundle ${bundleCode} is still a Draft. Finalize it on Bundling first.` });
        return;
      }

      await handleSelectBundle(bundle);
    } catch (error) {
      setCameraStatus({ tone: 'error', message: error?.message || 'Unable to load scanned bundle.' });
    } finally {
      isScanProcessingRef.current = false;
    }
  }, [handleSelectBundle]);

  const handleToggleCamera = async () => {
    if (isCameraOn) {
      stopCamera();
      setIsCameraOn(false);
      setCameraStatus({ tone: 'info', message: 'Camera is off. Turn on to scan a bundle waybill.' });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraStatus({ tone: 'error', message: 'Camera API is unavailable.' });
      return;
    }
    setIsStartingCamera(true);
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
      setCameraStatus({ tone: 'success', message: 'Scanner running. Point at a wig bundle waybill QR.' });
    } catch (error) {
      setCameraStatus({ tone: 'error', message: error?.message || 'Could not access camera.' });
    } finally {
      setIsStartingCamera(false);
    }
  };

  useEffect(() => {
    if (!isCameraOn || activeTab !== 'complete') return undefined;
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || isScanProcessingRef.current) return;
      const w = video.videoWidth, h = video.videoHeight;
      if (!w || !h) return;
      try {
        if (!scannerCanvasRef.current) scannerCanvasRef.current = document.createElement('canvas');
        const canvas = scannerCanvasRef.current;
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);
        const code = jsQR(imageData.data, w, h, { inversionAttempts: 'attemptBoth' });
        const decoded = String(code?.data || '').trim();
        if (!decoded) return;
        const now = Date.now();
        if (lastScanRef.current.raw === decoded && now - lastScanRef.current.at < SCAN_DEBOUNCE_MS) return;
        lastScanRef.current = { raw: decoded, at: now };
        void handleScannedText(decoded);
      } catch {
        // ignore
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [isCameraOn, activeTab, handleScannedText]);

  const handleSubmitManualCode = () => {
    const v = String(manualCode || '').trim();
    if (!v) return;
    setManualCode('');
    void handleScannedText(v);
  };

  // ----- Photos -----
  const handlePhotoChange = (slot, file) => {
    if (!file) return;
    const previewUrl = URL.createObjectURL(file);
    if (slot === 'front') {
      if (photoFront.previewUrl) URL.revokeObjectURL(photoFront.previewUrl);
      setPhotoFront({ file, previewUrl });
    } else if (slot === 'side') {
      if (photoSide.previewUrl) URL.revokeObjectURL(photoSide.previewUrl);
      setPhotoSide({ file, previewUrl });
    } else if (slot === 'top') {
      if (photoTop.previewUrl) URL.revokeObjectURL(photoTop.previewUrl);
      setPhotoTop({ file, previewUrl });
    }
  };

  const handleRemovePhoto = (slot) => {
    if (slot === 'front') {
      if (photoFront.previewUrl) URL.revokeObjectURL(photoFront.previewUrl);
      setPhotoFront(initialPhotoState);
    } else if (slot === 'side') {
      if (photoSide.previewUrl) URL.revokeObjectURL(photoSide.previewUrl);
      setPhotoSide(initialPhotoState);
    } else if (slot === 'top') {
      if (photoTop.previewUrl) URL.revokeObjectURL(photoTop.previewUrl);
      setPhotoTop(initialPhotoState);
    }
  };

  const resetCompleteWigForm = () => {
    setScannedBundle(null);
    setBundleMemberCount(0);
    handleRemovePhoto('front');
    handleRemovePhoto('side');
    handleRemovePhoto('top');
    setWigForm({ wigName: '', hairLength: '', hairColor: '', hairTexture: '', hairDensity: '', hairStyle: '', capSize: '', notes: '' });
  };

  const allPhotosUploaded = Boolean(photoFront.file && photoSide.file && photoTop.file);
  const canSubmitCompleteWig = Boolean(scannedBundle && allPhotosUploaded && wigForm.wigName.trim());

  const uploadOnePhoto = async (file, slotName) => {
    if (!file) return null;
    const sessionResult = await supabase.auth.getSession();
    const authFolder = sessionResult.data?.session?.user?.id;
    if (!authFolder) throw new Error('Could not resolve session for photo upload.');
    const ext = fileExtension(file);
    const bundleCode = scannedBundle.Bundle_Waybill_Code || `WB${String(Number(scannedBundle.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`;
    const fileName = `${bundleCode}-${slotName}-${Date.now()}-${safeFileName(file.name)}`.replace(/[^a-zA-Z0-9._-]/g, '-');
    const finalName = fileName.endsWith(`.${ext}`) ? fileName : `${fileName}.${ext}`;
    const path = `${authFolder}/completed-wigs/${finalName}`;
    const { error } = await supabase.storage.from(COMPLETED_WIGS_BUCKET).upload(path, file, { upsert: false });
    if (error) throw error;
    return path;
  };

  const handleSubmitCompleteWig = async () => {
    if (!scannedBundle) return;
    if (!allPhotosUploaded) {
      setNotice({ kind: 'warning', text: 'All three photos (front, side, top) are required.' });
      return;
    }
    if (!wigForm.wigName.trim()) {
      setNotice({ kind: 'warning', text: 'Wig name is required.' });
      return;
    }

    setIsCompletingWig(true);
    setNotice({ kind: '', text: '' });

    try {
      const [frontPath, sidePath, topPath] = await Promise.all([
        uploadOnePhoto(photoFront.file, 'front'),
        uploadOnePhoto(photoSide.file, 'side'),
        uploadOnePhoto(photoTop.file, 'top'),
      ]);

      const { data, error } = await completeWigBundle({
        bundleId: scannedBundle.Bundle_ID,
        completedBy: Number(userProfile?.user_id || 0) || null,
        frontImagePath: frontPath,
        sideImagePath: sidePath,
        topImagePath: topPath,
        wigName: wigForm.wigName,
        hairLength: wigForm.hairLength,
        hairColor: wigForm.hairColor,
        hairTexture: wigForm.hairTexture,
        hairDensity: wigForm.hairDensity,
        hairStyle: wigForm.hairStyle,
        capSize: wigForm.capSize,
        notes: wigForm.notes,
      });

      if (error) throw error;

      const memberCount = data?.members?.length || 0;
      const bundleCode = scannedBundle.Bundle_Waybill_Code || `WB${String(Number(scannedBundle.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`;
      setNotice({
        kind: 'success',
        text: data?.alreadyComplete
          ? `Bundle ${bundleCode} was already completed.`
          : `Wig "${wigForm.wigName.trim()}" registered from bundle ${bundleCode}. ${memberCount} donor${memberCount === 1 ? '' : 's'} notified.`,
      });

      await logAuditAction({
        action: 'wigs.completed_from_bundle',
        description: `Completed wig "${wigForm.wigName.trim()}" from bundle ${bundleCode}.`,
        resource: WIGS_TABLE,
        status: 'success',
        userProfile,
      });

      resetCompleteWigForm();
      await Promise.all([loadPendingBundles(), loadInventory()]);
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to complete wig.' });
    } finally {
      setIsCompletingWig(false);
    }
  };

  const handleUpdateWigStatus = async (wigId, nextStatus) => {
    const numericWigId = Number(wigId || 0);
    if (!numericWigId || !nextStatus) return;
    setUpdatingStatusByWigId((prev) => ({ ...prev, [numericWigId]: true }));
    try {
      const { error } = await supabase
        .from(WIGS_TABLE)
        .update({ Wig_Status: normalizeWigStatus(nextStatus) })
        .eq('Wig_ID', numericWigId);
      if (error) throw error;

      setInventory((prevRows) => {
        const updatedRows = prevRows.map((row) => (
          Number(row.Wig_ID) === numericWigId
            ? { ...row, Wig_Status: normalizeWigStatus(nextStatus) }
            : row
        ));
        const stockCountBySignature = new Map();
        updatedRows.forEach((row) => {
          const signature = buildSpecSignature(row);
          if (!isEmptySpecSignature(signature) && isCountedAsAvailableStock(row.Wig_Status)) {
            stockCountBySignature.set(signature, (stockCountBySignature.get(signature) || 0) + 1);
          }
        });
        return updatedRows.map((row) => {
          const signature = buildSpecSignature(row);
          return {
            ...row,
            Stock_Count: isEmptySpecSignature(signature) ? 0 : (stockCountBySignature.get(signature) || 0),
          };
        });
      });
    } catch (error) {
      setNotice({ kind: 'error', text: error?.message || 'Unable to update wig status.' });
    } finally {
      setUpdatingStatusByWigId((prev) => ({ ...prev, [numericWigId]: false }));
    }
  };

  const cameraNoticeStyle = (() => {
    switch (cameraStatus.tone) {
      case 'success':
        return { backgroundColor: withColorAlpha(tertiaryColor, 0.14), color: tertiaryColor, borderColor: withColorAlpha(tertiaryColor, 0.5) };
      case 'error':
        return { backgroundColor: '#fef2f2', color: '#b91c1c', borderColor: '#fecaca' };
      case 'warning':
        return { backgroundColor: '#fffbeb', color: '#b45309', borderColor: '#fde68a' };
      default:
        return { backgroundColor: withColorAlpha(primaryColor, 0.12), color: primaryColor, borderColor: withColorAlpha(primaryColor, 0.45) };
    }
  })();

  const photoSlot = (slotName, label, photo) => (
    <div className="rounded-xl border bg-slate-50 p-3" style={{ borderColor: '#e2e8f0' }}>
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-bold uppercase tracking-wide" style={{ color: secondaryTextColor }}>{label}</p>
        {photo.file ? (
          <button type="button" onClick={() => handleRemovePhoto(slotName)} className="text-xs font-semibold inline-flex items-center gap-1" style={{ color: '#b91c1c' }}>
            <Trash2 size={12} />
            Remove
          </button>
        ) : null}
      </div>
      <div className="aspect-square w-full overflow-hidden rounded-lg bg-white flex items-center justify-center" style={{ border: `1px dashed ${withColorAlpha(primaryColor, 0.3)}` }}>
        {photo.previewUrl ? (
          <img src={photo.previewUrl} alt={label} className="h-full w-full object-cover" />
        ) : (
          <div className="text-center px-3" style={{ color: tertiaryTextColor }}>
            <ImageIcon className="mx-auto mb-1" size={28} />
            <p className="text-xs">No photo</p>
          </div>
        )}
      </div>
      <label className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg border bg-white px-3 py-1.5 text-xs font-semibold cursor-pointer" style={{ borderColor: withColorAlpha(primaryColor, 0.35), color: primaryColor }}>
        <Upload size={12} />
        {photo.file ? 'Replace' : 'Choose'} photo
        <input
          type="file"
          accept="image/*"
          onChange={(e) => handlePhotoChange(slotName, e.target.files?.[0] || null)}
          className="hidden"
        />
      </label>
    </div>
  );

  return (
    <div className="space-y-6" style={rootStyle}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold mb-2" style={headingStyle}>Upload Wig Stocks</h1>
          <p style={{ color: secondaryTextColor }}>
            Scan a wig bundle waybill to register completed wigs and manage live stock availability by specification.
          </p>
        </div>
        <button
          type="button"
          onClick={() => { void loadPendingBundles(); void loadInventory(); }}
          disabled={isLoadingInventory}
          className="inline-flex items-center gap-2 rounded-xl border bg-white px-3.5 py-2 text-sm font-semibold disabled:opacity-60"
          style={{ borderColor: withColorAlpha(primaryColor, 0.35), color: primaryColor }}
        >
          {isLoadingInventory ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Refresh
        </button>
      </header>

      {notice.text && (
        <div
          className="rounded-xl border px-3 py-2 text-sm font-medium"
          style={
            notice.kind === 'error' ? { borderColor: '#fecaca', backgroundColor: '#fef2f2', color: '#b91c1c' }
              : notice.kind === 'success' ? { borderColor: '#a7f3d0', backgroundColor: '#ecfdf5', color: '#047857' }
                : { borderColor: '#fde68a', backgroundColor: '#fffbeb', color: '#b45309' }
          }
        >
          {notice.text}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className="inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold transition"
              style={
                isActive
                  ? { borderColor: primaryColor, backgroundColor: withColorAlpha(primaryColor, 0.1), color: primaryColor }
                  : { borderColor: '#e2e8f0', backgroundColor: '#ffffff', color: secondaryTextColor }
              }
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'complete' ? (
        <div className="space-y-6">
          <section className="rounded-2xl border bg-white p-5" style={{ borderColor: '#e2e8f0' }}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ScanLine size={18} style={{ color: primaryColor }} />
                <h2 className="text-lg font-semibold" style={headingStyle}>Bundle Waybill Scanner</h2>
              </div>
              <button
                type="button"
                onClick={handleToggleCamera}
                disabled={isStartingCamera}
                className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
                style={{ backgroundColor: isCameraOn ? '#dc2626' : tertiaryColor }}
              >
                {isStartingCamera ? <Loader2 className="animate-spin" size={16} /> : isCameraOn ? <CameraOff size={16} /> : <Camera size={16} />}
                {isCameraOn ? 'Turn Camera Off' : 'Turn Camera On'}
              </button>
            </div>

            <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div>
                <div className="aspect-square w-full max-w-md mx-auto overflow-hidden rounded-xl bg-gray-900 flex items-center justify-center">
                  <video ref={videoRef} className={`h-full w-full object-cover ${isCameraOn ? '' : 'hidden'}`} autoPlay playsInline muted />
                  {!isCameraOn ? (
                    <div className="text-center px-6" style={{ color: '#cbd5e1' }}>
                      <Camera className="mx-auto mb-2 opacity-60" size={36} />
                      <p className="text-sm">Camera preview will appear here.</p>
                    </div>
                  ) : null}
                </div>

                <div className="mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm" style={cameraNoticeStyle}>
                  <AlertCircle size={16} className="mt-0.5 shrink-0" />
                  <span>{cameraStatus.message}</span>
                </div>

                <div className="mt-3">
                  <label className="block text-xs font-semibold mb-1" style={{ color: secondaryTextColor }}>Or enter bundle code manually</label>
                  <div className="flex gap-2">
                    <input
                      value={manualCode}
                      onChange={(event) => setManualCode(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); handleSubmitManualCode(); } }}
                      placeholder="WB7K2Q9A"
                      className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none"
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={handleSubmitManualCode}
                      disabled={!String(manualCode || '').trim()}
                      className="rounded-lg px-3 py-2 text-sm font-semibold text-white disabled:opacity-60"
                      style={{ backgroundColor: primaryColor }}
                    >
                      Lookup
                    </button>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border bg-slate-50 p-4 max-h-[400px] overflow-y-auto" style={{ borderColor: '#e2e8f0' }}>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold" style={headingStyle}>In Production Bundles</h3>
                  <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ backgroundColor: withColorAlpha(primaryColor, 0.12), color: primaryColor }}>
                    {pendingBundles.length}
                  </span>
                </div>
                {!pendingBundles.length ? (
                  <p className="text-xs" style={{ color: secondaryTextColor }}>No bundles waiting for wig completion.</p>
                ) : (
                  <div className="space-y-2">
                    {pendingBundles.map((b) => {
                      const isActive = scannedBundle?.Bundle_ID === b.Bundle_ID;
                      return (
                        <button
                          key={b.Bundle_ID}
                          type="button"
                          onClick={() => handleSelectBundle(b)}
                          className="w-full rounded-lg border bg-white px-3 py-2 text-left transition"
                          style={
                            isActive
                              ? { borderColor: primaryColor, backgroundColor: withColorAlpha(primaryColor, 0.08) }
                              : { borderColor: '#e2e8f0' }
                          }
                        >
                          <p className="font-mono text-xs font-semibold" style={{ color: primaryTextColor }}>{b.Bundle_Waybill_Code || `WB${String(Number(b.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`}</p>
                          <p className="text-xs" style={{ color: tertiaryTextColor }}>Created {formatDateTime(b.Created_At)}</p>
                          {b.Notes ? <p className="mt-0.5 truncate text-xs" style={{ color: secondaryTextColor }}>{b.Notes}</p> : null}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </section>

          {scannedBundle ? (
            <section className="rounded-2xl border bg-white p-5 space-y-5" style={{ borderColor: '#e2e8f0' }}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold" style={headingStyle}>Complete Wig - {scannedBundle.Bundle_Waybill_Code || `WB${String(Number(scannedBundle.Bundle_ID || 0)).padStart(6, '0').slice(-6)}`}</h2>
                  <p className="text-xs" style={{ color: tertiaryTextColor }}>Hairs in bundle: {bundleMemberCount}</p>
                </div>
                <button
                  type="button"
                  onClick={resetCompleteWigForm}
                  className="text-xs font-semibold underline"
                  style={{ color: secondaryTextColor }}
                >
                  Clear
                </button>
              </div>

              <div>
                <h3 className="text-sm font-semibold mb-2" style={headingStyle}>Photos (all 3 required)</h3>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                  {photoSlot('front', 'Front view', photoFront)}
                  {photoSlot('side', 'Side view', photoSide)}
                  {photoSlot('top', 'Top view', photoTop)}
                </div>
              </div>

              {allPhotosUploaded ? (
                <div className="space-y-4 rounded-xl border bg-slate-50 p-4" style={{ borderColor: '#e2e8f0' }}>
                  <h3 className="text-sm font-semibold" style={headingStyle}>Wig Details</h3>

                  <div>
                    <label className="block text-xs font-semibold mb-1" style={labelStyle}>Wig Name <span style={{ color: '#dc2626' }}>*</span></label>
                    <input
                      value={wigForm.wigName}
                      onChange={(e) => setWigForm((p) => ({ ...p, wigName: e.target.value }))}
                      placeholder="e.g. Long Wavy Black 2026-01"
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none"
                      style={inputStyle}
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div>
                      <label className="block text-xs font-semibold mb-1" style={labelStyle}>Hair Length (in)</label>
                      <input
                        type="number"
                        step="0.1"
                        value={wigForm.hairLength}
                        onChange={(e) => setWigForm((p) => ({ ...p, hairLength: e.target.value }))}
                        placeholder="e.g. 14"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold mb-1" style={labelStyle}>Hair Color</label>
                      <select
                        value={wigForm.hairColor}
                        onChange={(e) => setWigForm((p) => ({ ...p, hairColor: e.target.value }))}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none"
                        style={inputStyle}
                      >
                        <option value="">Select color</option>
                        {COLOR_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold mb-1" style={labelStyle}>Hair Texture</label>
                      <select
                        value={wigForm.hairTexture}
                        onChange={(e) => setWigForm((p) => ({ ...p, hairTexture: e.target.value }))}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none"
                        style={inputStyle}
                      >
                        <option value="">Select texture</option>
                        {TEXTURE_OPTIONS.map((t) => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold mb-1" style={labelStyle}>Hair Density</label>
                      <input
                        value={wigForm.hairDensity}
                        onChange={(e) => setWigForm((p) => ({ ...p, hairDensity: e.target.value }))}
                        placeholder="e.g. Medium / Thick"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold mb-1" style={labelStyle}>Style</label>
                      <input
                        value={wigForm.hairStyle}
                        onChange={(e) => setWigForm((p) => ({ ...p, hairStyle: e.target.value }))}
                        placeholder="e.g. Layered Bob / Straight Cut"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none"
                        style={inputStyle}
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-semibold mb-1" style={labelStyle}>Cap Size</label>
                      <select
                        value={wigForm.capSize}
                        onChange={(e) => setWigForm((p) => ({ ...p, capSize: e.target.value }))}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none"
                        style={inputStyle}
                      >
                        <option value="">Select cap size</option>
                        {CAP_SIZE_OPTIONS.map((size) => <option key={size.value} value={size.value}>{size.label}</option>)}
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold mb-1" style={labelStyle}>Notes</label>
                    <textarea
                      value={wigForm.notes}
                      onChange={(e) => setWigForm((p) => ({ ...p, notes: e.target.value }))}
                      rows={3}
                      placeholder="QA notes, packaging info, intended hospital request, etc."
                      className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none"
                      style={inputStyle}
                    />
                  </div>
                </div>
              ) : (
                <p className="text-xs" style={{ color: tertiaryTextColor }}>Upload all three photos to unlock the wig details form.</p>
              )}

              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleSubmitCompleteWig}
                  disabled={!canSubmitCompleteWig || isCompletingWig}
                  className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                  style={{ backgroundColor: tertiaryColor }}
                >
                  {isCompletingWig ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                  Complete Wig &amp; Notify Donors
                </button>
              </div>
            </section>
          ) : null}
        </div>
      ) : null}

      {activeTab === 'inventory' ? (
        <section className="overflow-hidden rounded-2xl border bg-white" style={{ borderColor: '#e2e8f0' }}>
          <div className="border-b px-4 py-3 flex items-center justify-between" style={{ borderColor: '#e2e8f0' }}>
            <div className="flex items-center gap-2">
              <Boxes size={18} style={{ color: primaryColor }} />
              <h2 className="text-lg font-semibold" style={headingStyle}>Wig Inventory</h2>
              <span className="rounded-full px-2 py-0.5 text-xs font-semibold" style={{ backgroundColor: withColorAlpha(primaryColor, 0.12), color: primaryColor }}>
                {inventory.length}
              </span>
            </div>
            {isLoadingInventory ? (
              <span className="inline-flex items-center gap-1 text-xs" style={{ color: tertiaryTextColor }}>
                <Loader2 size={12} className="animate-spin" /> Loading...
              </span>
            ) : null}
          </div>

          {!inventory.length && !isLoadingInventory ? (
            <div className="px-4 py-10 text-center text-sm" style={{ color: secondaryTextColor }}>
              No wigs in inventory yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead style={{ backgroundColor: withColorAlpha(primaryColor, 0.08) }}>
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Wig</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Code</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Photos</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Bundle</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Length</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Color</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Texture</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Density</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Style</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Cap Size</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Stock</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Donors</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Status</th>
                    <th className="px-4 py-3 text-left font-semibold" style={{ color: primaryTextColor }}>Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {inventory.map((row) => (
                    <tr key={row.Wig_ID} className="border-t" style={{ borderColor: '#e2e8f0' }}>
                      <td className="px-4 py-3" style={{ color: primaryTextColor }}>
                        <p className="font-semibold">{row.Wig_Name || `Wig #${row.Wig_ID}`}</p>
                        {row.Production_Notes ? <p className="text-xs mt-0.5" style={{ color: tertiaryTextColor }}>{row.Production_Notes}</p> : null}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs" style={{ color: secondaryTextColor }}>{row.Wig_Code || '-'}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          {[row.frontPhotoUrl, row.sidePhotoUrl, row.topPhotoUrl].map((url, index) => (
                            <div
                              key={`${row.Wig_ID}-photo-${index}`}
                              className="h-9 w-9 overflow-hidden rounded-md border bg-slate-100 flex items-center justify-center"
                              style={{ borderColor: '#e2e8f0' }}
                            >
                              {url ? (
                                <img src={url} alt={`Wig ${row.Wig_ID} view ${index + 1}`} className="h-full w-full object-cover" />
                              ) : (
                                <ImageIcon size={12} style={{ color: tertiaryTextColor }} />
                              )}
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs" style={{ color: secondaryTextColor }}>
                        {row.Bundle_ID ? `Bundle #${row.Bundle_ID}` : 'Manual'}
                      </td>
                      <td className="px-4 py-3" style={{ color: secondaryTextColor }}>{row.Hair_Length ? `${row.Hair_Length} in` : '-'}</td>
                      <td className="px-4 py-3" style={{ color: secondaryTextColor }}>{row.Hair_Color || '-'}</td>
                      <td className="px-4 py-3" style={{ color: secondaryTextColor }}>{row.Hair_Texture || '-'}</td>
                      <td className="px-4 py-3" style={{ color: secondaryTextColor }}>{row.Hair_Density || '-'}</td>
                      <td className="px-4 py-3" style={{ color: secondaryTextColor }}>{row.Style || '-'}</td>
                      <td className="px-4 py-3" style={{ color: secondaryTextColor }}>{row.Cap_Size || '-'}</td>
                      <td className="px-4 py-3">
                        <span className="rounded-full border px-2 py-0.5 text-xs font-semibold" style={{ backgroundColor: withColorAlpha(primaryColor, 0.1), borderColor: withColorAlpha(primaryColor, 0.35), color: primaryColor }}>
                          {row.Stock_Count || 0}
                        </span>
                      </td>
                      <td className="px-4 py-3" style={{ color: secondaryTextColor }}>{row.Total_Donated_Hairs || '-'}</td>
                      <td className="px-4 py-3">
                        <select
                          value={normalizeWigStatus(row.Wig_Status)}
                          onChange={(event) => { void handleUpdateWigStatus(row.Wig_ID, event.target.value); }}
                          disabled={Boolean(updatingStatusByWigId[row.Wig_ID])}
                          className="rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold focus:outline-none"
                          style={inputStyle}
                        >
                          {WIG_STATUS_OPTIONS.map((statusOption) => (
                            <option key={statusOption} value={statusOption}>{statusOption}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-3" style={{ color: tertiaryTextColor }}>{formatDateTime(row.Completed_At)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
