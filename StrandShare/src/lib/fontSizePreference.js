export const FONT_SIZE_PREVIEW_EVENT = "Donivra-font-size-preview";

export const FONT_SIZE_OPTIONS = [
  {
    value: "small",
    label: "Small",
    rootPixels: 14,
    description: "Fits more information on screen.",
  },
  {
    value: "default",
    label: "Default",
    rootPixels: 16,
    description: "The standard Donivra text size.",
  },
  {
    value: "large",
    label: "Large",
    rootPixels: 18,
    description: "Larger text for easier reading.",
  },
  {
    value: "extra_large",
    label: "Extra Large",
    rootPixels: 20,
    description: "Maximum text size and spacing.",
  },
];

export function normalizeFontSizePreference(value) {
  const normalized = String(value || "default")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  return FONT_SIZE_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : "default";
}

export function getFontSizeRootPixels(value) {
  const normalized = normalizeFontSizePreference(value);
  return FONT_SIZE_OPTIONS.find((option) => option.value === normalized)?.rootPixels || 16;
}

export function previewFontSizePreference(value) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(FONT_SIZE_PREVIEW_EVENT, {
      detail: { value: normalizeFontSizePreference(value) },
    }),
  );
}
