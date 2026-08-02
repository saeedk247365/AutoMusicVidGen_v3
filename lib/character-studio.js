/**
 * Character studio: status + background jobs for master / dataset / train.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { readdir, readFile, writeFile, mkdir, copyFile, unlink, rm } from "fs/promises";
import { join, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import sharp from "sharp";
import { stripBom } from "./comfy-client.js";
import { toChromaTrainingPlate } from "./chroma-plate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHARACTERS_DIR = join(ROOT, "characters");

/** @type {Map<string, object>} */
const jobs = new Map();
export const characterStudioEvents = new EventEmitter();

/** Auto-fill presets for Create character + Character studio. */
export const CHARACTER_PRESETS = [
  {
    id: "adult_man",
    label: "Adult man",
    role: "helper",
    gender: "man",
    ageBand: "adult",
    styleFamily: "kids3d",
    age: "adult man, about 32 years old",
    styleTag: "adult man cartoon proportions, father character only",
    appearance:
      "cute cartoon adult man, short neat brown hair, friendly eyes, light stubble optional, warm smile, slim athletic dad build",
    outfit:
      "solid navy blue short-sleeve polo shirt, khaki chino pants, brown casual shoes",
    negative:
      "photo, photorealistic, 3d render, child, toddler, baby, teen, woman, feminine, beard heavy, hat, logo, text, watermark, twin, two people, blurry, extra limbs",
  },
  {
    id: "adult_woman",
    label: "Adult woman",
    role: "helper",
    gender: "woman",
    ageBand: "adult",
    styleFamily: "kids3d",
    age: "adult woman, about 30 years old",
    styleTag: "adult woman cartoon proportions, mother character only",
    appearance:
      "cute cartoon adult mom, feminine soft face, shoulder-length wavy brown hair, warm eyes, kind smile",
    outfit:
      "solid soft coral pink short-sleeve blouse, solid cream long pants, white sneakers",
    negative:
      "photo, photorealistic, 3d render, child, toddler, baby, teen, masculine, man, beard, hat, logo, text, watermark, twin, two people, blurry",
  },
  {
    id: "lego_batman",
    label: "Lego Batman",
    role: "other",
    gender: "man",
    ageBand: "adult",
    styleFamily: "flat2d",
    age: "lego minifigure batman, toy figure",
    styleTag: "lego minifigure style, plastic toy proportions, blocky lego body",
    appearance:
      "lego batman minifigure, yellow plastic skin face with printed smile, black batman cowl with pointed ears, blocky cylindrical lego hands, short lego legs, classic batman chest emblem printed on torso",
    outfit:
      "black lego batman suit torso with yellow bat emblem, black cape, black boots, no fabric wrinkles",
    negative:
      "photo, photorealistic, realistic human, flesh, detailed anatomy, fingers, real cape cloth, text, watermark, twin, two people, blurry, melted plastic",
  },
  {
    id: "toddler",
    label: "Toddler",
    role: "toddler",
    gender: "boy",
    ageBand: "toddler",
    styleFamily: "kids3d",
    age: "toddler boy, about 2 years old",
    styleTag: "slim toddler boy cartoon proportions, male child only",
    appearance:
      "cute cartoon 2-year-old toddler boy, oversized round head, big sparkling eyes, small nose, soft round cheeks, gentle smile, fair skin, short stubby limbs, slim toddler proportions, head-to-body ratio about 1:4",
    outfit: "solid sky blue crew neck t-shirt, navy toddler pants, white sneakers",
    negative:
      "photo, photorealistic, 3d render, girl, female, teen, adult, older child, long legs, tall proportions, small head, extra limbs, twin, two people, text, watermark, different clothes",
  },
  {
    id: "age_5",
    label: "5 year old",
    role: "toddler",
    gender: "boy",
    ageBand: "child",
    styleFamily: "kids3d",
    age: "child boy, about 5 years old",
    styleTag: "young boy cartoon proportions, preschool age, male child only",
    appearance:
      "cute cartoon 5-year-old boy, big friendly eyes, short soft brown hair, small nose, bright smile, slim kid build slightly taller than toddler",
    outfit:
      "bright blue crew neck t-shirt, denim kid shorts, white sneakers with socks",
    negative:
      "photo, photorealistic, 3d render, baby, adult, teen, girl, female, beard, extra limbs, twin, two people, text, watermark",
  },
  {
    id: "age_10",
    label: "10 year old",
    role: "other",
    gender: "boy",
    ageBand: "child",
    styleFamily: "kids3d",
    age: "child boy, about 10 years old",
    styleTag: "preteen boy cartoon proportions, male child only",
    appearance:
      "cute cartoon 10-year-old boy, friendly eyes, neat short hair, confident soft smile, slim kid-athlete build",
    outfit: "solid green crew neck t-shirt, navy kids pants, gray sneakers",
    negative:
      "photo, photorealistic, 3d render, toddler, baby, adult, teen facial hair, girl, extra limbs, twin, two people, text, watermark",
  },
  {
    id: "teenager",
    label: "Teenager",
    role: "other",
    gender: "boy",
    ageBand: "teen",
    styleFamily: "kids3d",
    age: "teenager boy, about 15 years old",
    styleTag: "teen boy cartoon proportions, adolescent male only",
    appearance:
      "cute cartoon teenage boy, friendly eyes, short styled brown hair, soft teen face, slim youthful build",
    outfit: "solid navy hoodie, solid gray jeans, white sneakers",
    negative:
      "photo, photorealistic, 3d render, toddler, baby, adult wrinkles, girl, beard heavy, extra limbs, twin, two people, text, watermark",
  },
];

export function datasetDirFor(id) {
  return join(ROOT, "dataset", String(id || "").toLowerCase());
}

export function characterPath(id) {
  return join(CHARACTERS_DIR, `${String(id).toLowerCase()}.json`);
}

export function masterImagePath(id) {
  return join(datasetDirFor(id), "master_identity.png");
}

export function mastersDirFor(id) {
  return join(datasetDirFor(id), "masters");
}

export async function loadCharacter(id) {
  const path = characterPath(id);
  if (!existsSync(path)) return null;
  return JSON.parse(stripBom(await readFile(path, "utf8")));
}

