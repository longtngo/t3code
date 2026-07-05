/**
 * Client-side image downscale before upload (Phase 5 of the low-bandwidth roadmap).
 *
 * A phone photo can be ~20 MB; resizing it to a sane maximum edge and re-encoding
 * as JPEG before it crosses the wire turns that into a few hundred KB — the single
 * biggest attachment win, and it also cuts the vision tokens the provider sees.
 * Browser/DOM only (canvas); a non-image, an already-small image, or any failure
 * returns the original file unchanged so upload behavior never regresses.
 */

export interface ResizeDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Scaled dimensions that cap the longest edge at `maxDimension`. Never upscales;
 * returns the input dimensions unchanged when already within the cap.
 */
export function computeResizedDimensions(
  width: number,
  height: number,
  maxDimension: number,
): ResizeDimensions {
  const longestEdge = Math.max(width, height);
  if (longestEdge <= maxDimension || longestEdge <= 0) {
    return { width, height };
  }
  const scale = maxDimension / longestEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export interface ImageResizeOptions {
  /** Cap on the longest edge, in pixels. */
  readonly maxDimension?: number;
  /** JPEG quality for the re-encode (0–1). */
  readonly quality?: number;
  /** Skip images smaller than this — not worth the re-encode. */
  readonly minBytesToResize?: number;
}

const DEFAULT_MAX_DIMENSION = 2048;
const DEFAULT_QUALITY = 0.85;
const DEFAULT_MIN_BYTES = 512 * 1024;

function canResizeInThisEnvironment(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof createImageBitmap === "function" &&
    typeof HTMLCanvasElement !== "undefined"
  );
}

function jpegFileName(name: string): string {
  const renamed = name.replace(/\.(png|webp|gif|bmp|tiff?|heic|heif)$/i, ".jpg");
  return renamed.length > 0 ? renamed : "image.jpg";
}

/**
 * Downscale/re-encode a large image for upload. Returns a new JPEG `File` only
 * when that is actually smaller than the input; otherwise returns the original
 * file untouched (non-image, small, unsupported environment, or would-be-larger).
 */
export async function resizeImageForUpload(
  file: File,
  options: ImageResizeOptions = {},
): Promise<File> {
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const quality = options.quality ?? DEFAULT_QUALITY;
  const minBytes = options.minBytesToResize ?? DEFAULT_MIN_BYTES;

  if (!file.type.startsWith("image/") || file.size < minBytes || !canResizeInThisEnvironment()) {
    return file;
  }

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const { width, height } = computeResizedDimensions(bitmap.width, bitmap.height, maxDimension);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return file;
    }
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), "image/jpeg", quality);
    });
    if (!blob || blob.size >= file.size) {
      return file; // Re-encoding did not help — keep the original.
    }
    return new File([blob], jpegFileName(file.name), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file; // Any decode/encode failure: upload the original, never block the send.
  } finally {
    bitmap?.close();
  }
}
