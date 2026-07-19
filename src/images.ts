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

// Stem capped at 59 chars so the worst case (59-char stem + ".jpeg") is 64.
export const IMG_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,58}\.(png|jpe?g|gif|webp|avif|svg)$/;

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
  filename: string; // extension becomes .webp when the WebP re-encode wins
  contentType: string;
}

const SAME_FORMAT: Record<string, "png" | "jpeg" | "gif" | "webp" | "avif"> = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  gif: "gif",
  webp: "webp",
  avif: "avif",
};

/**
 * Compress an upload: orientation baked in, longest edge capped at 2000px,
 * EXIF/metadata dropped, encoded as WebP (animated GIF/WebP stays animated).
 * When the WebP comes out no smaller than the original — tiny icons,
 * already-tight AVIF — the fallback is a same-format re-encode through the same
 * pipeline, never the raw original: the cap and the metadata strip are promises
 * that must hold on every path (a kept-verbatim geotagged JPEG would leak GPS).
 * SVG is the one true passthrough: rasterizing a vector makes it bigger and
 * blurrier. Throws on undecodable input (sharp's error message is the
 * actionable part of the 400).
 */
export async function processImage(
  ext: string,
  filename: string,
  body: Uint8Array,
): Promise<ProcessedImage> {
  if (ext === "svg") return { data: body, filename, contentType: "image/svg+xml" };

  const animated = ext === "gif" || ext === "webp";
  const pipeline = () =>
    sharp(body, { animated })
      .rotate()
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: "inside", withoutEnlargement: true });

  const webp = new Uint8Array(await pipeline().webp({ quality: WEBP_QUALITY }).toBuffer());
  const asWebp: ProcessedImage = {
    data: webp,
    filename: filename.replace(/\.[^.]+$/, ".webp"),
    contentType: "image/webp",
  };
  // Beat the original outright (the overwhelmingly common case) — done, one encode.
  if (webp.length < body.length || ext === "webp") return asWebp;

  const same = new Uint8Array(await pipeline().toFormat(SAME_FORMAT[ext]!).toBuffer());
  if (same.length < webp.length) {
    return { data: same, filename, contentType: IMAGE_TYPES[ext]! };
  }
  return asWebp;
}
