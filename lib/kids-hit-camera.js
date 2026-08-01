/**
 * Kids-hit camera framing + music snap helpers.
 * Crop-based shot cards on an oversize plate so each beat can have a
 * different position in the room, and FLF can move between start/end crops.
 */
import { writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { normalizeCameraMotion } from "./kids-hit-continuity.js";

/** Virtual set size vs final canvas (1.5 = 50% pan/zoom room). */
export const CAMERA_PLATE_OVERSIZE = 1.5;

export const SHOT_SIZES = ["wide", "medium_full", "medium", "close", "detail"];

/** Zoom into the oversize plate (1 = full plate visible after letterbox crop). */
const SHOT_ZOOM = {
  wide: 1.0,
  medium_full: 1.12,
  medium: 1.22,
  close: 1.38,
  detail: 1.52,
};

/** Default pan bias by shot (normalized −1…1 in plate space). */
const SHOT_OFFSET_BIAS = {
  wide: { x: 0, y: 0.05 },
  medium_full: { x: 0, y: 0.02 },
  medium: { x: 0, y: -0.02 },
  close: { x: 0, y: -0.08 },
  detail: { x: 0, y: -0.12 },
};

/** Per-location preferred anchors (normalized plate coords). */
export const LOCATION_CAMERA_ANCHORS = {
  home: { center: { x: 0, y: 0 }, door: { x: -0.25, y: 0.05 }, rug: { x: 0.1, y: 0.15 } },
  living_rug: { center: { x: 0, y: 0.1 }, rug: { x: 0, y: 0.2 } },
  kitchen: { center: { x: 0, y: 0 }, sink: { x: 0.2, y: -0.05 }, table: { x: -0.15, y: 0.1 } },
  kitchen_sink: { center: { x: 0, y: -0.05 }, sink: { x: 0.1, y: -0.1 } },
  dining_room: { center: { x: 0, y: 0.05 }, table: { x: 0, y: 0.12 } },
  bedroom: { center: { x: 0, y: 0 }, bed: { x: 0.15, y: 0.1 } },
  playroom: { center: { x: 0, y: 0.05 }, toys: { x: -0.2, y: 0.15 } },
  lawn: { center: { x: 0, y: 0.08 }, path: { x: 0, y: 0.2 } },
  backyard: { center: { x: 0, y: 0.08 } },
  porch: { center: { x: 0, y: 0 }, door: { x: 0, y: -0.05 } },
  doorway: { center: { x: 0, y: 0 }, door: { x: 0, y: 0 } },
  hallway: { center: { x: 0, y: 0 } },
  bathtub: { center: { x: 0, y: 0.05 } },
  default: { center: { x: 0, y: 0 } },
};

export function normalizeShotSize(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/[\s-]+/g, "_");
  if (s === "full_body" || s === "full" || s === "wide_shot") return "wide";
  if (s === "medium_full" || s === "med_full") return "medium_full";
  if (s === "medium" || s === "med") return "medium";
  if (s === "close" || s === "closeup" || s === "close_up" || s === "portrait")
    return "close";
  if (s === "detail" || s === "ecu") return "detail";
  if (SHOT_SIZES.includes(s)) return s;
  return "";
}

