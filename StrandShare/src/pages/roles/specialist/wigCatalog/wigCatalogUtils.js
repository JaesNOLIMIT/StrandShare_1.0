import { supabase } from '../../../../lib/supabaseClient';

export const FILTERS_BUCKET = 'wig_ai_filters';
export const DUPLICATE_WARNING_THRESHOLD = 0.78;

export const COLOR_OPTIONS = [
  'Black',
  'Dark Brown',
  'Light Brown',
  'Auburn',
  'Blonde',
  'Grey',
];
export const TEXTURE_OPTIONS = ['Straight', 'Wavy', 'Curly', 'Coily'];
export const DENSITY_OPTIONS = ['Light', 'Medium', 'Heavy'];
export const CAP_SIZE_OPTIONS = ['Small', 'Medium', 'Large'];

export const EMPTY_WIG_FORM = Object.freeze({
  wigName: '',
  wigCode: '',
  hairLength: '',
  hairColor: '',
  hairTexture: '',
  hairDensity: '',
  capSize: '',
  style: '',
  stockCount: '1',
  lowStockThreshold: '2',
});

export function withAlpha(colorValue, alpha, fallback = '#7f1d1d') {
  const input = String(colorValue || '').trim();
  const match = input.match(/^#([0-9a-f]{6})$/i);
  if (!match) {
    if (fallback === colorValue) return `rgba(127, 29, 29, ${alpha})`;
    return withAlpha(fallback, alpha, fallback);
  }
  const hex = match[1];
  return `rgba(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)}, ${alpha})`;
}

export function getPublicUrl(bucket, path) {
  if (!supabase || !path) return '';
  return supabase.storage.from(bucket).getPublicUrl(path).data?.publicUrl || '';
}

export function textureCode(texture) {
  const key = String(texture || '').trim().toLowerCase();
  if (key === 'straight') return 'S';
  if (['wavy', 'curly', 'coily'].includes(key)) return 'C';
  return '';
}

export function capCode(capSize) {
  const key = String(capSize || '').trim().toLowerCase();
  if (key === 'small') return 'S';
  if (key === 'medium') return 'M';
  if (key === 'large') return 'L';
  return '';
}

export function codePrefix(texture, capSize) {
  const textureLetter = textureCode(texture);
  const capLetter = capCode(capSize);
  return textureLetter && capLetter ? `W${textureLetter}${capLetter}` : '';
}

export function formatWigCodePreview(texture, capSize) {
  const prefix = codePrefix(texture, capSize);
  return prefix ? `${prefix}••••` : 'Choose texture + cap size';
}

export function stockState(row) {
  const stock = Math.max(0, Number(row?.stockCount || 0));
  const threshold = Math.max(0, Number(row?.lowStockThreshold ?? 2));
  if (stock <= 0) return { key: 'out', label: 'Out of Stock', tone: 'slate' };
  if (stock <= threshold) return { key: 'low', label: 'Low Stock', tone: 'red' };
  return { key: 'in', label: 'In Stock', tone: 'green' };
}

export function normalizeInventory(wigs, specs, filters) {
  const specsByWig = new Map(
    (specs || []).map((row) => [Number(row.Wig_ID), row]),
  );
  const filtersByWig = new Map();
  (filters || []).forEach((filter) => {
    const wigId = Number(filter.Wig_ID || 0);
    if (!wigId) return;
    const current = filtersByWig.get(wigId);
    if (
      !current
      || filter.Is_Active
      || new Date(filter.Created_At || 0) > new Date(current.Created_At || 0)
    ) {
      filtersByWig.set(wigId, filter);
    }
  });

  return (wigs || []).map((wig) => {
    const wigId = Number(wig.Wig_ID);
    const spec = specsByWig.get(wigId) || {};
    const filter = filtersByWig.get(wigId) || {};
    const catalogPath = wig.Catalog_Image_Path
      || filter.Layer_Full_Wig_Path
      || filter.Thumbnail_Path
      || '';
    const imageUrl = getPublicUrl(FILTERS_BUCKET, catalogPath);

    return {
      wigId,
      familyNumber: wig.Catalog_Family_Number ?? null,
      wigName: wig.Wig_Name || `Wig #${wigId}`,
      wigCode: wig.Wig_Code || '',
      stockCount: Math.max(0, Number(wig.Stock_Count || 0)),
      lowStockThreshold: Math.max(0, Number(wig.Low_Stock_Threshold ?? 2)),
      status: wig.Wig_Status,
      imagePath: catalogPath,
      imageUrl,
      createdAt: wig.Completed_At || wig.Created_At,
      hairLength: spec.Hair_Length ?? '',
      hairColor: spec.Hair_Color || '',
      hairTexture: spec.Hair_Texture || '',
      hairDensity: spec.Hair_Density || '',
      capSize: spec.Cap_Size || '',
      style: spec.Style || '',
      embedding: Array.isArray(spec.Visual_Embedding) ? spec.Visual_Embedding : null,
      aiSuggestions: spec.AI_Suggestions || {},
      aiModelVersion: spec.AI_Model_Version || filter.AI_Model_Version || '',
      filterId: filter.Filter_ID || null,
    };
  });
}

export function inventoryForLocalAnalysis(rows) {
  const onePerFamily = new Map();
  (rows || []).forEach((row) => {
    const key = row.familyNumber === null || row.familyNumber === undefined
      ? `wig-${row.wigId}`
      : `family-${row.familyNumber}`;
    const current = onePerFamily.get(key);
    if (!current || Number(row.stockCount || 0) > Number(current.stockCount || 0)) {
      onePerFamily.set(key, row);
    }
  });
  return Array.from(onePerFamily.values()).slice(0, 500).map((row) => ({
    wigId: row.wigId,
    familyNumber: row.familyNumber,
    wigName: row.wigName,
    wigCode: row.wigCode,
    imageUrl: row.imageUrl || null,
    embedding: Array.isArray(row.embedding) ? row.embedding : null,
    attributes: {
      hairLength: row.hairLength,
      hairColor: row.hairColor,
      hairTexture: row.hairTexture,
      hairDensity: row.hairDensity,
      capSize: row.capSize,
      style: row.style,
    },
  }));
}

function normalizeText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ');
}