export function defaultShotsForRole(role = "toddler") {
  const isHelper = /mom|helper|adult|parent/i.test(role);
  const stance = isHelper
    ? "standing straight, arms relaxed at sides"
    : "standing with slim toddler stance, arms relaxed at sides, feet slightly apart";
  return [
    {
      id: "01_front_stand",
      angleKey: "front",
      angle: "front view, body facing camera, looking at camera",
      pose: stance,
      poseKey: "stand",
      expression: "neutral",
      captionExtra: "standing, front view",
    },
    {
      id: "02_side_stand",
      angleKey: "side_left",
      angle:
        "strict left profile side view, 90 degrees, body and face both facing left, natural neck, only one eye and one ear visible, nose pointing left, NOT facing camera",
      pose: `${stance}, head aligned with torso`,
      poseKey: "stand",
      expression: "neutral",
      captionExtra: "standing, left profile",
      extraNegative:
        "front view, facing camera, both eyes visible equally, looking at camera, twisted neck, eye contact",
    },
    {
      id: "03_threequarter_stand",
      angleKey: "threequarter_left",
      angle:
        "three-quarter view from the left, body turned 40 degrees to the left, face turned with body looking left-forward, natural neck alignment, NOT facing camera",
      pose: stance,
      poseKey: "stand",
      expression: "neutral",
      captionExtra: "standing, three-quarter left",
      extraNegative:
        "front view, facing camera, looking at viewer, twisted neck, eye contact",
    },
    {
      id: "04_wave",
      angleKey: "front",
      angle: "front view, body facing camera, looking at camera",
      pose: "standing, right arm raised waving hello, left arm at side",
      poseKey: "wave",
      expression: "happy",
      captionExtra: "waving, front view",
    },
    {
      id: "05_point",
      angleKey: "front",
      angle: "front view, body facing camera, looking at camera",
      pose: "standing, right arm extended pointing forward, left arm at side",
      poseKey: "point",
      expression: "neutral",
      captionExtra: "pointing, front view",
    },
    {
      id: "06_hands_up",
      angleKey: "front",
      angle: "front view, body facing camera, looking at camera",
      pose: "standing, both arms raised high above head, happy reach",
      poseKey: "hands_up",
      expression: "happy",
      captionExtra: "hands up, front view",
    },
    {
      id: "07_sit",
      angleKey: "front",
      angle: "front view, body facing camera, looking at camera",
      pose: isHelper
        ? "sitting upright on a chair, hands resting on lap"
        : "sitting on the floor, knees bent, hands resting on thighs, exactly two clear legs",
      poseKey: "sit",
      expression: "neutral",
      captionExtra: "sitting, front view",
    },
    {
      id: "08_walk",
      angleKey: "threequarter_right",
      angle:
        "three-quarter view from the right, body turned 40 degrees to the right, face turned with body, NOT facing camera",
      pose: "walking mid-stride, left leg forward, arms swinging naturally, exactly two legs only",
      poseKey: "walk",
      expression: "neutral",
      captionExtra: "walking, three-quarter right",
      extraNegative: "front view, facing camera, ghost legs, double legs, eye contact",
    },
    {
      id: "09_bust_smile",
      angleKey: "front",
      angle: "front view bust portrait, looking at camera",
      pose: isHelper
        ? "friendly smile, shoulders visible"
        : "happy smile, shoulders visible",
      poseKey: "bust",
      expression: "happy",
      captionExtra: "bust smile",
      bust: true,
    },
    {
      id: "10_bust_neutral",
      angleKey: "front",
      angle: "front view bust portrait, looking at camera",
      pose: "neutral friendly face, shoulders visible",
      poseKey: "bust",
      expression: "neutral",
      captionExtra: "bust neutral",
      bust: true,
    },
    {
      id: "11_bust_sad",
      angleKey: "front",
      angle: "front view bust portrait, looking at camera",
      pose: "sad expression, downturned mouth, shoulders visible",
      poseKey: "bust",
      expression: "sad",
      captionExtra: "bust sad",
      bust: true,
    },
    {
      id: "12_bust_surprised",
      angleKey: "front",
      angle: "front view bust portrait, looking at camera",
      pose: "surprised expression, round open mouth, wide eyes, shoulders visible",
      poseKey: "bust",
      expression: "surprised",
      captionExtra: "bust surprised",
      bust: true,
    },
  ];
}

/** Ensure character JSON has a usable shots bank before dataset generation. */
export async function ensureCharacterShots(id) {
  const key = String(id).toLowerCase();
  const char = await loadCharacter(key);
  if (!char) return { ok: false, error: "Character not found" };
  if (Array.isArray(char.shots) && char.shots.length > 0) {
    return { ok: true, character: char, patched: false };
  }
  const shots = defaultShotsForRole(char.role || "toddler");
  const character = await saveCharacter(key, { shots });
  return { ok: true, character, patched: true, shotCount: shots.length };
}

