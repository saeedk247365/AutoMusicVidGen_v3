/**
 * Training-plate helpers: rembg subject onto solid chroma green (#00FF00).
 * Scenic rooms belong in song compositing — never in LoRA masters/keyframes.
 */
import sharp from "sharp";
import { removePlateBackground } from "./composite.js";

export const CHROMA_RGB = { r: 0, g: 255, b: 0 };
export const CHROMA_HEX = "#00FF00";

/**
 * Fit subject cutout onto a solid chroma canvas (default 512×768).
 * @returns {{ buffer: Buffer, width: number, height: number, rembg: boolean, error?: string }}
 */
export async function toChromaTrainingPlate(
  inputPathOrBuf,
  { width = 512, height = 768 } = {},
) {
  let cut = null;
  let rembg = false;
  try {
    cut = await removePlateBackground(inputPathOrBuf);
    rembg = true;
  } catch (err) {
    // Fall back to cover resize if rembg unavailable — still paint chroma BG later if alpha exists.
    const msg = err?.message || String(err);
    const fitted = await sharp(inputPathOrBuf)
      .rotate()
      .resize(width, height, { fit: "contain", background: CHROMA_RGB })
      .ensureAlpha()
      .png()
      .toBuffer();
    return {
      buffer: fitted,
      width,
      height,
      rembg: false,
      error: `rembg failed: ${msg}`,
    };
  }

  const meta = await sharp(cut).metadata();
  const cw = meta.width || width;
  const ch = meta.height || height;
  const scale = Math.min(width / cw, height / ch) * 0.98;
  const tw = Math.max(1, Math.round(cw * scale));
  const th = Math.max(1, Math.round(ch * scale));
  const left = Math.max(0, Math.round((width - tw) / 2));
  const top = Math.max(0, Math.round(height - th - height * 0.04));

  const subject = await sharp(cut)
    .resize(tw, th, { fit: "fill" })
    .ensureAlpha()
    .png()
    .toBuffer();

  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: CHROMA_RGB,
    },
  })
    .composite([{ input: subject, left, top }])
    .png()
    .toBuffer();

  return { buffer, width, height, rembg };
}

/** True when image border is mostly chroma green (training plate contract). */
export async function checkChromaBorder(inputPathOrBuf, { minRatio = 0.55 } = {}) {
  const { data, info } = await sharp(inputPathOrBuf)
    .resize(64, 96, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let border = 0;
  let green = 0;
  const isBorder = (x, y) => x < 3 || y < 3 || x >= width - 3 || y >= height - 3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isBorder(x, y)) continue;
      border++;
      const i = (y * width + x) * 3;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (g > 140 && g > r + 40 && g > b + 40) green++;
    }
  }
  const ratio = border ? green / border : 0;
  return {
    pass: ratio >= minRatio,
    ratio,
    reason: ratio >= minRatio ? "ok" : "bg_not_chroma",
  };
}

/**
 * Compare non-chroma subject colors vs master. Large palette shift ⇒ outfit/identity drift.
 */
export async function checkOutfitPalette(
  candidatePathOrBuf,
  masterPathOrBuf,
  { maxDistance = 72 } = {},
) {
  const hist = async (src) => {
    const { data, info } = await sharp(src)
      .resize(48, 72, { fit: "cover" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < data.length; i += 3) {
      const rr = data[i];
      const gg = data[i + 1];
      const bb = data[i + 2];
      // Skip chroma / near-green backdrop pixels
      if (gg > 140 && gg > rr + 35 && gg > bb + 35) continue;
      r += rr;
      g += gg;
      b += bb;
      n++;
    }
    if (!n) return { r: 0, g: 0, b: 0, n: 0 };
    return { r: r / n, g: g / n, b: b / n, n };
  };

  const a = await hist(candidatePathOrBuf);
  const m = await hist(masterPathOrBuf);
  if (!a.n || !m.n) {
    return { pass: false, distance: Infinity, reason: "palette_empty" };
  }
  const distance = Math.hypot(a.r - m.r, a.g - m.g, a.b - m.b);
  return {
    pass: distance <= maxDistance,
    distance,
    reason: distance <= maxDistance ? "ok" : "outfit_drift",
    candidate: a,
    master: m,
  };
}
