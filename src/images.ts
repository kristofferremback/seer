import sharp from "sharp";

// Upload-time image processing, lifted from Threa's thumbnail pipeline (sharp:
// bake EXIF orientation, cap the longest edge, encode WebP) but tuned for
// full-size serving rather than 640px thumbnails.

export const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};

export const IMG_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,59}\.(png|jpe?g|gif|webp|avif|svg)$/;

// PR screenshots read fine at ~900 CSS px; 2000 covers that on 2x displays.
const MAX_DIMENSION = 2000;
const WEBP_QUALITY = 82;

// Light magic-byte check on binary formats: catches "uploaded the wrong file" (a
// zip, an HTML error page) with an actionable 400 before sharp chews on it. SVG
// is text and gets no sniff.
export function sniffOk(ext: string, body: Uint8Array): boolean {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, j) => body[i + j] === b);
  switch (ext) {
    case "png":
      return at(0, 0x89, 0x50, 0x4e, 0x47);
    case "jpg":
    case "jpeg":
      return at(0, 0xff, 0xd8, 0xff);
    case "gif":
      return at(0, 0x47, 0x49, 0x46, 0x38);
    case "webp":
      return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
    case "avif":
      return at(4, 0x66, 0x74, 0x79, 0x70); // ISO-BMFF "ftyp" box
    default:
      return true;
  }
}

export interface ProcessedImage {
  data: Uint8Array;
  filename: string; // extension becomes .webp when the re-encode wins
  contentType: string;
}

/**
 * Compress an upload: orientation baked in, longest edge capped at 2000px,
 * re-encoded as WebP (animated GIF/WebP stays animated), EXIF/metadata dropped.
 * If the WebP comes out no smaller than the original — tiny icons, already-tight
 * AVIF — the original bytes are stored untouched. SVG always passes through:
 * rasterizing a vector makes it bigger and blurrier. Throws on undecodable input
 * (sharp's error message is the actionable part of the 400).
 */
export async function processImage(
  ext: string,
  filename: string,
  body: Uint8Array,
): Promise<ProcessedImage> {
  if (ext === "svg") return { data: body, filename, contentType: "image/svg+xml" };

  const animated = ext === "gif" || ext === "webp";
  const webp = new Uint8Array(
    await sharp(body, { animated })
      .rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer(),
  );

  if (webp.length >= body.length) {
    return { data: body, filename, contentType: IMAGE_TYPES[ext]! };
  }
  return { data: webp, filename: filename.replace(/\.[^.]+$/, ".webp"), contentType: "image/webp" };
}
