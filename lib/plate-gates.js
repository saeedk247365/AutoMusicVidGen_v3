/**
 * Plate acceptance helpers beyond basic chroma (yaw plausibility + outfit crops).
 */
import sharp from "sharp";
import { checkOutfitPalette } from "./chroma-plate.js";

function isChroma(r, g, b) {
  return g > 140 && g > r + 35 && g > b + 35;
}

async function subjectMask(inputPathOrBuf, { width = 64, height = 96 } = {}) {
  const { data, info } = await sharp(inputPathOrBuf)
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 3, p++) {
    mask[p] = isChroma(data[i], data[i + 1], data[i + 2]) ? 0 : 1;
  }
  return { data, mask, width: info.width, height: info.height };
}

function regionMean(data, mask, width, height, y0, y1) {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  const ya = Math.max(0, Math.floor(y0 * height));
  const yb = Math.min(height, Math.ceil(y1 * height));
  for (let y = ya; y < yb; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!mask[p]) continue;
      const i = p * 3;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  if (!n) return null;
  return { r: r / n, g: g / n, b: b / n, n };
}

function regionCentroidX(mask, width, height, y0, y1) {
  let sx = 0;
  let n = 0;
  const ya = Math.max(0, Math.floor(y0 * height));
  const yb = Math.min(height, Math.ceil(y1 * height));
  for (let y = ya; y < yb; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!mask[p]) continue;
      sx += x;
      n++;
    }
  }
  if (!n) return null;
  return sx / n / width;
}

/**
 * Reject plates that should be turned but still look front-on.
 * Uses left/right mass asymmetry in the head band (works for true profiles
 * where head and body centroids stay vertically aligned).
 * Optional frontRef adds a silhouette-narrowing check vs a known front plate.
 *
 * @param {string|Buffer} candidatePathOrBuf
 * @param {string} angleKey
 * @param {{ frontRef?: string|Buffer }} [opts]
 */
