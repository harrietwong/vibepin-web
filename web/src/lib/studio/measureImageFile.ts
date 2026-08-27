"use client";

/**
 * Natural pixel size of an image File, read in the browser BEFORE upload.
 *
 * Dimensions have to be captured here because this is the only moment we hold the
 * bytes. Once the file is a hosted URL, the only way back to width/height is a
 * network fetch per image — and without them the per-platform carousel rules
 * (mediaRules) can never do more than report `unverifiedRatio`, so a mixed-ratio
 * Pinterest carousel is only discovered when Pinterest rejects the publish.
 *
 * Measuring must NEVER block an upload: a decode failure, an exotic format, or an
 * environment without createImageBitmap all resolve to `{}`. Unknown dimensions
 * are honest and already handled downstream; a failed upload is not.
 */

export type ImageDimensions = { width?: number; height?: number };

function measureViaElement(file: File): Promise<ImageDimensions> {
  return new Promise(resolve => {
    let url: string;
    try { url = URL.createObjectURL(file); } catch { resolve({}); return; }
    const img = new Image();
    // Both paths revoke the object URL — leaking one per uploaded file would pin
    // the whole image in memory for the life of the document.
    const done = (dims: ImageDimensions) => { URL.revokeObjectURL(url); resolve(dims); };
    img.onload = () => done(
      img.naturalWidth > 0 && img.naturalHeight > 0
        ? { width: img.naturalWidth, height: img.naturalHeight }
        : {},
    );
    img.onerror = () => done({});
    img.src = url;
  });
}

export async function measureImageFile(file: File): Promise<ImageDimensions> {
  if (!file) return {};
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      const dims = bitmap.width > 0 && bitmap.height > 0
        ? { width: bitmap.width, height: bitmap.height }
        : {};
      // Free the decoded bitmap immediately; a batch upload decodes many at once.
      bitmap.close?.();
      return dims;
    }
  } catch {
    // Fall through: some browsers reject formats here that <img> still decodes.
  }
  try {
    return await measureViaElement(file);
  } catch {
    return {};
  }
}
