import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { scopedPath } from "./access.mjs";

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MAX_BYTES = 8 * 1024 * 1024;

function imageMime(data) {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(data.toString("ascii", 0, 6)))
    return "image/gif";
  if (
    data.toString("ascii", 0, 4) === "RIFF" &&
    data.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  if (data.toString("ascii", 0, 2) === "BM") return "image/bmp";
  throw Error(
    "Unsupported image data. Supply a PNG, JPEG, GIF, WebP or BMP image; SVG/PDF are not raster image inputs.",
  );
}

// Retain one bounded, stable file snapshot for Pi's public image processor.
export async function imageInput(root, file) {
  if (typeof file !== "string" || !IMAGE_EXTENSIONS.test(file))
    throw Error("Use a scoped PNG, JPEG, GIF, WebP or BMP file path.");
  const target = await scopedPath(root, file);
  const handle = await fs.open(
    target,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > MAX_BYTES
    )
      throw Error(
        "Image must be a regular, singly linked file of at most 8 MiB.",
      );
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(
        data,
        offset,
        data.length - offset,
        offset,
      );
      if (!bytesRead)
        throw Error("Image changed during reading; retry when stable.");
      offset += bytesRead;
    }
    const after = await handle.stat();
    const current = await fs.lstat(await scopedPath(root, file));
    if (
      ["dev", "ino", "size", "mtimeMs", "ctimeMs", "mode", "nlink"].some(
        (key) => before[key] !== after[key] || before[key] !== current[key],
      )
    )
      throw Error("Image changed during reading; retry when stable.");
    return {
      data,
      mimeType: imageMime(data),
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}
