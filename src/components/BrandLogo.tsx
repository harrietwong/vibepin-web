type BrandLogoProps = {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  /** @deprecated no-op, kept for call-site compatibility */
  bare?: boolean;
};

export default function BrandLogo({ size = 30, className, style }: BrandLogoProps) {
  return (
    <img
      src="/logo.png"
      alt="VibePin"
      width={size}
      height={size}
      className={className}
      data-brand-logo=""
      style={{ display: "block", flexShrink: 0, objectFit: "contain", ...style }}
    />
  );
}