export function shotSizeFromFraming(camera) {
  const c = String(camera || "").toLowerCase();
  if (c === "close" || c === "portrait") return "close";
  if (c === "medium") return "medium";
  if (c === "medium_full") return "medium_full";
  if (c === "full_body" || c === "wide") return "wide";
  return "medium_full";
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

/**
 * Build / normalize the camera shot card on a beat.
 */
export function ensureCameraShotCard(beat, { index = 0, prev = null } = {}) {
  const b = beat && typeof beat === "object" ? beat : {};
  let motion =
    normalizeCameraMotion(b.cameraMotion) ||
    normalizeCameraMotion(b.camera?.motion) ||
    "none";
  let shotSize =
    normalizeShotSize(b.camera?.shotSize) ||
    normalizeShotSize(b.shotSize) ||
    (typeof b.camera === "string" ? shotSizeFromFraming(b.camera) : "") ||
    "";

  // Derive from motion if still empty
  if (!shotSize) {
    if (motion === "push_in" || motion === "lower") shotSize = "close";
    else if (motion === "hold_wide" || motion === "pull_back") shotSize = "wide";
    else if (motion === "track") shotSize = "medium";
    else shotSize = "medium_full";
  }

  // Coherence: never pair close framing with hold_wide (or wide with push_in)
  if (motion === "hold_wide" && (shotSize === "close" || shotSize === "detail")) {
    shotSize = "wide";
  }
  if (motion === "push_in" && shotSize === "wide") {
    shotSize = "medium";
  }
  if (motion === "pull_back" && (shotSize === "close" || shotSize === "detail")) {
    shotSize = "medium_full";
  }

  // Variety vs previous same-room beat — always change size AND motion
  const MOTION_CYCLE = ["none", "push_in", "track", "pull_back", "hold_wide", "lower"];
  if (
    prev &&
    String(prev.location || "").toLowerCase() === String(b.location || "").toLowerCase() &&
    !b.bridge &&
    !prev.bridge
  ) {
    const prevSize =
      normalizeShotSize(prev.camera?.shotSize) ||
      shotSizeFromFraming(prev.camera) ||
      "medium_full";
    const prevMotion =
      normalizeCameraMotion(prev.cameraMotion) ||
      normalizeCameraMotion(prev.camera?.motion) ||
      "none";
    const sizeCycle = ["wide", "medium_full", "medium", "close"];
    if (prevSize === shotSize || !normalizeShotSize(b.camera?.shotSize)) {
      const idx = Math.max(0, sizeCycle.indexOf(prevSize));
      shotSize = sizeCycle[(idx + 1 + (index % 2)) % sizeCycle.length];
    }
    // Force a different camera move every same-room neighbor
    if (prevMotion === motion || motion === "none") {
      const mi = Math.max(0, MOTION_CYCLE.indexOf(prevMotion));
      motion = MOTION_CYCLE[(mi + 1 + (index % 3)) % MOTION_CYCLE.length];
      if (motion === prevMotion) {
        motion = MOTION_CYCLE[(mi + 2) % MOTION_CYCLE.length];
      }
    }
    // Re-apply coherence after variety re-roll
    if (motion === "hold_wide" && (shotSize === "close" || shotSize === "detail")) {
      shotSize = "wide";
    }
    if (motion === "push_in" && shotSize === "wide") {
      shotSize = "medium";
    }
  }

  // Approach sink: last kitchen beat before kitchen_sink → push toward sink anchor
  const loc = String(b.location || "default").toLowerCase();
  const anchors = LOCATION_CAMERA_ANCHORS[loc] || LOCATION_CAMERA_ANCHORS.default;
  let anchorName = String(b.camera?.anchor || b.cameraAnchor || "center")
    .toLowerCase()
    .trim();
  if (!anchors[anchorName]) {
    const names = Object.keys(anchors);
    anchorName =
      names.length > 1 && index % 3 === 1
        ? names.find((n) => n !== "center") || "center"
        : "center";
  }
  const nextLoc = String(b._nextLocation || "").toLowerCase();
  if (
    loc === "kitchen" &&
    (nextLoc === "kitchen_sink" || String(b.effect || "").toLowerCase().includes("sink"))
  ) {
    motion = "push_in";
    shotSize = shotSize === "wide" ? "medium" : shotSize;
    if (anchors.sink) anchorName = "sink";
  }
  const anchor = anchors[anchorName] || anchors.center || { x: 0, y: 0 };
  const bias = SHOT_OFFSET_BIAS[shotSize] || { x: 0, y: 0 };

  // Slight alternating pan so consecutive shots aren't identical
  const panNudge = ((index % 4) - 1.5) * 0.08;
  const offset = {
    x: clamp(
      Number(b.camera?.offset?.x) || anchor.x + bias.x + panNudge,
      -0.45,
      0.45,
    ),
    y: clamp(
      Number(b.camera?.offset?.y) || anchor.y + bias.y,
      -0.35,
      0.35,
    ),
  };

  const zoom = clamp(
    Number(b.camera?.zoom) || SHOT_ZOOM[shotSize] || 1.12,
    1.0,
    1.65,
  );

  // End framing = where the camera arrives during the clip
  const end = endCameraFromMotion(motion, { shotSize, offset, zoom });

  const angle =
    motion === "lower"
      ? "low"
      : String(b.camera?.angle || b.cameraAngle || "eye")
          .toLowerCase()
          .trim() || "eye";

  b.cameraMotion = motion;
  b.camera = {
    shotSize,
    angle,
    anchor: anchorName,
    offset,
    zoom,
    motion,
    end,
  };
  // Legacy string field used by composite layout
  b.cameraFraming =
    shotSize === "close" || shotSize === "detail"
      ? "close"
      : shotSize === "wide"
        ? "full_body"
        : shotSize === "medium"
          ? "medium"
          : "medium_full";

  return b;
}

function endCameraFromMotion(motion, { shotSize, offset, zoom }) {
  const m = normalizeCameraMotion(motion) || "none";
  let endZoom = zoom;
  let endOffset = { ...offset };
  let endShot = shotSize;

  if (m === "push_in") {
    endZoom = clamp(zoom * 1.28, 1, 1.75);
    endShot = shotSize === "wide" ? "medium" : shotSize === "medium_full" ? "close" : "close";
    endOffset = { x: offset.x * 0.75, y: clamp(offset.y - 0.08, -0.4, 0.35) };
  } else if (m === "pull_back") {
    endZoom = clamp(zoom * 0.82, 1, 1.5);
    endShot = "wide";
    endOffset = { x: offset.x * 0.4, y: clamp(offset.y + 0.06, -0.35, 0.4) };
  } else if (m === "track") {
    endOffset = {
      x: clamp(offset.x + 0.22, -0.45, 0.45),
      y: offset.y,
    };
    endZoom = clamp(zoom * 1.06, 1, 1.65);
  } else if (m === "lower") {
    endOffset = { x: offset.x, y: clamp(offset.y + 0.14, -0.35, 0.4) };
    endZoom = clamp(zoom * 1.12, 1, 1.65);
  } else if (m === "hold_wide") {
    endZoom = Math.min(zoom, 1.05);
    endShot = "wide";
    endOffset = { x: clamp(offset.x + 0.06, -0.4, 0.4), y: offset.y };
  } else {
    // Gentle living drift — still readable without FLF
    endZoom = clamp(zoom * 1.1, 1, 1.6);
    endOffset = {
      x: clamp(offset.x + 0.05, -0.45, 0.45),
      y: clamp(offset.y - 0.04, -0.35, 0.35),
    };
  }

  return {
    shotSize: endShot,
    offset: endOffset,
    zoom: endZoom,
  };
}

/**
 * Apply shot cards + variety across a beat list (mutates copies).
 */
export function applyCameraShotCards(beats) {
  const list = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  for (let i = 0; i < list.length; i++) {
    if (list[i + 1]) list[i]._nextLocation = list[i + 1].location;
    list[i] = ensureCameraShotCard(list[i], {
      index: i,
      prev: i > 0 ? list[i - 1] : null,
    });
    delete list[i]._nextLocation;
  }
  // Second pass: ban 2 identical consecutive shot sizes/motions in same room
  for (let i = 1; i < list.length; i++) {
    const b = list[i - 1];
    const c = list[i];
    if (c.bridge || b.bridge) continue;
    const loc = String(c.location || "").toLowerCase();
    if (!loc || loc !== String(b.location || "").toLowerCase()) continue;
    const sb = b.camera?.shotSize;
    const sc = c.camera?.shotSize;
    const mb = b.camera?.motion || b.cameraMotion;
    const mc = c.camera?.motion || c.cameraMotion;
    if (sb && sb === sc) {
      const cycle = ["wide", "medium_full", "medium", "close"];
      const idx = Math.max(0, cycle.indexOf(sc));
      const nextSize = cycle[(idx + 1) % cycle.length];
      c.camera = {
        ...c.camera,
        shotSize: nextSize,
        zoom: SHOT_ZOOM[nextSize] || c.camera.zoom,
      };
      c.cameraFraming =
        nextSize === "wide"
          ? "full_body"
          : nextSize === "close"
            ? "close"
            : nextSize === "medium"
              ? "medium"
              : "medium_full";
    }
    if (mb && mb === mc) {
      const MOTION_CYCLE = ["push_in", "track", "pull_back", "hold_wide", "lower", "none"];
      const mi = Math.max(0, MOTION_CYCLE.indexOf(mc));
      const nextMotion = MOTION_CYCLE[(mi + 1) % MOTION_CYCLE.length];
      c.cameraMotion = nextMotion;
      c.camera = { ...c.camera, motion: nextMotion };
    }
  }
  return list;
}

/**
 * Compute pixel crop rect inside an oversize plate for a camera card.
 * Plate is plateW×plateH; output crop is outW×outH.
 */
export function cameraCropRect(
  plateW,
  plateH,
  outW,
  outH,
  camera,
  { useEnd = false } = {},
) {
  const card = useEnd && camera?.end ? camera.end : camera || {};
  const zoom = clamp(Number(card.zoom) || 1.12, 1.0, 1.7);
  const ox = clamp(Number(card.offset?.x) || 0, -0.5, 0.5);
  const oy = clamp(Number(card.offset?.y) || 0, -0.5, 0.5);

  // Base crop that covers out aspect at given zoom into plate
  const plateAspect = plateW / plateH;
  const outAspect = outW / outH;
  let cropW;
  let cropH;
  if (plateAspect > outAspect) {
    cropH = plateH / zoom;
    cropW = cropH * outAspect;
  } else {
    cropW = plateW / zoom;
    cropH = cropW / outAspect;
  }
  cropW = Math.min(plateW, cropW);
  cropH = Math.min(plateH, cropH);

  const maxX = plateW - cropW;
  const maxY = plateH - cropH;
  const cx = plateW / 2 + ox * (plateW * 0.35);
  const cy = plateH / 2 + oy * (plateH * 0.35);
  let left = Math.round(cx - cropW / 2);
  let top = Math.round(cy - cropH / 2);
  left = clamp(left, 0, Math.max(0, maxX));
  top = clamp(top, 0, Math.max(0, maxY));

  return {
    left,
    top,
    width: Math.round(cropW),
    height: Math.round(cropH),
  };
}

/**
 * Build a simple music map from BPM + duration (no extra deps).
 * ACE songs already have a known bpm from the pipeline.
 */
export function buildMusicMap({
  durationSec,
  bpm = 115,
  offsetSec = 0,
  source = "bpm-grid",
} = {}) {
  const dur = Math.max(0.1, Number(durationSec) || 0);
  const tempo = Math.max(60, Math.min(180, Number(bpm) || 115));
  const beatDur = 60 / tempo;
  const offset = Math.max(0, Number(offsetSec) || 0);
  const beats = [];
  for (let t = offset, i = 0; t < dur - 0.01; t += beatDur, i++) {
    const barBeat = i % 4;
    beats.push({
      t: Math.round(t * 1000) / 1000,
      i,
      bar: Math.floor(i / 4),
      beatInBar: barBeat,
      downbeat: barBeat === 0,
      strength: barBeat === 0 ? 1 : barBeat === 2 ? 0.7 : 0.4,
    });
  }
  return {
    version: 1,
    source,
    durationSec: dur,
    bpm: tempo,
    offsetSec: offset,
    beatDur,
    beats,
    createdAt: new Date().toISOString(),
  };
}

export async function writeMusicMap(songDir, map) {
  const path = join(songDir, "music-map.json");
  await writeFile(path, JSON.stringify(map, null, 2), "utf8");
  return path;
}

export async function loadMusicMap(songDir) {
  const path = join(songDir, "music-map.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function nearestBeatTime(t, musicMap, { preferDownbeat = false } = {}) {
  const beats = musicMap?.beats || [];
  if (!beats.length) return t;
  let best = beats[0];
  let bestDist = Math.abs(beats[0].t - t);
  for (const b of beats) {
    const d = Math.abs(b.t - t);
    const score = preferDownbeat && b.downbeat ? d - 0.02 : d;
    const bestScore =
      preferDownbeat && best.downbeat ? bestDist - 0.02 : bestDist;
    if (score < bestScore) {
      best = b;
      bestDist = d;
    }
  }
  // Only snap if reasonably close (< half beat)
  const lim = (musicMap.beatDur || 0.5) * 0.55;
  if (Math.abs(best.t - t) > lim) return t;
  return best.t;
}

/**
 * Snap beat startSec/endSec to the music grid (downbeats preferred for cuts).
 */
export function snapBeatTimingsToMusic(beats, musicMap, durationSec) {
  const list = Array.isArray(beats) ? beats.map((b) => ({ ...b })) : [];
  if (!list.length || !musicMap?.beats?.length) return list;
  const dur = Math.max(
    0.1,
    Number(durationSec) || Number(musicMap.durationSec) || 75,
  );

  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    const role = String(b.beatRole || b.actionPhase || "").toLowerCase();
    const preferDown = role !== "react";
    let start = Number(b.startSec);
    let end = Number(b.endSec);
    if (!Number.isFinite(start)) start = (i / list.length) * dur;
    if (!Number.isFinite(end)) end = ((i + 1) / list.length) * dur;

    start = nearestBeatTime(start, musicMap, { preferDownbeat: preferDown });
    end = nearestBeatTime(end, musicMap, {
      preferDownbeat: role === "peak" || role === "action",
    });
    if (end <= start + 0.35) {
      end = start + Math.max(0.5, musicMap.beatDur || 0.5);
    }
    b.startSec = Math.round(start * 1000) / 1000;
    b.endSec = Math.round(Math.min(dur, end) * 1000) / 1000;
    b.music = {
      startBeat: musicMap.beats.find((x) => Math.abs(x.t - b.startSec) < 0.02)?.i ?? null,
      endBeat: musicMap.beats.find((x) => Math.abs(x.t - b.endSec) < 0.02)?.i ?? null,
      bpm: musicMap.bpm,
    };
  }

  // Enforce monotonic non-overlap
  list[0].startSec = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i].startSec < list[i - 1].endSec - 0.01) {
      list[i].startSec = list[i - 1].endSec;
    }
    if (list[i].endSec <= list[i].startSec + 0.3) {
      list[i].endSec =
        list[i].startSec + Math.max(0.5, musicMap.beatDur || 0.5);
    }
  }
  list[list.length - 1].endSec = dur;
  return list;
}

/**
 * Crossfade duration in seconds for ~half a beat (musical).
 */
export function musicalCrossfadeSec(musicMap, fallback = 0.2) {
  const beatDur = Number(musicMap?.beatDur);
  if (Number.isFinite(beatDur) && beatDur > 0.1) {
    return clamp(beatDur * 0.45, 0.12, 0.35);
  }
  return fallback;
}
