import { Sparkles } from 'lucide-react';

export function TierBadge({ tier }: { tier?: string | null }) {
  const clean = (tier ?? '').trim();
  if (!clean) return null;
  const upper = clean.toUpperCase();

  let cls = 'gb-pill gb-pill-neutral';
  let showStar = false;

  if (upper === 'PRO' || upper === 'PLUS') {
    cls = 'gb-pill gb-pill-blue';
    showStar = true;
  } else if (upper === 'ULTRA' || upper === 'ENTERPRISE' || upper === 'TEAM') {
    cls = 'gb-pill';
    showStar = true;
  }

  const customStyle =
    upper === 'ULTRA' || upper === 'ENTERPRISE' || upper === 'TEAM'
      ? {
          background: 'rgba(124, 58, 237, 0.14)',
          color: '#8b5cf6',
          border: '0.5px solid rgba(139, 92, 246, 0.32)',
        }
      : undefined;

  return (
    <span className={cls} style={customStyle}>
      {showStar && <Sparkles size={10} strokeWidth={2.4} />}
      <span>{clean}</span>
    </span>
  );
}