function tokenSimilarity(left, right) {
  const a = new Set(normalizeText(left).split(' ').filter(Boolean));
  const b = new Set(normalizeText(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((token) => b.has(token)).length;
  return intersection / new Set([...a, ...b]).size;
}

function attributeSimilarity(match, form) {
  const existing = match?.attributes || {};
  const definitions = [
    ['hairTexture', 0.27],
    ['hairColor', 0.19],
    ['hairDensity', 0.14],
    ['capSize', 0.13],
    ['style', 0.20],
    ['hairLength', 0.07],
  ];
  let score = 0;
  let available = 0;
  definitions.forEach(([field, weight]) => {
    if (form[field] === '' || form[field] === null || form[field] === undefined) return;
    if (existing[field] === '' || existing[field] === null || existing[field] === undefined) return;
    available += weight;
    if (field === 'style') {
      score += weight * tokenSimilarity(form[field], existing[field]);
    } else if (field === 'hairLength') {
      const delta = Math.abs(Number(form[field]) - Number(existing[field]));
      score += weight * Math.max(0, 1 - (delta / 12));
    } else if (normalizeText(form[field]) === normalizeText(existing[field])) {
      score += weight;
    }
  });
  return available ? score / available : 0;
}

export function rescoreDuplicateMatches(matches, form) {
  return (matches || [])
    .map((match) => {
      const attributeScore = attributeSimilarity(match, form);
      const rawVisual = Number(match.visualSimilarity);
      const hasVisual = Number.isFinite(rawVisual);
      const visualScore = hasVisual
        ? Math.max(0, Math.min(1, (rawVisual - 0.62) / 0.32))
        : null;
      const score = visualScore === null
        ? Math.max(Number(match.score || 0), 0.55 * attributeScore)
        : (0.72 * visualScore) + (0.28 * attributeScore);
      return {
        ...match,
        score,
        attributeSimilarity: attributeScore,
        requiresConfirmation: score >= DUPLICATE_WARNING_THRESHOLD,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function confidencePercent(suggestion) {
  return Math.round(Math.max(0, Math.min(1, Number(suggestion?.confidence || 0))) * 100);
}

export function requiredDetailsMissing(form) {
  const required = [
    'wigName',
    'wigCode',
    'hairLength',
    'hairColor',
    'hairTexture',
    'hairDensity',
    'capSize',
    'style',
  ];
  return required.filter((field) => String(form?.[field] ?? '').trim() === '');
}

export function checkerboardStyle() {
  return {
    backgroundColor: '#f8fafc',
    backgroundImage:
      'linear-gradient(45deg,#e8edf3 25%,transparent 25%),linear-gradient(-45deg,#e8edf3 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e8edf3 75%),linear-gradient(-45deg,transparent 75%,#e8edf3 75%)',
    backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
    backgroundSize: '16px 16px',
  };
}