export async function checkYawPlausibility(candidatePathOrBuf, angleKey, opts = {}) {
  const key = String(angleKey || "front");
  if (key === "front" || !key) {
    return { pass: true, reason: "ok", asymmetry: 0 };
  }

  const { mask, width, height } = await subjectMask(candidatePathOrBuf);

  // Subject bbox
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) {
    return { pass: false, reason: "angle_no_subject", asymmetry: 0 };
  }

  const candW = maxX - minX + 1;
  const candH = maxY - minY + 1;
  const candRatio = candW / Math.max(1, candH);

  const headY0 = minY;
  const headY1 = minY + Math.max(2, Math.floor((maxY - minY + 1) * 0.42));
  const midX = (minX + maxX) / 2;
  let leftN = 0;
  let rightN = 0;
  for (let y = headY0; y <= headY1; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!mask[y * width + x]) continue;
      if (x < midX) leftN++;
      else rightN++;
    }
  }
  const total = leftN + rightN;
  if (total < 8) {
    return { pass: false, reason: "angle_no_subject", asymmetry: 0 };
  }
  // +1 = more mass on right side of head; -1 = more on left
  const asymmetry = (rightN - leftN) / total;

  // Facing left (nose to image-left): hair mass sits on the right of the head band → +asymmetry
  // Soft 30° turns are subtle on curly/cartoon heads — keep threshold low but non-zero.
  let minAbs = 0.08;
  let expectSign = 0;
  let maxWidthFrac = null; // vs front plate width/height
  if (/soft_left|threequarter_left|side_left|back_left/.test(key)) {
    minAbs = /side_left/.test(key) ? 0.08 : /soft_left/.test(key) ? 0.018 : 0.04;
    expectSign = 1;
    maxWidthFrac = /side_left/.test(key) ? 0.78 : /soft_left/.test(key) ? 0.99 : 0.97;
  } else if (/soft_right|threequarter_right|side_right|back_right/.test(key)) {
    minAbs = /side_right/.test(key) ? 0.08 : /soft_right/.test(key) ? 0.018 : 0.04;
    expectSign = -1;
    maxWidthFrac = /side_right/.test(key) ? 0.78 : /soft_right/.test(key) ? 0.99 : 0.97;
  } else if (/back/.test(key)) {
    minAbs = 0.05;
    expectSign = 0;
    maxWidthFrac = 0.92;
  } else {
    return { pass: true, reason: "ok", asymmetry, candRatio };
  }

  const abs = Math.abs(asymmetry);
  if (abs < minAbs) {
    return { pass: false, reason: "angle_too_frontal", asymmetry, minAbs, candRatio };
  }
  if (expectSign !== 0 && Math.sign(asymmetry) !== expectSign) {
    return { pass: false, reason: "angle_too_frontal", asymmetry, minAbs, candRatio };
  }

  let widthFrac = null;
  if (opts.frontRef && maxWidthFrac != null) {
    try {
      const front = await subjectMask(opts.frontRef);
      let fMinX = front.width;
      let fMaxX = -1;
      let fMinY = front.height;
      let fMaxY = -1;
      for (let y = 0; y < front.height; y++) {
        for (let x = 0; x < front.width; x++) {
          if (!front.mask[y * front.width + x]) continue;
          if (x < fMinX) fMinX = x;
          if (x > fMaxX) fMaxX = x;
          if (y < fMinY) fMinY = y;
          if (y > fMaxY) fMaxY = y;
        }
      }
      if (fMaxX >= fMinX && fMaxY >= fMinY) {
        const frontRatio =
          (fMaxX - fMinX + 1) / Math.max(1, fMaxY - fMinY + 1);
        widthFrac = candRatio / Math.max(1e-6, frontRatio);
        if (widthFrac > maxWidthFrac) {
          return {
            pass: false,
            reason: "angle_too_frontal",
            asymmetry,
            minAbs,
            candRatio,
            widthFrac,
            maxWidthFrac,
          };
        }
      }
    } catch {
      /* front ref optional */
    }
  }

  return { pass: true, reason: "ok", asymmetry, minAbs, candRatio, widthFrac, maxWidthFrac };
}

/**
 * Torso + footwear crop checks (stricter than whole-image mean).
 */
export async function checkOutfitDetail(
  candidatePathOrBuf,
  masterPathOrBuf,
  { torsoMax = 48, footwearMax = 72 } = {},
) {
  const whole = await checkOutfitPalette(candidatePathOrBuf, masterPathOrBuf, {
    maxDistance: 64,
  });

  const cand = await subjectMask(candidatePathOrBuf, { width: 48, height: 72 });
  const mast = await subjectMask(masterPathOrBuf, { width: 48, height: 72 });

  const cTorso = regionMean(cand.data, cand.mask, cand.width, cand.height, 0.32, 0.68);
  const mTorso = regionMean(mast.data, mast.mask, mast.width, mast.height, 0.32, 0.68);
  const cFeet = regionMean(cand.data, cand.mask, cand.width, cand.height, 0.78, 0.98);
  const mFeet = regionMean(mast.data, mast.mask, mast.width, mast.height, 0.78, 0.98);

  const dist = (a, b) => {
    if (!a || !b) return Infinity;
    return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
  };

  const torsoDist = dist(cTorso, mTorso);
  const feetDist = dist(cFeet, mFeet);
  const reasons = [];
  if (!(torsoDist <= torsoMax)) reasons.push("outfit_torso_drift");
  if (!(feetDist <= footwearMax)) reasons.push("outfit_footwear_drift");
  if (!whole.pass) reasons.push(whole.reason || "outfit_drift");

  return {
    pass: reasons.length === 0,
    reason: reasons[0] || "ok",
    reasons,
    torsoDistance: torsoDist,
    footwearDistance: feetDist,
    wholeDistance: whole.distance,
  };
}
