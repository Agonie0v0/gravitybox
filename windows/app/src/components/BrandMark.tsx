import brandMarkUrl from '../assets/brand-mark.png';

export function BrandMark({ size = 20 }: { size?: number }) {
  return (
    <img
      src={brandMarkUrl}
      alt="GravityBox"
      width={size}
      height={size}
      draggable={false}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        display: 'block',
        flexShrink: 0,
      }}
    />
  );
}