export async function saveCharacter(id, patch) {
  const path = characterPath(id);
  const prev = existsSync(path)
    ? JSON.parse(stripBom(await readFile(path, "utf8")))
    : { id };
  const next = {
    ...prev,
    ...patch,
    id: String(id).toLowerCase(),
  };
  if (!Array.isArray(next.shots) || next.shots.length === 0) {
    next.shots = defaultShotsForRole(next.role || "toddler");
  }
  await mkdir(CHARACTERS_DIR, { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * Wipe a character so the same id can be recreated cleanly.
 * Removes: characters/{id}.json, dataset/{id}/, train-config-{id}.json,
 * and LoRA weights named in the character JSON (if present on disk).
 */
export async function deleteCharacter(id) {
  const key = String(id || "")
    .toLowerCase()
    .trim();
  if (!key || !/^[a-z0-9_-]+$/.test(key)) {
    return { ok: false, error: "Invalid character id" };
  }
  const existing = jobs.get(key);
  if (existing?.running) {
    return {
      ok: false,
      error: `Job still running (${existing.label}). Wait or cancel before deleting.`,
    };
  }

  const charPath = characterPath(key);
  const char = existsSync(charPath)
    ? JSON.parse(stripBom(await readFile(charPath, "utf8")))
    : null;
  if (!char && !existsSync(datasetDirFor(key))) {
    return { ok: false, error: "Character not found" };
  }

  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const warnings = [];

  const safeUnlink = async (p, label) => {
    if (!existsSync(p)) return;
    try {
      await unlink(p);
      removed.push(label || p);
    } catch (err) {
      warnings.push(`${label || p}: ${err.message || err}`);
    }
  };

  const safeRmDir = async (p, label) => {
    if (!existsSync(p)) return;
    try {
      await rm(p, { recursive: true, force: true });
      removed.push(label || p);
    } catch (err) {
      warnings.push(`${label || p}: ${err.message || err}`);
    }
  };

  // Dataset tree (masters, keyframes, shots, uploads, …)
  await safeRmDir(datasetDirFor(key), `dataset/${key}`);

  // Per-character train config
  await safeUnlink(
    join(ROOT, `train-config-${key}.json`),
    `train-config-${key}.json`,
  );

  // LoRA weights tied to this character
  const loraName = char?.loraName || `${char?.trigger || key}_character_v1.safetensors`;
  const loraCandidates = [
    join(ROOT, "ComfyUI", "models", "loras", loraName),
    join(ROOT, "loras", loraName),
  ];
  // Also try without path tricks if name already includes .safetensors
  const loraBase = String(loraName).replace(/\.safetensors$/i, "");
  for (const p of [
    ...loraCandidates,
    join(ROOT, "ComfyUI", "models", "loras", `${loraBase}.safetensors`),
    join(ROOT, "loras", `${loraBase}.safetensors`),
  ]) {
    await safeUnlink(p, `lora:${basename(p)}`);
  }

  // Character JSON last
  await safeUnlink(charPath, `characters/${key}.json`);

  jobs.delete(key);
  characterStudioEvents.emit("log", {
    id: key,
    line: `deleted character ${key} (${removed.length} paths)`,
  });

  return {
    ok: true,
    id: key,
    removed,
    warnings,
  };
}

export async function listMasterCandidates(id) {
  const key = String(id).toLowerCase();
  const dir = mastersDirFor(key);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir))
    .filter((f) => /^candidate_\d+\.png$/i.test(f))
    .sort();
  const stamp = Date.now();
  return files.map((file) => ({
    file,
    url: `/media/dataset/${encodeURIComponent(key)}/masters/${encodeURIComponent(file)}?t=${stamp}`,
  }));
}

export async function selectMasterCandidate(id, fileName) {
  const key = String(id).toLowerCase();
  const safe = basename(String(fileName || ""));
  if (!/^candidate_\d+\.png$/i.test(safe)) {
    return { ok: false, error: "Invalid candidate file" };
  }
  const dir = mastersDirFor(key);
  const src = join(dir, safe);
  if (!existsSync(src)) {
    return { ok: false, error: "Candidate not found" };
  }
  const outDir = datasetDirFor(key);
  const master = join(outDir, "master_identity.png");
  const faceLock = join(outDir, "face_lock.png");
  const approved = join(outDir, "master_approved.json");
  await mkdir(outDir, { recursive: true });
  await copyFile(src, master);
  await copyFile(src, faceLock);
  if (existsSync(approved)) {
    try {
      await unlink(approved);
    } catch {
      /* ignore */
    }
  }

  // Chosen master is already in master_identity.png — clear the candidate strip entirely.
  if (existsSync(dir)) {
    const files = await readdir(dir);
    for (const f of files) {
      try {
        await unlink(join(dir, f));
      } catch {
        /* ignore */
      }
    }
    await writeFile(
      join(dir, "index.json"),
      JSON.stringify(
        {
          selected: safe,
          selectedAt: new Date().toISOString(),
          candidates: [],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  return {
    ok: true,
    master: {
      exists: true,
      approved: false,
      url: `/media/dataset/${encodeURIComponent(key)}/master_identity.png?t=${Date.now()}`,
      selected: safe,
    },
    candidates: [],
  };
}

function shotIdFromImageFile(trigger, file) {
  const base = String(file || "").replace(/\.(png|jpe?g|webp)$/i, "");
  const prefix = `${String(trigger || "").toLowerCase()}_`;
  const lower = base.toLowerCase();
  if (!lower.startsWith(prefix)) return null;
  const rest = base.slice(prefix.length);
  if (!rest || /^00_master/i.test(rest)) return null;
  return rest;
}

export async function updateShot(id, shotId, patch = {}) {
  const key = String(id).toLowerCase();
  const char = await loadCharacter(key);
  if (!char) return { ok: false, error: "Character not found" };
  await ensureCharacterShots(key);
  const fresh = await loadCharacter(key);
  const shots = Array.isArray(fresh.shots) ? [...fresh.shots] : [];
  const idx = shots.findIndex((s) => s.id === shotId);
  if (idx < 0) return { ok: false, error: `Shot not found: ${shotId}` };

  const allowed = [
    "pose",
    "angle",
    "angleKey",
    "poseKey",
    "expression",
    "captionExtra",
    "extraNegative",
    "appearance",
    "outfit",
    "negative",
    "bust",
    "background",
  ];
  const next = { ...shots[idx] };
  for (const k of allowed) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  if (patch.bust !== undefined) next.bust = !!patch.bust;
  shots[idx] = next;
  const character = await saveCharacter(key, { shots });
  return { ok: true, shot: next, character };
}

export async function regenerateShot(id, shotId, { patch = null } = {}) {
  const key = String(id).toLowerCase();
  const approved = join(datasetDirFor(key), "master_approved.json");
  if (!existsSync(approved)) {
    return {
      ok: false,
      error: "Master not approved yet — approve master first",
    };
  }
  if (patch && Object.keys(patch).length) {
    const updated = await updateShot(key, shotId, patch);
    if (!updated.ok) return updated;
  } else {
    const char = await loadCharacter(key);
    if (!char?.shots?.some((s) => s.id === shotId)) {
      return { ok: false, error: `Shot not found: ${shotId}` };
    }
  }

  const charRel = `characters/${key}.json`;
  const outRel = `dataset/${key}`;
  const args = [
    "scripts/generate-dataset.js",
    "--character",
    charRel,
    "--out",
    outRel,
    "--shots-only",
    "--only",
    shotId,
    "--force",
    "--no-open",
    "--comfy",
    "http://127.0.0.1:8888",
  ];
  return runNodeJob(id, `Regen shot ${shotId}`, args);
}

/** Canonical keyframe bank ids (base + toddler). Import accepts any of these. */
export const KNOWN_KEYFRAME_IDS = [
  "front",
  "left30",
  "left45",
  "right30",
  "right45",
  "left_profile",
  "right_profile",
  "back",
  "smile",
  "neutral",
  "sit",
  "crawl",
  "walk",
  "hands_up",
  "wave",
  "point",
  "happy_face",
  "sad_face",
  "surprised_face",
];

/**
 * Human guide for Gemini/manual pose bank uploads.
 * Filename must be `{id}.png` (e.g. left_profile.png — that is the 90° side view).
 */
export const KEYFRAME_POSE_GUIDE = [
  {
    id: "front",
    group: "Yaw (body turn)",
    file: "front.png",
    title: "Front stand (0°)",
    hint: "Facing camera straight on. Arms at sides. This is also your master identity seed.",
  },
  {
    id: "left30",
    group: "Yaw (body turn)",
    file: "left30.png",
    title: "Soft three-quarter LEFT (~30°)",
    hint: "Body and head turned a little toward viewer’s left. Still see both eyes; not a full side view. NOT 90°.",
  },
  {
    id: "left45",
    group: "Yaw (body turn)",
    file: "left45.png",
    title: "Three-quarter LEFT (~45–55°)",
    hint: "Clearer turn left than left30. Far eye smaller / partly hidden. Still not profile. NOT 90°.",
  },
  {
    id: "left_profile",
    group: "Yaw (body turn)",
    file: "left_profile.png",
    title: "LEFT profile / side (~90°) — use this for “left90”",
    hint: "Strict side view facing left. One eye, one ear, nose pointing left. Filename is left_profile.png (there is no left90.png).",
  },
  {
    id: "right30",
    group: "Yaw (body turn)",
    file: "right30.png",
    title: "Soft three-quarter RIGHT (~30°)",
    hint: "Same as left30 but turned toward viewer’s right.",
  },
  {
    id: "right45",
    group: "Yaw (body turn)",
    file: "right45.png",
    title: "Three-quarter RIGHT (~45–55°)",
    hint: "Same as left45 but turned right. NOT 90°.",
  },
  {
    id: "right_profile",
    group: "Yaw (body turn)",
    file: "right_profile.png",
    title: "RIGHT profile / side (~90°) — use this for “right90”",
    hint: "Strict side view facing right. Filename is right_profile.png (there is no right90.png).",
  },
  {
    id: "back",
    group: "Yaw (body turn)",
    file: "back.png",
    title: "Rear three-quarter",
    hint: "Mostly from behind, back of head / shoulders visible. Not looking at camera.",
  },
  {
    id: "smile",
    group: "Expression / face",
    file: "smile.png",
    title: "Front stand + soft smile",
    hint: "Full body front, friendly closed-mouth smile, same outfit.",
  },
  {
    id: "neutral",
    group: "Expression / face",
    file: "neutral.png",
    title: "Bust / shoulders neutral",
    hint: "Close-up from chest up, neutral face, looking at camera.",
  },
  {
    id: "happy_face",
    group: "Expression / face",
    file: "happy_face.png",
    title: "Happy close face",
    hint: "Bust or face crop, happy smile. Toddler bank.",
  },
  {
    id: "sad_face",
    group: "Expression / face",
    file: "sad_face.png",
    title: "Sad close face",
    hint: "Bust crop, sad expression. Toddler bank.",
  },
  {
    id: "surprised_face",
    group: "Expression / face",
    file: "surprised_face.png",
    title: "Surprised close face",
    hint: "Bust crop, wide eyes / open mouth. Toddler bank.",
  },
  {
    id: "wave",
    group: "Gestures",
    file: "wave.png",
    title: "Wave hello",
    hint: "Front-ish, one arm raised waving. Keep same clothes/face.",
  },
  {
    id: "point",
    group: "Gestures",
    file: "point.png",
    title: "Point forward",
    hint: "One arm extended pointing. Same identity/outfit.",
  },
  {
    id: "hands_up",
    group: "Gestures",
    file: "hands_up.png",
    title: "Both hands up",
    hint: "Both arms raised high. Same identity/outfit.",
  },
  {
    id: "sit",
    group: "Body poses",
    file: "sit.png",
    title: "Sitting",
    hint: "Sitting (floor or chair). Legs clear, same outfit. Toddler bank.",
  },
  {
    id: "crawl",
    group: "Body poses",
    file: "crawl.png",
    title: "Crawl / all fours",
    hint: "Toddler crawl pose. Toddler bank.",
  },
  {
    id: "walk",
    group: "Body poses",
    file: "walk.png",
    title: "Walk mid-stride",
    hint: "Walking pose, one foot forward. Toddler bank.",
  },
];

/** Pose guide + which files already exist for a character. */
export async function keyframePoseGuideStatus(id) {
  const key = String(id || "").toLowerCase();
  const char = key ? await loadCharacter(key) : null;
  const keyframesDir = key ? join(datasetDirFor(key), "keyframes") : null;
  const manual = key ? await loadManualSources(key) : {};
  const present = new Set();
  if (keyframesDir && existsSync(keyframesDir)) {
    for (const f of await readdir(keyframesDir)) {
      if (/\.(png|jpe?g|webp)$/i.test(f)) {
        present.add(f.replace(/\.(png|jpe?g|webp)$/i, "").toLowerCase());
      }
    }
  }
  const ageBlob = char
    ? `${char.role || ""} ${char.age || ""} ${char.ageBand || ""} ${char.appearance || ""}`
    : "toddler";
  const toddler = /toddler|2 year|baby|infant|preschool/i.test(ageBlob);
  const toddlerOnly = new Set([
    "sit",
    "crawl",
    "walk",
    "hands_up",
    "wave",
    "point",
    "happy_face",
    "sad_face",
    "surprised_face",
  ]);
  const poses = KEYFRAME_POSE_GUIDE.map((p) => ({
    ...p,
    required: toddler || !toddlerOnly.has(p.id),
    present: present.has(p.id),
    manual: Boolean(manual[p.id]),
  }));
  return {
    ok: true,
    characterId: key || null,
    tip: "Name Gemini exports exactly like the File column (e.g. left_profile.png for 90° side — not left90.png).",
    poses,
  };
}

function manualSourcesPath(id) {
  return join(datasetDirFor(id), "keyframes", "manual_sources.json");
}

async function loadManualSources(id) {
  const path = manualSourcesPath(id);
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

async function upsertManualSource(id, keyframeId, meta = {}) {
  const key = String(id).toLowerCase();
  const kfId = String(keyframeId);
  const dir = join(datasetDirFor(key), "keyframes");
  await mkdir(dir, { recursive: true });
  const map = await loadManualSources(key);
  map[kfId] = {
    id: kfId,
    importedAt: new Date().toISOString(),
    source: "upload",
    ...meta,
  };
  await writeFile(manualSourcesPath(key), JSON.stringify(map, null, 2), "utf8");
  return map[kfId];
}

async function clearManualSource(id, keyframeId) {
  const key = String(id).toLowerCase();
  const path = manualSourcesPath(key);
  if (!existsSync(path)) return;
  const map = await loadManualSources(key);
  if (!map[keyframeId]) return;
  delete map[keyframeId];
  await writeFile(path, JSON.stringify(map, null, 2), "utf8");
}

/**
 * Import a Gemini/manual plate as a keyframe (chroma-normalized).
 * Uploading `front` also updates master + face_lock + approval stamp.
 */
export async function importKeyframe(id, keyframeId, buffer) {
  const key = String(id).toLowerCase();
  const kfId = String(keyframeId || "")
    .replace(/\.png$/i, "")
    .replace(/\.jpe?g$/i, "")
    .replace(/\.webp$/i, "")
    .toLowerCase()
    .trim();
  const char = await loadCharacter(key);
  if (!char) return { ok: false, error: "Character not found" };
  if (!KNOWN_KEYFRAME_IDS.includes(kfId)) {
    return {
      ok: false,
      error: `Unknown keyframe id "${kfId}". Use one of: ${KNOWN_KEYFRAME_IDS.join(", ")}`,
    };
  }
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) {
    return { ok: false, error: "Empty or invalid image data" };
  }
  if (buffer.length > 12 * 1024 * 1024) {
    return { ok: false, error: "Image too large (max 12MB)" };
  }

  const outDir = datasetDirFor(key);
  const masterPath = join(outDir, "master_identity.png");
  const approvedPath = join(outDir, "master_approved.json");
  const hasMaster = existsSync(masterPath);
  const approved = existsSync(approvedPath) && hasMaster;

  // Non-front imports require an approved master (identity seed).
  // front may bootstrap master when missing.
  if (kfId !== "front" && !approved) {
    return {
      ok: false,
      error: "Master not approved yet — approve master or import front first",
    };
  }

  const width = Number(char.width) || 512;
  const height = Number(char.height) || 768;
  const plate = await normalizeMasterCanvas(buffer, { width, height });
  if (!plate.rembg) {
    return {
      ok: false,
      error:
        plate.rembgError ||
        "Could not cut out subject (rembg). Use a clearer cutout and try again.",
    };
  }

  const keyframesDir = join(outDir, "keyframes");
  await mkdir(keyframesDir, { recursive: true });
  const outPath = join(keyframesDir, `${kfId}.png`);
  await writeFile(outPath, plate.buffer);

  if (kfId === "front") {
    await mkdir(outDir, { recursive: true });
    await writeFile(masterPath, plate.buffer);
    await writeFile(join(outDir, "face_lock.png"), plate.buffer);
    const stamp = {
      approvedAt: new Date().toISOString(),
      character: key,
      source: "keyframe-import-front",
      masterPath: `dataset/${key}/master_identity.png`,
      chromaPlate: true,
    };
    await writeFile(approvedPath, JSON.stringify(stamp, null, 2), "utf8");
  }

  const entry = await upsertManualSource(key, kfId, {
    rembg: true,
    width: plate.width,
    height: plate.height,
  });

  characterStudioEvents.emit("log", {
    id: key,
    line: `imported keyframe ${kfId}.png (manual / chroma)`,
  });

  const stamp = Date.now();
  return {
    ok: true,
    keyframeId: kfId,
    path: outPath,
    url: `/media/dataset/${encodeURIComponent(key)}/keyframes/${encodeURIComponent(kfId)}.png?t=${stamp}`,
    rembg: true,
    masterUpdated: kfId === "front",
    manual: entry,
  };
}

/**
 * Multi-file pose bank import. Filename stem must match a known keyframe id
 * (e.g. left45.png, Wave.PNG → wave).
 */
export async function importKeyframeBank(id, files = []) {
  const key = String(id).toLowerCase();
  const char = await loadCharacter(key);
  if (!char) return { ok: false, error: "Character not found" };
  if (!Array.isArray(files) || !files.length) {
    return { ok: false, error: "No files to import" };
  }
  if (files.length > 20) {
    return { ok: false, error: "Too many files (max 20)" };
  }

  const imported = [];
  const skipped = [];

  // Prefer front first so other imports can rely on approval.
  const ordered = [...files].sort((a, b) => {
    const stem = (f) =>
      String(f?.name || f?.keyframeId || "")
        .replace(/\.[^.]+$/, "")
        .toLowerCase();
    const sa = stem(a);
    const sb = stem(b);
    if (sa === "front") return -1;
    if (sb === "front") return 1;
    return sa.localeCompare(sb);
  });

  for (const file of ordered) {
    const name = String(file?.name || file?.keyframeId || "");
    const stem = name
      .replace(/^.*[\\/]/, "")
      .replace(/\.[^.]+$/, "")
      .toLowerCase()
      .trim();
    if (!stem) {
      skipped.push({ name, error: "Missing filename" });
      continue;
    }
    if (!KNOWN_KEYFRAME_IDS.includes(stem)) {
      skipped.push({
        name,
        error: `Unknown id "${stem}" (expected e.g. left45.png, wave.png)`,
      });
      continue;
    }
    let buffer = file.buffer;
    if (!buffer && file.imageBase64) {
      const b64 = String(file.imageBase64).replace(/^data:[^;]+;base64,/, "");
      buffer = Buffer.from(b64, "base64");
    }
    if (!Buffer.isBuffer(buffer)) {
      skipped.push({ name, error: "Invalid image data" });
      continue;
    }
    const result = await importKeyframe(key, stem, buffer);
    if (result.ok) {
      imported.push({ name, keyframeId: stem, url: result.url });
    } else {
      skipped.push({ name, keyframeId: stem, error: result.error || "import failed" });
    }
  }

  return {
    ok: imported.length > 0,
    imported,
    skipped,
    importedCount: imported.length,
    skippedCount: skipped.length,
    error:
      imported.length === 0
        ? skipped[0]?.error || "Nothing imported"
        : undefined,
  };
}

export async function regenerateKeyframe(id, keyframeId) {
  const key = String(id).toLowerCase();
  const kfId = String(keyframeId || "").replace(/\.png$/i, "");
  const approved = join(datasetDirFor(key), "master_approved.json");
  if (!existsSync(approved)) {
    return {
      ok: false,
      error: "Master not approved yet — approve master first",
    };
  }
  if (!kfId) return { ok: false, error: "Missing keyframe id" };

  const outDir = datasetDirFor(key);
  const masterPath = join(outDir, "master_identity.png");
  if (!existsSync(masterPath)) {
    return { ok: false, error: "No master image" };
  }

  // front is always a byte-copy of the normalized master — never invent from noise
  if (kfId === "front") {
    const keyframesDir = join(outDir, "keyframes");
    await mkdir(keyframesDir, { recursive: true });
    await copyFile(masterPath, join(keyframesDir, "front.png"));
    await clearManualSource(key, "front");
    characterStudioEvents.emit("log", {
      id: key,
      line: "front.png ← re-copied from master_identity.png",
    });
    return { ok: true, copied: true, keyframeId: "front" };
  }

  await clearManualSource(key, kfId);

  const charRel = `characters/${key}.json`;
  const outRel = `dataset/${key}`;
  const args = [
    "scripts/generate-dataset.js",
    "--character",
    charRel,
    "--out",
    outRel,
    "--keyframes-only",
    "--only",
    kfId,
    "--force",
    "--no-open",
    "--comfy",
    "http://127.0.0.1:8888",
  ];
  return runNodeJob(id, `Regen keyframe ${kfId}`, args);
}

export async function characterStatus(id) {
  const char = await loadCharacter(id);
  if (!char) return { ok: false, error: "Character not found" };
  const outDir = datasetDirFor(id);
  const masterPath = join(outDir, "master_identity.png");
  const approvedPath = join(outDir, "master_approved.json");
  const imagesDir = join(outDir, "images");
  const keyframesDir = join(outDir, "keyframes");
  const stamp = Date.now();
  const key = String(id).toLowerCase();
  let imageFiles = [];
  if (existsSync(imagesDir)) {
    imageFiles = (await readdir(imagesDir))
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .sort();
  }
  let keyframeFiles = [];
  if (existsSync(keyframesDir)) {
    keyframeFiles = (await readdir(keyframesDir))
      .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
      .sort();
  }
  const keyframeCount = keyframeFiles.length;
  const imageCount = imageFiles.length;
  const loraName = char.loraName || null;
  const loraCandidates = [
    loraName ? join(ROOT, "ComfyUI", "models", "loras", loraName) : null,
    loraName ? join(ROOT, "loras", loraName) : null,
  ].filter(Boolean);
  const hasLoraFile = loraCandidates.some((p) => existsSync(p));
  const job = jobs.get(key) || null;
  const candidates = await listMasterCandidates(id);
  const shotCount = Array.isArray(char.shots) ? char.shots.length : 0;
  const trigger = char.trigger || key;
  const trainingImageCount = imageFiles.filter(
    (f) => !/_00_master_identity\./i.test(f),
  ).length;
  // Toddler bank is larger (base 10 + toddler extras). Keep in sync with generate-dataset.js.
  const ageBlob = `${char.role || ""} ${char.age || ""} ${char.ageBand || ""} ${char.appearance || ""} ${char.styleTag || ""}`;
  const keyframeTotal = /toddler|2 year|baby|infant|preschool/i.test(ageBlob)
    ? 19
    : 10;
  const shotById = new Map(
    (char.shots || []).map((s) => [s.id, s]),
  );
  const images = imageFiles.map((file) => {
    const shotId = shotIdFromImageFile(trigger, file);
    const shot = shotId ? shotById.get(shotId) || null : null;
    return {
      file,
      shotId,
      editable: Boolean(shot),
      url: `/media/dataset/${encodeURIComponent(key)}/images/${encodeURIComponent(file)}?t=${stamp}`,
      shot: shot
        ? {
            id: shot.id,
            pose: shot.pose || "",
            angle: shot.angle || "",
            angleKey: shot.angleKey || "front",
            poseKey: shot.poseKey || "stand",
            expression: shot.expression || "neutral",
            captionExtra: shot.captionExtra || "",
            extraNegative: shot.extraNegative || "",
            appearance: shot.appearance || "",
            outfit: shot.outfit || "",
            negative: shot.negative || "",
            bust: !!shot.bust,
          }
        : null,
    };
  });
  const keyframes = [];
  const manualMap = await loadManualSources(key);
  for (const file of keyframeFiles) {
    if (/^manual_sources\.json$/i.test(file)) continue;
    const abs = join(keyframesDir, file);
    const kfId = file.replace(/\.(png|jpe?g|webp)$/i, "");
    let gateFail = false;
    let gateReasons = [];
    try {
      const { checkChromaBorder, checkOutfitPalette } = await import(
        "./chroma-plate.js"
      );
      if (existsSync(masterPath)) {
        const chroma = await checkChromaBorder(abs);
        const palette = await checkOutfitPalette(abs, masterPath);
        if (!chroma.pass) {
          gateFail = true;
          gateReasons.push(chroma.reason || "bg_not_chroma");
        }
        if (!palette.pass) {
          gateFail = true;
          gateReasons.push(palette.reason || "outfit_drift");
        }
      }
    } catch {
      /* ignore gate probe errors */
    }
    keyframes.push({
      file,
      id: kfId,
      url: `/media/dataset/${encodeURIComponent(key)}/keyframes/${encodeURIComponent(file)}?t=${stamp}`,
      gateFail,
      gateReasons,
      manual: Boolean(manualMap[kfId]),
    });
  }

  const running = !!job?.running;
  let progress;
  if (trainingImageCount > 0 || (keyframeCount >= keyframeTotal && shotCount > 0)) {
    progress = {
      phase: trainingImageCount >= shotCount && shotCount > 0 ? "done" : "shots",
      done: trainingImageCount,
      total: shotCount || null,
      keyframesDone: keyframeCount,
      keyframesTotal: keyframeTotal,
      label:
        shotCount > 0
          ? `Shots ${Math.min(trainingImageCount, shotCount)} / ${shotCount}`
          : `${trainingImageCount} shots`,
      overallDone: Math.min(keyframeCount, keyframeTotal) + trainingImageCount,
      overallTotal: keyframeTotal + shotCount,
    };
  } else {
    progress = {
      phase: "keyframes",
      done: keyframeCount,
      total: keyframeTotal,
      keyframesDone: keyframeCount,
      keyframesTotal: keyframeTotal,
      label: `Keyframes ${keyframeCount} / ${keyframeTotal}`,
      overallDone: keyframeCount,
      overallTotal: keyframeTotal + shotCount,
    };
  }
  if (running && progress.phase === "keyframes") {
    progress.label = `Keyframes ${keyframeCount} / ${keyframeTotal}`;
  } else if (running && progress.phase === "shots") {
    progress.label = `Shots ${trainingImageCount} / ${shotCount}`;
  }

  const refPath = join(outDir, "reference.png");
  const uploadsDir = join(outDir, "uploads");
  const faceRefUpload = ["png", "jpg", "jpeg", "webp"]
    .map((e) => join(uploadsDir, `face_ref.${e}`))
    .find((p) => existsSync(p));
  const stillUpload = ["png", "jpg", "jpeg", "webp"]
    .map((e) => join(uploadsDir, `set_master.${e}`))
    .find((p) => existsSync(p));

  return {
    ok: true,
    character: char,
    datasetDir: `dataset/${key}`,
    master: {
      exists: existsSync(masterPath),
      approved: existsSync(approvedPath) && existsSync(masterPath),
      url: existsSync(masterPath)
        ? `/media/dataset/${encodeURIComponent(id)}/master_identity.png?t=${stamp}`
        : null,
      path: masterPath,
    },
    uploads: {
      faceRef: existsSync(refPath) || !!faceRefUpload,
      faceRefUrl: existsSync(refPath)
        ? `/media/dataset/${encodeURIComponent(key)}/reference.png?t=${stamp}`
        : null,
      cartoonStill: !!stillUpload,
      cartoonStillUrl: stillUpload
        ? `/media/dataset/${encodeURIComponent(key)}/uploads/${encodeURIComponent(basename(stillUpload))}?t=${stamp}`
        : null,
    },
    candidates,
    dataset: {
      imageCount,
      trainingImageCount,
      keyframeCount,
      keyframeTotal,
      shotCount,
      ready: trainingImageCount >= 8 || imageCount >= 8,
      progress,
      images,
      keyframes,
    },
    lora: {
      name: loraName,
      exists: hasLoraFile,
    },
    job,
  };
}

function emitJob(id, job) {
  jobs.set(id, job);
  characterStudioEvents.emit("job", { id, ...job });
}

function runNodeJob(id, label, args) {
  const key = String(id).toLowerCase();
  const existing = jobs.get(key);
  if (existing?.running) {
    return { ok: false, error: `Job already running: ${existing.label}` };
  }

  const job = {
    running: true,
    label,
    startedAt: Date.now(),
    log: [],
    exitCode: null,
    error: null,
  };
  emitJob(key, job);

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    windowsHide: true,
    // Character studio always uses LOCAL Comfy — never inherit Salad GPU_BACKEND
    // so LoRA/dataset can run while mvid Wan runs on Salad.
    env: {
      ...process.env,
      GPU_BACKEND: "local",
      COMFY_URL: "http://127.0.0.1:8888",
    },
  });

  const push = (chunk, stream) => {
    const text = String(chunk || "");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      job.log.push({ t: Date.now(), stream, line: line.slice(0, 500) });
      if (job.log.length > 200) job.log.shift();
    }
    emitJob(key, { ...job });
  };

  child.stdout?.on("data", (d) => push(d, "out"));
  child.stderr?.on("data", (d) => push(d, "err"));
  child.on("error", (err) => {
    job.running = false;
    job.error = err.message || String(err);
    job.exitCode = 1;
    emitJob(key, { ...job });
  });
  child.on("exit", (code) => {
    job.running = false;
    job.exitCode = code;
    if (code !== 0 && !job.error) {
      job.error = `${label} exited with code ${code}`;
    }
    emitJob(key, { ...job });
  });

  return { ok: true, job };
}

export function startMasterGeneration(id, { force = false, count = 1, refPath = null } = {}) {
  const key = String(id).toLowerCase();
  const charRel = `characters/${key}.json`;
  const outRel = `dataset/${key}`;
  if (!existsSync(join(ROOT, charRel))) {
    return { ok: false, error: "Character JSON missing — save first" };
  }
  const n = Math.max(1, Math.min(10, Number(count) || 1));
  const args = [
    "scripts/generate-dataset.js",
    "--character",
    charRel,
    "--out",
    outRel,
    "--master-only",
    "--no-open",
    "--master-candidates",
    String(n),
    "--comfy",
    "http://127.0.0.1:8888",
  ];
  if (refPath) {
    args.push("--ref", refPath);
  } else {
    args.push("--bootstrap-from-text");
  }
  if (force) args.push("--force");
  return runNodeJob(
    id,
    refPath
      ? n > 1
        ? `Invent ${n} masters from face ref`
        : "Invent master from face ref"
      : n > 1
        ? `Generate ${n} masters`
        : "Generate master",
    args,
  );
}

export function startMasterFromStill(id, { stillPath, force = true } = {}) {
  const key = String(id).toLowerCase();
  const charRel = `characters/${key}.json`;
  const outRel = `dataset/${key}`;
  if (!existsSync(join(ROOT, charRel))) {
    return { ok: false, error: "Character JSON missing — save first" };
  }
  if (!stillPath || !existsSync(stillPath)) {
    return { ok: false, error: "Still image missing" };
  }
  const args = [
    "scripts/generate-dataset.js",
    "--character",
    charRel,
    "--out",
    outRel,
    "--master-only",
    "--set-master",
    stillPath,
    "--no-open",
    "--comfy",
    "http://127.0.0.1:8888",
  ];
  if (force) args.push("--force");
  return runNodeJob(id, "Install cartoon still as master", args);
}

/**
 * Fit an upload into the character canvas (default 512×768) on solid chroma green.
 * rembg subject → #00FF00 plate so LoRA never learns nursery/room backgrounds.
 */
export async function normalizeMasterCanvas(
  buffer,
  { width = 512, height = 768 } = {},
) {
  const meta = await sharp(buffer).metadata();
  const plate = await toChromaTrainingPlate(buffer, { width, height });
  return {
    buffer: plate.buffer,
    sourceWidth: meta.width || null,
    sourceHeight: meta.height || null,
    width,
    height,
    rembg: plate.rembg,
    rembgError: plate.error || null,
    resized: true,
  };
}

/**
 * Save a browser upload under dataset/<id>/uploads/.
 * @param {"face_ref"|"set_master"} kind
 */
export async function saveCharacterUpload(id, kind, buffer, { ext = "png" } = {}) {
  const key = String(id).toLowerCase();
  if (!["face_ref", "set_master"].includes(kind)) {
    return { ok: false, error: "Invalid upload kind" };
  }
  if (!Buffer.isBuffer(buffer) || buffer.length < 32) {
    return { ok: false, error: "Empty or invalid image data" };
  }
  if (buffer.length > 12 * 1024 * 1024) {
    return { ok: false, error: "Image too large (max 12MB)" };
  }
  const char = await loadCharacter(key);
  const width = Number(char?.width) || 512;
  const height = Number(char?.height) || 768;
  const outDir = join(datasetDirFor(key), "uploads");
  await mkdir(outDir, { recursive: true });

  let writeBuf = buffer;
  let normalized = null;
  if (kind === "set_master") {
    normalized = await normalizeMasterCanvas(buffer, { width, height });
    writeBuf = normalized.buffer;
    ext = "png";
  }

  const safeExt = String(ext || "png").replace(/^\./, "").toLowerCase();
  if (!/^(png|jpe?g|webp)$/i.test(safeExt)) {
    return { ok: false, error: "Only png/jpg/webp allowed" };
  }
  const fileName = `${kind}.${safeExt === "jpeg" ? "jpg" : safeExt}`;
  const abs = join(outDir, fileName);
  await writeFile(abs, writeBuf);

  if (kind === "face_ref") {
    // Keep original photo for InsightFace — do not force 512×768 here.
    const refPng = join(datasetDirFor(key), "reference.png");
    const refBuf = await sharp(buffer).rotate().png().toBuffer();
    await writeFile(refPng, refBuf);
    await saveCharacter(key, {
      referenceImage: `dataset/${key}/reference.png`,
    });
  }

  return {
    ok: true,
    path: abs,
    rel: `dataset/${key}/uploads/${fileName}`,
    kind,
    normalized,
  };
}

export async function startMasterFromUpload(
  id,
  {
    kind,
    buffer,
    ext = "png",
    force = true,
    count = 2,
    autofill = true,
  } = {},
) {
  const saved = await saveCharacterUpload(id, kind, buffer, { ext });
  if (!saved.ok) return saved;

  let describe = null;
  if (autofill) {
    try {
      const { describeAndAutofillCharacter } = await import(
        "./describe-character-image.js"
      );
      describe = await describeAndAutofillCharacter(id, {
        source: kind === "set_master" ? "set_master" : "face_ref",
        save: true,
        mergeEmptyOnly: false,
      });
    } catch (err) {
      describe = { ok: false, error: err.message || String(err) };
    }
  }

  if (kind === "face_ref") {
    const started = startMasterGeneration(id, {
      force,
      count,
      refPath: saved.path,
    });
    return { ...started, upload: saved, describe };
  }

  const started = startMasterFromStill(id, {
    stillPath: saved.path,
    force,
  });
  return { ...started, upload: saved, describe };
}

export async function approveMaster(id) {
  const key = String(id).toLowerCase();
  const outDir = datasetDirFor(key);
  const master = join(outDir, "master_identity.png");
  if (!existsSync(master)) {
    return { ok: false, error: "No master image yet — generate master first" };
  }
  const char = await loadCharacter(key);
  const width = Number(char?.width) || 512;
  const height = Number(char?.height) || 768;

  // Enforce training-plate contract on approve (rembg → solid chroma).
  const raw = await readFile(master);
  const plate = await toChromaTrainingPlate(raw, { width, height });
  if (!plate.rembg) {
    return {
      ok: false,
      error:
        plate.error ||
        "Could not cut out subject (rembg). Fix the master image and try again.",
    };
  }
  await writeFile(master, plate.buffer);
  await writeFile(join(outDir, "face_lock.png"), plate.buffer);
  const keyframesDir = join(outDir, "keyframes");
  await mkdir(keyframesDir, { recursive: true });
  await copyFile(master, join(keyframesDir, "front.png"));

  // Sync text locks to the approved plate pixels.
  let describe = null;
  try {
    const { describeAndAutofillCharacter } = await import(
      "./describe-character-image.js"
    );
    describe = await describeAndAutofillCharacter(key, {
      source: "master",
      save: true,
      mergeEmptyOnly: false,
    });
  } catch (err) {
    describe = { ok: false, error: err.message || String(err) };
  }

  const styleAlign = await alignStyleFamilyCheckpoint(key);

  const stamp = {
    approvedAt: new Date().toISOString(),
    character: key,
    source: "mvid-ui",
    masterPath: `dataset/${key}/master_identity.png`,
    chromaPlate: true,
    describeOk: Boolean(describe?.ok),
    styleAlign,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(
    join(outDir, "master_approved.json"),
    JSON.stringify(stamp, null, 2),
    "utf8",
  );
  return {
    ok: true,
    stamp,
    chromaPlate: true,
    describe,
    styleAlign,
    warning: styleAlign?.warning || null,
  };
}

/** Prefer installed checkpoint matching styleFamily; otherwise return a warning. */
export async function alignStyleFamilyCheckpoint(id) {
  const key = String(id).toLowerCase();
  const char = await loadCharacter(key);
  if (!char) return { ok: false, error: "Character not found" };
  const family = String(char.styleFamily || "").toLowerCase() || "kids3d";
  const preferred = {
    kids3d: ["realcartoon3d_v15.safetensors", "realcartoon3d.safetensors"],
    flat2d: [
      "anyloraCheckpoint_bakedvaeBlessedFp16.safetensors",
      "cartoonify_v10.safetensors",
      "flat2dAnimerge_v25.safetensors",
      "revAnimated_v2Rebirth.safetensors",
    ],
    anime: [
      "anyloraCheckpoint_bakedvaeBlessedFp16.safetensors",
      "counterfeitV30_v30.safetensors",
      "anything-v5-PrtRE.safetensors",
    ],
  };
  const ckptDir = join(ROOT, "ComfyUI", "models", "checkpoints");
  let installed = [];
  if (existsSync(ckptDir)) {
    installed = (await readdir(ckptDir)).filter((f) =>
      /\.safetensors$/i.test(f),
    );
  }
  const want = preferred[family] || preferred.kids3d;
  const hit = want.find((n) => installed.includes(n));
  const current = char.checkpoint || "";
  const patch = {};
  let warning = null;
  if (hit && hit !== current) {
    patch.checkpoint = hit;
  } else if (!hit && family === "flat2d" && /3d|cartoon3d|realcartoon/i.test(current)) {
    warning = `styleFamily is flat2d but checkpoint ${current || "(none)"} looks 3D — install a flat/anime checkpoint or expect CGI look`;
  } else if (!hit && family === "kids3d" && current && !/3d|cartoon3d|realcartoon/i.test(current)) {
    warning = `styleFamily is kids3d but checkpoint ${current} may not match`;
  }
  if (Object.keys(patch).length) {
    await saveCharacter(key, patch);
  }
  return {
    ok: true,
    family,
    checkpoint: patch.checkpoint || current,
    changed: Boolean(patch.checkpoint),
    warning,
  };
}

export async function startDatasetGeneration(id, { force = false } = {}) {
  const key = String(id).toLowerCase();
  const charRel = `characters/${key}.json`;
  const outRel = `dataset/${key}`;
  const approved = join(ROOT, outRel, "master_approved.json");
  if (!existsSync(approved)) {
    return {
      ok: false,
      error: "Master not approved yet — generate + approve master first",
    };
  }
  const ensured = await ensureCharacterShots(key);
  if (!ensured.ok) return ensured;
  const args = [
    "scripts/generate-dataset.js",
    "--character",
    charRel,
    "--out",
    outRel,
    "--no-open",
    "--comfy",
    "http://127.0.0.1:8888",
  ];
  if (force) args.push("--force");
  const started = runNodeJob(id, "Generate dataset", args);
  if (started.ok && ensured.patched) {
    started.job.log.push({
      t: Date.now(),
      stream: "out",
      line: `Auto-added ${ensured.shotCount} training shots to ${key}.json (was missing).`,
    });
    emitJob(key, { ...started.job });
  }
  return started;
}

export async function ensureTrainConfig(id) {
  const key = String(id).toLowerCase();
  const dest = join(ROOT, `train-config-${key}.json`);
  const src = existsSync(join(ROOT, "train-config-adam.json"))
    ? join(ROOT, "train-config-adam.json")
    : join(ROOT, "train-config.json");
  if (!existsSync(dest) && !existsSync(src)) {
    throw new Error("No train-config-adam.json / train-config.json to copy");
  }
  const raw = existsSync(dest)
    ? JSON.parse(stripBom(await readFile(dest, "utf8")))
    : JSON.parse(stripBom(await readFile(src, "utf8")));
  const char = await loadCharacter(key);
  const loraBase =
    char?.loraName?.replace(/\.safetensors$/i, "") ||
    `${char?.trigger || key}_character_v1`;
  // Always sync identity fields — never leave a cloned adam LoRA name on a new character.
  raw.datasetDir = `dataset/${key}/images`;
  raw.outputName = loraBase;
  raw.loraName = loraBase;
  raw.datasetFolder = `character_lora_${char?.trigger || key}`;
  raw.copyToModelsLoras = true;
  raw.copyToProject = true;
  await writeFile(dest, JSON.stringify(raw, null, 2), "utf8");
  if (char && !char.loraName) {
    await saveCharacter(key, {
      loraName: `${loraBase}.safetensors`,
    });
  }
  return dest;
}

export async function startTrainLora(id) {
  const key = String(id).toLowerCase();
  const outRel = `dataset/${key}`;
  const images = join(ROOT, outRel, "images");
  if (!existsSync(images)) {
    // Auto-build training plates from keyframe bank (hybrid / Gemini path).
    const prepared = await prepareTrainingImagesFromKeyframes(key);
    if (!prepared.ok) {
      return {
        ok: false,
        error: prepared.error || "Dataset images missing — import poses or generate dataset first",
      };
    }
  }
  let count = (await readdir(images)).filter((f) =>
    /\.(png|jpe?g)$/i.test(f),
  ).length;
  if (count < 4) {
    const prepared = await prepareTrainingImagesFromKeyframes(key);
    if (prepared.ok) {
      count = (await readdir(images)).filter((f) =>
        /\.(png|jpe?g)$/i.test(f),
      ).length;
    }
  }
  if (count < 4) {
    return {
      ok: false,
      error: `Dataset too small (${count} images). Import more poses or run Prepare training set.`,
    };
  }
  try {
    await ensureTrainConfig(key);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  return runNodeJob(id, "Train LoRA", [
    "scripts/train-lora.js",
    "--train-config",
    `train-config-${key}.json`,
    "--character",
    `characters/${key}.json`,
    "--backend",
    "local",
    "--comfy",
    "http://127.0.0.1:8888",
  ]);
}

/**
 * Copy keyframe bank (+ master) into dataset/images for LoRA without Comfy.
 * Use when Gemini/manual poses are the source of truth (skip inventing shots).
 */
export async function prepareTrainingImagesFromKeyframes(id) {
  const key = String(id).toLowerCase();
  const char = await loadCharacter(key);
  if (!char) return { ok: false, error: "Character not found" };
  const outDir = datasetDirFor(key);
  const keyframesDir = join(outDir, "keyframes");
  const imagesDir = join(outDir, "images");
  const masterPath = join(outDir, "master_identity.png");
  if (!existsSync(keyframesDir)) {
    return { ok: false, error: "No keyframes folder — import pose bank first" };
  }
  const files = (await readdir(keyframesDir)).filter((f) =>
    /\.(png|jpe?g|webp)$/i.test(f),
  );
  if (!files.length && !existsSync(masterPath)) {
    return { ok: false, error: "No keyframe images found" };
  }

  await mkdir(imagesDir, { recursive: true });
  const trigger = String(char.trigger || key).replace(/[^\w.-]+/g, "_");
  const guideById = new Map(KEYFRAME_POSE_GUIDE.map((p) => [p.id, p]));
  let copied = 0;

  if (existsSync(masterPath)) {
    const dest = join(imagesDir, `${trigger}_00_master_identity.png`);
    await copyFile(masterPath, dest);
    await writeFile(
      join(imagesDir, `${trigger}_00_master_identity.txt`),
      [
        trigger,
        "master identity",
        "front view",
        "standing",
        char.appearance || "",
        char.outfit || "",
        char.styleTag || "",
      ]
        .filter(Boolean)
        .join(", "),
      "utf8",
    );
    copied++;
  }

  for (const file of files) {
    const idStem = file.replace(/\.(png|jpe?g|webp)$/i, "").toLowerCase();
    const src = join(keyframesDir, file);
    const dest = join(imagesDir, `${trigger}_kf_${idStem}.png`);
    await copyFile(src, dest);
    const guide = guideById.get(idStem);
    const caption = [
      trigger,
      guide?.title || idStem,
      guide?.hint || "",
      char.appearance || "",
      char.outfit || "",
      char.styleTag || "",
    ]
      .filter(Boolean)
      .join(", ")
      .replace(/\s+/g, " ")
      .trim();
    await writeFile(
      join(imagesDir, `${trigger}_kf_${idStem}.txt`),
      caption,
      "utf8",
    );
    copied++;
  }

  characterStudioEvents.emit("log", {
    id: key,
    line: `prepared ${copied} training image(s) from keyframes → dataset/${key}/images`,
  });

  return {
    ok: copied >= 4,
    copied,
    imagesDir: `dataset/${key}/images`,
    error:
      copied < 4
        ? `Only ${copied} plates — need at least 4 (import more poses)`
        : undefined,
  };
}

export function getJob(id) {
  return jobs.get(String(id).toLowerCase()) || null;
}

/** Sensible defaults when creating a new character from the UI. */
export function defaultCharacterDoc({
  id,
  name,
  role = "toddler",
  appearance = "",
  outfit = "",
  negative = "",
  styleTag = "",
  age = "",
  trigger = "",
  gender = "",
  ageBand = "",
  styleFamily = "",
}) {
  const isHelper = /mom|helper|adult|parent/i.test(role);
  return {
    id,
    name: name || id,
    role: isHelper ? "mom" : role || "toddler",
    gender: gender || (isHelper ? "woman" : "boy"),
    ageBand: ageBand || (isHelper ? "adult" : "toddler"),
    styleFamily: styleFamily || "kids3d",
    trigger: trigger || id.replace(/[^a-z0-9]/gi, "").toLowerCase() || id,
    age:
      age ||
      (isHelper
        ? "adult mother, about 30 years old"
        : "toddler boy, about 2 years old"),
    comfyUrl: "http://127.0.0.1:8888",
    checkpoint: "realcartoon3d_v15.safetensors",
    loraName: null,
    loraStrength: isHelper ? 0.28 : 0.9,
    seed: (Date.now() >>> 0) % 1e9,
    width: 512,
    height: 768,
    steps: 28,
    cfg: 7,
    sampler: "dpmpp_2m",
    scheduler: "karras",
    faceIdWeight: 0.85,
    openImages: false,
    styleTag:
      styleTag ||
      (isHelper
        ? "adult woman cartoon proportions, mother character only"
        : "slim toddler boy cartoon proportions, male child only"),
    appearance:
      appearance ||
      (isHelper
        ? "cute cartoon adult mom, feminine soft face, shoulder-length wavy brown hair, warm eyes, kind smile"
        : "cute cartoon 2-year-old toddler boy, oversized round head, big sparkling eyes, small nose, soft round cheeks, gentle smile, fair skin, short stubby limbs, slim toddler proportions, head-to-body ratio about 1:4"),
    outfit:
      outfit ||
      (isHelper
        ? "solid soft coral pink short-sleeve blouse, solid cream long pants, white sneakers"
        : "solid sky blue crew neck t-shirt, navy toddler pants, white sneakers"),
    negative:
      negative ||
      (isHelper
        ? "photo, photorealistic, 3d render, child, toddler, baby, teen, masculine, man, beard, hat, logo, text, watermark, twin, two people, blurry"
        : "photo, photorealistic, 3d render, girl, female, teen, adult, older child, long legs, tall proportions, small head, extra limbs, twin, two people, text, watermark, different clothes"),
    keyframes: [
      {
        id: "front_stand",
        angle: "front view, body facing camera, looking at camera",
        pose: isHelper
          ? "standing straight, arms relaxed at sides"
          : "standing with toddler stance, arms relaxed at sides",
      },
      {
        id: "front_wave",
        angle: "front view, body facing camera, looking at camera",
        pose: "standing, right arm raised waving hello, left arm at side",
      },
      {
        id: "bust_smile",
        angle: "front view bust portrait, looking at camera",
        pose: isHelper
          ? "friendly mom smile, shoulders visible"
          : "happy toddler smile, shoulders visible",
      },
    ],
    shots: defaultShotsForRole(isHelper ? "helper" : role || "toddler"),
  };
}
