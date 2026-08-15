import React, { useState } from 'react';
import { Sparkles, Wand2, Loader2, Image as ImageIcon, Save } from 'lucide-react';
import { useTheme } from '../../../context/ThemeContext';

const LENGTH_OPTIONS = ['Pixie', 'Bob', 'Shoulder Length', 'Mid-back', 'Waist Length'];
const TEXTURE_OPTIONS = ['Straight', 'Wavy', 'Curly', 'Coily'];
const COLOR_OPTIONS = ['Black', 'Dark Brown', 'Light Brown', 'Auburn', 'Blonde', 'Grey'];

const mockGallery = [
  { id: 'Style-2026-007', title: 'Classic Bob', length: 'Bob', color: 'Dark Brown', updated: '2 days ago' },
  { id: 'Style-2026-006', title: 'Layered Waves', length: 'Shoulder Length', color: 'Black', updated: '5 days ago' },
  { id: 'Style-2026-005', title: 'Long Straight', length: 'Mid-back', color: 'Auburn', updated: '1 week ago' },
];

export default function HairstyleMakingPage() {
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

  const [length, setLength] = useState(LENGTH_OPTIONS[1]);
  const [texture, setTexture] = useState(TEXTURE_OPTIONS[0]);
  const [color, setColor] = useState(COLOR_OPTIONS[0]);
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationNotice, setGenerationNotice] = useState('');

  const handleGenerate = () => {
    setIsGenerating(true);
    setGenerationNotice('');
    window.setTimeout(() => {
      setIsGenerating(false);
      setGenerationNotice('Mock generation complete. Real AI wiring is not yet connected.');
    }, 1200);
  };

  return (
    <div className="space-y-6" style={rootStyle}>
      <div>
        <h1 className="role-page-title text-3xl font-bold mb-2" style={headingStyle}>Hairstyle Making</h1>
        <p style={{ color: secondaryTextColor }}>
          Generate AI hairstyle previews for the wig catalog. Configure attributes, then generate and save to the gallery.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-1 rounded-xl border border-gray-200 bg-white p-5 space-y-4">
          <div className="flex items-center gap-2">
            <Wand2 size={20} style={{ color: primaryColor }} />
            <h2 className="text-lg font-semibold" style={headingStyle}>Style Attributes</h2>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={labelStyle}>Length</label>
            <select
              value={length}
              onChange={(event) => setLength(event.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none"
              style={inputStyle}
            >
              {LENGTH_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={labelStyle}>Texture</label>
            <select
              value={texture}
              onChange={(event) => setTexture(event.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none"
              style={inputStyle}
            >
              {TEXTURE_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={labelStyle}>Color</label>
            <select
              value={color}
              onChange={(event) => setColor(event.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none"
              style={inputStyle}
            >
              {COLOR_OPTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1" style={labelStyle}>Prompt (optional)</label>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              rows={3}
              placeholder="Add styling cues, e.g. side-parted, soft layers."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none"
              style={inputStyle}
            />
          </div>

          <button
            type="button"
            onClick={handleGenerate}
            disabled={isGenerating}
            className="w-full inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
            style={{ backgroundColor: primaryColor }}
          >
            {isGenerating ? <Loader2 className="animate-spin" size={16} /> : <Sparkles size={16} />}
            {isGenerating ? 'Generating...' : 'Generate Hairstyle'}
          </button>

          {generationNotice ? (
            <p className="text-xs" style={{ color: tertiaryTextColor }}>{generationNotice}</p>
          ) : null}
        </div>

        <div className="lg:col-span-2 rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold" style={headingStyle}>Generated Preview</h2>
            <button
              type="button"
              disabled
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium"
              style={{ color: tertiaryTextColor }}
            >
              <Save size={14} />
              Save to Gallery
            </button>
          </div>
          <div
            className="aspect-video w-full rounded-xl flex items-center justify-center"
            style={{
              background: `linear-gradient(135deg, ${primaryColor}22, ${tertiaryColor}22)`,
            }}
          >
            <div className="text-center" style={{ color: secondaryTextColor }}>
              <ImageIcon className="mx-auto mb-2 opacity-60" size={36} />
              <p className="text-sm">AI-generated hairstyle image will appear here.</p>
              <p className="text-xs mt-1" style={{ color: tertiaryTextColor }}>
                Selected: {length} - {texture} - {color}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-lg font-semibold" style={headingStyle}>Hairstyle Gallery</h2>
          <span className="text-xs" style={{ color: tertiaryTextColor }}>Hardcoded preview</span>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 p-4">
          {mockGallery.map((style) => (
            <div key={style.id} className="rounded-lg border border-gray-200 overflow-hidden">
              <div
                className="aspect-video flex items-center justify-center"
                style={{
                  background: `linear-gradient(135deg, ${primaryColor}1a, ${tertiaryColor}1a)`,
                  color: tertiaryTextColor,
                }}
              >
                <ImageIcon size={28} />
              </div>
              <div className="p-3">
                <p className="font-mono text-xs" style={{ color: tertiaryTextColor }}>{style.id}</p>
                <p className="font-semibold" style={{ color: primaryTextColor }}>{style.title}</p>
                <p className="text-sm" style={{ color: secondaryTextColor }}>{style.length} - {style.color}</p>
                <p className="text-xs mt-1" style={{ color: tertiaryTextColor }}>Updated {style.updated}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
