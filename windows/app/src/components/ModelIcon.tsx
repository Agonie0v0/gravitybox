import geminiIcon from '@root-assets/model-icons/gemini.png';
import claudeIcon from '@root-assets/model-icons/claude.png';
import openaiIcon from '@root-assets/model-icons/openai.png';
import { Sparkles } from 'lucide-react';
import { inferredBrands } from '../lib/format';

type Brand = 'gemini' | 'claude' | 'openai';

const ICON_MAP: Record<Brand, string> = {
  gemini: geminiIcon,
  claude: claudeIcon,
  openai: openaiIcon,
};

export function SingleBrandIcon({
  brand,
  size = 15,
  isDark = false,
}: {
  brand: Brand;
  size?: number;
  isDark?: boolean;
}) {
  return (
    <img
      src={ICON_MAP[brand]}
      alt={brand}
      width={size}
      height={size}
      draggable={false}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        display: 'block',
        flexShrink: 0,
        filter: brand === 'openai' && isDark ? 'invert(1) brightness(1.05)' : undefined,
      }}
    />
  );
}

export function BrandIcons({
  brands,
  fallbackName,
  size = 15,
  isDark = false,
}: {
  brands?: Brand[];
  fallbackName?: string;
  size?: number;
  isDark?: boolean;
}) {
  const resolved = brands && brands.length > 0 ? brands : inferredBrands(fallbackName ?? '');
  if (resolved.length === 0) {
    return <Sparkles size={size} style={{ color: 'var(--blue)', flexShrink: 0 }} />;
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      {resolved.map((b) => (
        <SingleBrandIcon key={b} brand={b} size={size} isDark={isDark} />
      ))}
    </span>
  );
}
