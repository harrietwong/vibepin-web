/**
 * BrandLogo — single source of truth for the VibePin logo mark.
 *
 * Usage:
 *   <BrandLogo size={30} />          — dark background pill (default, for sidebars/nav)
 *   <BrandLogo size={32} bare />     — transparent background, mark only (for light contexts)
 */

type BrandLogoProps = {
  /** Container size in px (square). Default 30. */
  size?: number;
  /** Render the PNG directly with no wrapper div. */
  bare?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

export default function BrandLogo({ size = 30, bare = false, className, style }: BrandLogoProps) {
  const radius = Math.round(size * 0.27);

  if (bare) {
    return (
      <img
        src="/logo.png"
        alt="VibePin"
        width={size}
        height={size}
        className={className}
        style={{ display: "block", borderRadius: radius, ...style }}
      />
    );
  }

  return (
    <img
      src="/logo.png"
      alt="VibePin"
      width={size}
      height={size}
      className={className}
      style={{ display: "block", borderRadius: radius, flexShrink: 0, ...style }}
    />
  );
}
