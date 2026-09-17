"use client";

import { ImageOff, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "@/lib/i18n/LocaleProvider";

export type ProductImageState =
  | "loading"
  | "loaded"
  | "missing"
  | "decode_failed"
  | "tiny"
  | "unsupported";

const MIN_PRODUCT_IMAGE_EDGE = 48;

type ProductImageSurfaceProps = {
  src: string | null | undefined;
  alt: string;
  className?: string;
  fallbackLabel?: string;
  minEdge?: number;
};

function supportedSource(value: string | null | undefined): value is string {
  const source = value?.trim();
  if (!source || source === "null" || source === "undefined") return false;
  return /^(https?:\/\/|data:image\/|blob:|\/)/i.test(source);
}

export function initialProductImageState(source: string | null | undefined): ProductImageState {
  const normalized = source?.trim();
  if (!normalized || normalized === "null" || normalized === "undefined") return "missing";
  return supportedSource(source) ? "loading" : "unsupported";
}

export function productImageRenderKey(source: string | null | undefined): string {
  return source?.trim() || "__missing_product_image__";
}

export function ProductImageSurface(props: ProductImageSurfaceProps) {
  const source = props.src?.trim() || null;
  return <ProductImageForSource key={productImageRenderKey(source)} {...props} src={source} />;
}

function ProductImageForSource({
  src,
  alt,
  className,
  fallbackLabel,
  minEdge = MIN_PRODUCT_IMAGE_EDGE,
}: ProductImageSurfaceProps) {
  const { t: tr } = useLocale();
  const [state, setState] = useState<ProductImageState>(() => initialProductImageState(src));
  const loadSequence = useRef(0);
  const resolvedFallbackLabel = fallbackLabel ?? tr("products.image.unavailable");

  useEffect(() => {
    if (state !== "loading") return;
    const timeout = window.setTimeout(() => {
      loadSequence.current += 1;
      setState("decode_failed");
    }, 10_000);
    return () => window.clearTimeout(timeout);
  }, [state]);

  const failed = state === "missing" || state === "decode_failed" || state === "tiny" || state === "unsupported";

  return (
    <div
      className={className}
      data-testid="product-image-surface"
      data-image-state={state}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        minHeight: "inherit",
        overflow: "hidden",
        background: "#202631",
        color: "#A7AFBC",
      }}
    >
      {state === "loading" ? (
        <span aria-label={tr("products.image.loading")} style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          <Loader2 aria-hidden="true" style={{ width: 20, height: 20 }} />
        </span>
      ) : null}
      {failed ? (
        <span role="img" aria-label={resolvedFallbackLabel} style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 7, padding: 12, textAlign: "center", fontSize: 11, lineHeight: 1.4 }}>
          <ImageOff aria-hidden="true" style={{ width: 23, height: 23 }} />
          <span>{resolvedFallbackLabel}</span>
        </span>
      ) : null}
      {supportedSource(src) ? (
        // Merchant hosts are dynamic, so this intentionally uses the browser image element.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block", opacity: state === "loaded" ? 1 : 0 }}
          onError={() => { loadSequence.current += 1; setState("decode_failed"); }}
          onLoad={(event) => {
            const image = event.currentTarget;
            const sequence = loadSequence.current;
            if (image.naturalWidth < minEdge || image.naturalHeight < minEdge) {
              setState("tiny");
              return;
            }
            void image.decode()
              .then(() => { if (sequence === loadSequence.current) setState("loaded"); })
              .catch(() => { if (sequence === loadSequence.current) setState("decode_failed"); });
          }}
        />
      ) : null}
    </div>
  );
}
