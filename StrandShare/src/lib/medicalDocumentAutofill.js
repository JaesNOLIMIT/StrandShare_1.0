const MAX_PDF_PAGES = 5;
const MAX_SCANNED_PDF_PAGES = 3;
const MIN_SEARCHABLE_PDF_TEXT_LENGTH = 80;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDocumentText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanExtractedValue(value) {
  return String(value || '')
    .replace(/^[\s:;|\-\u2013\u2014]+/, '')
    .replace(/[\s|]+$/, '')
    .trim();
}

function findLabeledValue(text, labels) {
  const normalizedText = normalizeDocumentText(text);
  const lines = normalizedText.split('\n').map((line) => line.trim()).filter(Boolean);
  const labelPattern = labels.map(escapeRegExp).join('|');
  const inlinePattern = new RegExp(`^(?:${labelPattern})\\s*(?::|\\-|\\u2013|\\u2014)\\s*(.+)$`, 'i');
  const valueAfterLabelPattern = new RegExp(`^(?:${labelPattern})\\s+(.+)$`, 'i');
  const labelOnlyPattern = new RegExp(`^(?:${labelPattern})\\s*(?::|\\-|\\u2013|\\u2014)?$`, 'i');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inlineMatch = line.match(inlinePattern) || line.match(valueAfterLabelPattern);
    if (inlineMatch?.[1]) {
      return cleanExtractedValue(inlineMatch[1]);
    }

    if (labelOnlyPattern.test(line)) {
      const nextLine = cleanExtractedValue(lines[index + 1]);
      if (nextLine && nextLine.length <= 160) {
        return nextLine;
      }
    }
  }

  return '';
}

function toIsoDate(yearValue, monthValue, dayValue) {
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!year || !month || !day || year < 1900 || year > new Date().getFullYear() || month > 12 || day > 31) {
    return '';
  }

  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return '';
  }

  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeExtractedDate(value) {
  const cleaned = cleanExtractedValue(value)
    .replace(/\b(?:date|born|diagnosed)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const isoMatch = cleaned.match(/\b(19\d{2}|20\d{2})[./-](\d{1,2})[./-](\d{1,2})\b/);
  if (isoMatch) {
    return toIsoDate(isoMatch[1], isoMatch[2], isoMatch[3]);
  }

  const numericMatch = cleaned.match(/\b(\d{1,2})[./-](\d{1,2})[./-](19\d{2}|20\d{2})\b/);
  if (numericMatch) {
    const first = Number(numericMatch[1]);
    const second = Number(numericMatch[2]);

    if (first > 12 && second <= 12) {
      return toIsoDate(numericMatch[3], second, first);
    }

    if (second > 12 && first <= 12) {
      return toIsoDate(numericMatch[3], first, second);
    }

    // Avoid silently guessing between DD/MM and MM/DD when both are plausible.
    if (first === second) {
      return toIsoDate(numericMatch[3], first, second);
    }
  }

  const monthNameMatch = cleaned.match(/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?,?\s+(?:19|20)\d{2}\b/i)
    || cleaned.match(/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:19|20)\d{2}\b/i);

  if (monthNameMatch?.[0]) {
    const parsed = new Date(monthNameMatch[0].replace(/(\d)(?:st|nd|rd|th)/i, '$1'));
    if (!Number.isNaN(parsed.getTime())) {
      return toIsoDate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
    }
  }

  return '';
}

function normalizeGender(value) {
  const normalized = String(value || '').toLowerCase();
  if (/\bfemale\b|^f$/.test(normalized)) return 'Female';
  if (/\bmale\b|^m$/.test(normalized)) return 'Male';
  if (/\b(?:non[ -]?binary|other)\b/.test(normalized)) return 'Other';
  if (/prefer\s+not\s+to\s+say/.test(normalized)) return 'Prefer not to say';
  return '';
}

function normalizePhilippinePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('63')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^9\d{9}$/.test(digits)) return '';
  return `+63 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
}

function normalizeNamePart(value) {
  return cleanExtractedValue(value)
    .replace(/\b(?:mr|mrs|ms|miss|dr)\.?\s+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitFullName(value) {
  const cleaned = normalizeNamePart(value);
  if (!cleaned) return {};

  const knownSuffixPattern = /\b(Jr|Sr|II|III|IV|V)\.?(?=\s|$)/i;
  const suffixMatch = cleaned.match(knownSuffixPattern);
  const suffix = suffixMatch?.[1]?.replace(/\.$/, '') || '';
  const withoutSuffix = cleaned.replace(knownSuffixPattern, '').replace(/\s+/g, ' ').trim();

  if (withoutSuffix.includes(',')) {
    const [lastNameValue, givenNamesValue] = withoutSuffix.split(',', 2);
    const givenParts = String(givenNamesValue || '').trim().split(/\s+/).filter(Boolean);
    return {
      firstName: givenParts.shift() || '',
      middleName: givenParts.join(' '),
      lastName: normalizeNamePart(lastNameValue),
      suffix,
    };
  }

  const parts = withoutSuffix.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return {};

  return {
    firstName: parts[0],
    middleName: parts.slice(1, -1).join(' '),
    lastName: parts[parts.length - 1],
    suffix,
  };
}

function sanitizeShortText(value, maxLength = 160) {
  const cleaned = cleanExtractedValue(value);
  return cleaned && cleaned.length <= maxLength ? cleaned : '';
}

export function parseMedicalDocumentFields(text) {
  const firstName = normalizeNamePart(findLabeledValue(text, ['first name', 'given name', 'given names']));
  const middleName = normalizeNamePart(findLabeledValue(text, ['middle name', 'middle initial']));
  const lastName = normalizeNamePart(findLabeledValue(text, ['last name', 'surname', 'family name']));
  const suffix = normalizeNamePart(findLabeledValue(text, ['suffix', 'name suffix']));
  const fullName = findLabeledValue(text, ["patient's name", 'patient name', 'name of patient', 'full name']);
  const fallbackName = splitFullName(fullName);
  const emailMatch = normalizeDocumentText(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

  const fields = {
    email: String(emailMatch?.[0] || '').toLowerCase(),
    firstName: firstName || fallbackName.firstName || '',
    middleName: middleName || fallbackName.middleName || '',
    lastName: lastName || fallbackName.lastName || '',
    suffix: suffix || fallbackName.suffix || '',
    birthdate: normalizeExtractedDate(findLabeledValue(text, ['date of birth', 'birth date', 'birthdate', 'dob'])),
    gender: normalizeGender(findLabeledValue(text, ['gender', 'sex'])),
    dateOfDiagnosis: normalizeExtractedDate(findLabeledValue(text, ['date of diagnosis', 'diagnosis date', 'diagnosed on'])),
    guardian: sanitizeShortText(findLabeledValue(text, ['guardian name', "guardian's name", 'parent or guardian', 'parent/guardian'])),
    guardianContactNumber: normalizePhilippinePhone(findLabeledValue(text, ['guardian contact number', 'guardian contact', 'contact number', 'mobile number'])),
    guardianRelationship: sanitizeShortText(findLabeledValue(text, ['guardian relationship', 'relationship to patient', 'relationship'])),
    medicalCondition: sanitizeShortText(findLabeledValue(text, ['medical condition', 'clinical diagnosis', 'primary diagnosis', 'diagnosis', 'impression']), 240),
  };

  return Object.fromEntries(Object.entries(fields).filter(([, value]) => Boolean(String(value || '').trim())));
}

async function createOcrWorker(onProgress) {
  const { createWorker } = await import('tesseract.js');
  return createWorker('eng', undefined, {
    logger: (message) => {
      if (message?.status === 'recognizing text' && Number.isFinite(message.progress)) {
        onProgress?.({ stage: 'ocr', progress: message.progress });
      }
    },
  });
}

async function extractImageText(file, onProgress) {
  const worker = await createOcrWorker(onProgress);
  try {
    const result = await worker.recognize(file);
    return normalizeDocumentText(result?.data?.text);
  } finally {
    await worker.terminate();
  }
}

async function extractPdfText(file, onProgress) {
  const pdfjs = await import('pdfjs-dist/webpack.mjs');
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const pdf = await loadingTask.promise;
  const searchableParts = [];
  const pageLimit = Math.min(pdf.numPages, MAX_PDF_PAGES);

  try {
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      onProgress?.({ stage: 'reading-pdf', progress: pageNumber / pageLimit });
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageLines = [];
      let currentLine = '';
      content.items.forEach((item) => {
        const itemText = String(item?.str || '').trim();
        if (itemText) {
          currentLine = `${currentLine}${currentLine ? ' ' : ''}${itemText}`;
        }
        if (item?.hasEOL) {
          if (currentLine) pageLines.push(currentLine);
          currentLine = '';
        }
      });
      if (currentLine) pageLines.push(currentLine);
      searchableParts.push(pageLines.join('\n'));
      page.cleanup();
    }

    const searchableText = normalizeDocumentText(searchableParts.join('\n'));
    if (searchableText.length >= MIN_SEARCHABLE_PDF_TEXT_LENGTH) {
      return searchableText;
    }

    const worker = await createOcrWorker(onProgress);
    const ocrParts = [];
    const scanPageLimit = Math.min(pdf.numPages, MAX_SCANNED_PDF_PAGES);

    try {
      for (let pageNumber = 1; pageNumber <= scanPageLimit; pageNumber += 1) {
        onProgress?.({ stage: 'scanning-pdf', progress: (pageNumber - 1) / scanPageLimit });
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1.6 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d', { alpha: false });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: context, viewport }).promise;
        const result = await worker.recognize(canvas);
        ocrParts.push(result?.data?.text || '');
        page.cleanup();
        canvas.width = 1;
        canvas.height = 1;
      }
    } finally {
      await worker.terminate();
    }

    return normalizeDocumentText([searchableText, ...ocrParts].filter(Boolean).join('\n'));
  } finally {
    await pdf.destroy();
  }
}

export async function extractMedicalDocumentText(file, { onProgress } = {}) {
  if (!file) return '';

  const fileType = String(file.type || '').toLowerCase();
  const fileName = String(file.name || '').toLowerCase();
  const isPdf = fileType === 'application/pdf' || fileName.endsWith('.pdf');
  const isImage = fileType.startsWith('image/');

  if (isPdf) {
    return extractPdfText(file, onProgress);
  }

  if (isImage) {
    return extractImageText(file, onProgress);
  }

  throw new Error('Autofill supports PDF and image medical documents only.');
}
