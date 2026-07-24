import React, { useMemo, useState } from 'react';
import {
  CheckCircle2,
  ImageOff,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';

import {
  FILTERS_BUCKET,
  checkerboardStyle,
  getPublicUrl,
  withAlpha,
} from './wigCatalogUtils';

const CAP_ORDER = { Small: 1, Medium: 2, Large: 3 };

function normalized(value) {
  return String(value || '').trim();
}

function normalizedKey(value) {
  return normalized(value).toLowerCase();
}

function optionValues(options, field, numeric = false) {
  const values = Array.from(new Set(
    options.map((option) => normalized(option[field])).filter(Boolean),
  ));
  return values.sort((a, b) => (
    numeric ? Number(a) - Number(b) : a.localeCompare(b)
  ));
}

function familyKey(option) {
  if (option.familyNumber !== null && option.familyNumber !== undefined) {
    return `family-${option.familyNumber}`;
  }
  return [
    normalizedKey(option.wigName),
    normalizedKey(option.style),
    normalizedKey(option.hairColor),
    normalizedKey(option.hairTexture),
    normalizedKey(option.hairLength),
    normalizedKey(option.hairDensity),
  ].join('|');
}

function buildFamilies(options) {
  const familiesByKey = new Map();
  options.forEach((option) => {
    const key = familyKey(option);
    const current = familiesByKey.get(key);
    if (current) {
      current.variants.push(option);
      return;
    }
    familiesByKey.set(key, {
      key,
      representative: option,
      variants: [option],
    });
  });

  return Array.from(familiesByKey.values())
    .map((family) => ({
      ...family,
      variants: [...family.variants].sort(
        (a, b) => (CAP_ORDER[a.capSize] || 99) - (CAP_ORDER[b.capSize] || 99),
      ),
    }))
    .sort((a, b) => (
      normalized(a.representative.wigName)
        .localeCompare(normalized(b.representative.wigName))
    ));
}

function selectClasses() {
  return 'w-full rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-medium text-slate-700';
}

function compactDetails(option) {
  return [
    option.hairColor,
    option.hairTexture,
    option.hairLength ? `${option.hairLength} in` : '',
    option.hairDensity ? `${option.hairDensity} density` : '',
  ].filter(Boolean).join(' · ');
}

export default function WigSpecificationPicker({
  options,
  value,
  onChange,
  primaryColor,
  primaryTextColor,
  secondaryTextColor,
}) {
  const accent = primaryColor || '#7f1d1d';
  const [search, setSearch] = useState('');
  const [styleFilter, setStyleFilter] = useState('');
  const [textureFilter, setTextureFilter] = useState('');
  const [colorFilter, setColorFilter] = useState('');
  const [lengthFilter, setLengthFilter] = useState('');
  const [capFilter, setCapFilter] = useState('');

  const families = useMemo(() => buildFamilies(options || []), [options]);
  const selected = useMemo(
    () => (options || []).find(
      (option) => String(option.Wig_Specification_ID) === String(value || ''),
    ) || null,
    [options, value],
  );

  const styleOptions = useMemo(() => optionValues(options || [], 'style'), [options]);
  const textureOptions = useMemo(() => optionValues(options || [], 'hairTexture'), [options]);
  const colorOptions = useMemo(() => optionValues(options || [], 'hairColor'), [options]);
  const lengthOptions = useMemo(
    () => optionValues(options || [], 'hairLength', true),
    [options],
  );
  const capOptions = useMemo(
    () => optionValues(options || [], 'capSize').sort(
      (a, b) => (CAP_ORDER[a] || 99) - (CAP_ORDER[b] || 99),
    ),
    [options],
  );

  const filteredFamilies = useMemo(() => {
    const query = normalizedKey(search);
    return families
      .map((family) => {
        const representative = family.representative;
        const queryValues = [
          representative.wigName,
          representative.style,
          representative.hairColor,
          representative.hairTexture,
          representative.hairDensity,
          representative.hairLength,
          representative.familyNumber,
          ...family.variants.map((variant) => variant.wigCode),
        ];
        if (
          query
          && !queryValues.some((item) => normalizedKey(item).includes(query))
        ) {
          return null;
        }
        if (styleFilter && representative.style !== styleFilter) return null;
        if (textureFilter && representative.hairTexture !== textureFilter) return null;
        if (colorFilter && representative.hairColor !== colorFilter) return null;
        if (
          lengthFilter
          && normalized(representative.hairLength) !== normalized(lengthFilter)
        ) {
          return null;
        }

        const visibleVariants = capFilter
          ? family.variants.filter((variant) => variant.capSize === capFilter)
          : family.variants;
        if (!visibleVariants.length) return null;
        return { ...family, visibleVariants };
      })
      .filter(Boolean);
  }, [
    capFilter,
    colorFilter,
    families,
    lengthFilter,
    search,
    styleFilter,
    textureFilter,
  ]);

  const filtersActive = Boolean(
    search || styleFilter || textureFilter || colorFilter || lengthFilter || capFilter,
  );

  const clearFilters = () => {
    setSearch('');
    setStyleFilter('');
    setTextureFilter('');
    setColorFilter('');
    setLengthFilter('');
    setCapFilter('');
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <label className="block text-xs font-semibold" style={{ color: secondaryTextColor }}>
            Target wig style and cap size
          </label>
          <p className="mt-0.5 text-[10px] text-slate-500">
            Choose the style family first, then select its exact cap-size variant.
          </p>
        </div>
        <span className="shrink-0 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-semibold text-slate-600">
          {families.length} style{families.length === 1 ? '' : 's'} · {(options || []).length} variants
        </span>
      </div>

      {selected ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2.5"
          style={{
            borderColor: withAlpha(accent, 0.45),
            backgroundColor: withAlpha(accent, 0.06),
          }}
        >
          <div className="flex items-center gap-2">
            <CheckCircle2 size={17} style={{ color: accent }} />
            <div>
              <p className="text-xs font-bold" style={{ color: primaryTextColor }}>
                Selected: {selected.wigName}
              </p>
              <p className="mt-0.5 text-[10px]" style={{ color: secondaryTextColor }}>
                {selected.wigCode} · {selected.capSize} cap · {selected.style || 'Style not named'}
                {' · '}Specification #{selected.Wig_Specification_ID}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onChange?.('')}
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-[10px] font-semibold text-slate-600"
          >
            <X size={11} /> Clear selection
          </button>
        </div>
      ) : (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-700">
          No variant selected yet. Choose a cap-size button from a wig style below.
        </div>
      )}

      <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <label className="relative min-w-0 flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search wig name, code, style, texture..."
              className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-8 text-xs"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400"
                aria-label="Clear search"
              >
                <X size={13} />
              </button>
            ) : null}
          </label>
          <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            <SlidersHorizontal size={12} /> Filters
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
          <select value={styleFilter} onChange={(event) => setStyleFilter(event.target.value)} className={selectClasses()}>
            <option value="">All styles</option>
            {styleOptions.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={textureFilter} onChange={(event) => setTextureFilter(event.target.value)} className={selectClasses()}>
            <option value="">All textures</option>
            {textureOptions.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={colorFilter} onChange={(event) => setColorFilter(event.target.value)} className={selectClasses()}>
            <option value="">All colors</option>
            {colorOptions.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
          <select value={lengthFilter} onChange={(event) => setLengthFilter(event.target.value)} className={selectClasses()}>
            <option value="">All lengths</option>
            {lengthOptions.map((item) => <option key={item} value={item}>{item} in</option>)}
          </select>
          <select value={capFilter} onChange={(event) => setCapFilter(event.target.value)} className={selectClasses()}>
            <option value="">All cap sizes</option>
            {capOptions.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </div>

        <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500">
          <span>
            Showing {filteredFamilies.length} of {families.length} wig style{families.length === 1 ? '' : 's'}
          </span>
          {filtersActive ? (
            <button
              type="button"
              onClick={clearFilters}
              className="inline-flex items-center gap-1 font-semibold"
              style={{ color: accent }}
            >
              <X size={11} /> Clear all filters
            </button>
          ) : null}
        </div>
      </div>

      <div className="max-h-[430px] space-y-2 overflow-y-auto pr-1">
        {!options?.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center text-xs text-slate-500">
            No wig specifications are available. Add a wig family in Wig Catalog Studio first.
          </div>
        ) : !filteredFamilies.length ? (
          <div className="rounded-xl border border-dashed border-slate-300 px-4 py-10 text-center">
            <p className="text-xs font-semibold text-slate-700">No wig styles match these filters</p>
            <button
              type="button"
              onClick={clearFilters}
              className="mt-2 text-xs font-semibold"
              style={{ color: accent }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          filteredFamilies.map((family) => {
            const item = family.representative;
            const familySelected = family.variants.some(
              (variant) => String(variant.Wig_Specification_ID) === String(value || ''),
            );
            const imageUrl = item.imageUrl || getPublicUrl(
              FILTERS_BUCKET,
              item.catalogImagePath,
            );
            return (
              <article
                key={family.key}
                className="rounded-xl border bg-white p-3 transition"
                style={familySelected
                  ? {
                      borderColor: accent,
                      boxShadow: `0 0 0 1px ${withAlpha(accent, 0.2)}`,
                    }
                  : { borderColor: '#e2e8f0' }}
              >
                <div className="grid gap-3 sm:grid-cols-[64px,minmax(0,1fr)] xl:grid-cols-[64px,minmax(180px,1fr),minmax(300px,1.4fr)] xl:items-center">
                  <div
                    className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border border-slate-200"
                    style={checkerboardStyle()}
                  >
                    {imageUrl ? (
                      <img src={imageUrl} alt="" className="h-full w-full object-contain" />
                    ) : (
                      <ImageOff size={18} className="text-slate-400" />
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h4 className="truncate text-sm font-bold" style={{ color: primaryTextColor }}>
                        {item.wigName || 'Unnamed wig'}
                      </h4>
                      {item.familyNumber !== null && item.familyNumber !== undefined ? (
                        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">
                          Family {String(item.familyNumber).padStart(4, '0')}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 text-xs font-semibold" style={{ color: accent }}>
                      {item.style || 'Style not named'}
                    </p>
                    <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                      {compactDetails(item) || 'Specification details unavailable'}
                    </p>
                  </div>

                  <div className="sm:col-span-2 xl:col-span-1">
                    <p className="mb-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-slate-500">
                      Select cap size
                    </p>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                      {family.visibleVariants.map((variant) => {
                        const isSelected = String(variant.Wig_Specification_ID)
                          === String(value || '');
                        return (
                          <button
                            key={variant.Wig_Specification_ID}
                            type="button"
                            onClick={() => onChange?.(String(variant.Wig_Specification_ID))}
                            className={`rounded-lg border px-2.5 py-2 text-left transition ${
                              isSelected ? 'text-white shadow-sm' : 'border-slate-200 bg-white hover:border-slate-400'
                            }`}
                            style={isSelected
                              ? { backgroundColor: accent, borderColor: accent }
                              : undefined}
                          >
                            <span className="flex items-center justify-between gap-1">
                              <span className="text-xs font-bold">{variant.capSize || 'Cap N/A'}</span>
                              {isSelected ? <CheckCircle2 size={13} /> : null}
                            </span>
                            <span className={`mt-0.5 block font-mono text-[9px] ${isSelected ? 'text-white/85' : 'text-slate-500'}`}>
                              {variant.wigCode || `Spec #${variant.Wig_Specification_ID}`}
                            </span>
                            <span className={`mt-1 block text-[9px] ${isSelected ? 'text-white/85' : 'text-slate-500'}`}>
                              Current stock: {Number(variant.stockCount || 0)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>
    </div>
  );
}
