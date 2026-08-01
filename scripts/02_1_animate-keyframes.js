/**
 * 02_1 — Animate song keyframes with Wan 2.2 I2V (LightX2V 4-step).
 *
 * Reads stills from a family-pipeline song folder:
 *   batches/<date>/<song_slug>/keyframes/*.png
 * Writes clips next to them:
 *   batches/<date>/<song_slug>/clips/<same-stem>.mp4
 *   batches/<date>/<song_slug>/clips/manifest.json
 *
 * Usage:
 *   node scripts/02_1_animate-keyframes.js --song batches/20260729/spin-and-listen
 *   node scripts/02_1_animate-keyframes.js --batch batches/20260729
 *   node scripts/02_1_animate-keyframes.js --song <path> --force --only 01,02
 *
 * Optional:
 *   --comfy http://127.0.0.1:8888
 *   --width 640 --height 1136 --length 49 --fps 16 --steps 4 --cfg 1 --shift 8
 *   --seed 123
 *   --force          overwrite existing clips
 *   --only 01,03     only keyframe filename prefixes / indices
 *   --kids-hit       opt-in: energetic motion + default length 81 (classic defaults unchanged)
 *   --energetic-motion   same motion prompts without changing length default
 *   --output-resolution preview|youtube  (Wan size; default preview 768×768; youtube 1920×1088)
 *   --frame-chain    kids-hit: seed Wan from previous clip end frame (DEFAULT on)
 *   --no-frame-chain force authored keyframes every clip (disable last-frame chain)
 *
 * Do NOT run while LoRA training is occupying the GPU.
 */
import { mkdir, readFile, writeFile, readdir, stat, copyFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname, basename, resolve, extname, relative } from "path";
import { fileURLToPath } from "url";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  COMFY_ROOT,
  resolveComfyDirs,
  parseArgs,
  sleep,
  stripBom,
  comfy,
  uploadImage,
  queueAndWait,
  extractVideoFromHistory,
  resetComfyExecution,
} from "../lib/comfy-client.js";
import { isSaladUrl } from "../lib/gpu-backend.js";
import {
  KIDS_HIT_WAN_LENGTH,
  resolveOutputResolution,
  DEFAULT_OUTPUT_RESOLUTION,
  kidsHitMotionPrompt,
  pickWanLength,
  shouldChainFromPrevClip,
  castChangedBetweenBeats,
} from "../lib/kids-hit.js";
import { writePreviewMp4 } from "../lib/stitch-preview.js";
import sharp from "sharp";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { flag, has } = parseArgs();
const execFileAsync = promisify(execFile);

function songArgPath(songDir) {
  return relative(ROOT, songDir).replace(/\\/g, "/");
}
const MOTION_NEGATIVE =
  "blurry, low quality, morphing face, extra limbs, distorted hands, text, watermark, photorealistic, sudden cut, flicker, outfit change, clothing morph, different clothes, hat, beanie, cap, bag, purse, handbag, glasses, accessories, white t-shirt on mom, pink pants on mom, coral blouse missing, mint shirt change, navy pants change, three people, second child, extra person, twin, kiss, kissing, hug, hugging, embrace, snuggle, cuddle, wrapping arms, holding child, fused bodies, morphing bodies, extra arms, claw hands";

function wanI2VWorkflow(cfg, imageName, motionPrompt, negative, seed, endImageName = null) {
  const wf = {
    "1": {
      class_type: "CLIPLoader",
      inputs: {
        clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
        type: "wan",
      },
    },
    "2": {
      class_type: "VAELoader",
      inputs: { vae_name: "wan_2.1_vae.safetensors" },
    },
    "3": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
        // Match fp8_scaled weights — "default" can wedge on Salad Blackwell.
        weight_dtype: "fp8_e4m3fn",
      },
    },
    "4": {
      class_type: "UNETLoader",
      inputs: {
        unet_name: "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
        weight_dtype: "fp8_e4m3fn",
      },
    },
    "5": {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["3", 0],
        lora_name: "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
        strength_model: 1.0,
      },
    },
    "6": {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["4", 0],
        lora_name: "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
        strength_model: 1.0,
      },
    },
    "7": {
      class_type: "ModelSamplingSD3",
      inputs: { model: ["5", 0], shift: cfg.shift },
    },
    "8": {
      class_type: "ModelSamplingSD3",
      inputs: { model: ["6", 0], shift: cfg.shift },
    },
    "9": {
      class_type: "CLIPTextEncode",
      inputs: { text: motionPrompt, clip: ["1", 0] },
    },
    "10": {
      class_type: "CLIPTextEncode",
      inputs: { text: negative, clip: ["1", 0] },
    },
    "11": {
      class_type: "LoadImage",
      inputs: { image: imageName },
    },
    "12": {
      class_type: "ImageScale",
      inputs: {
        image: ["11", 0],
        upscale_method: "lanczos",
        width: cfg.width,
        height: cfg.height,
        crop: "center",
      },
    },
    "13": {
      class_type: "WanImageToVideo",
      inputs: {
        positive: ["9", 0],
        negative: ["10", 0],
        vae: ["2", 0],
        start_image: ["12", 0],
        width: cfg.width,
        height: cfg.height,
        length: cfg.length,
        batch_size: 1,
      },
    },
  };

  // FLF2V: guide motion toward the next authored keyframe when chaining
  if (endImageName) {
    wf["11b"] = {
      class_type: "LoadImage",
      inputs: { image: endImageName },
    };
    wf["12b"] = {
      class_type: "ImageScale",
      inputs: {
        image: ["11b", 0],
        upscale_method: "lanczos",
        width: cfg.width,
        height: cfg.height,
        crop: "center",
      },
    };
    wf["13"].inputs.end_image = ["12b", 0];
  }

  Object.assign(wf, {
    "14": {
      class_type: "KSamplerAdvanced",
      inputs: {
        model: ["7", 0],
        add_noise: "enable",
        noise_seed: seed,
        steps: cfg.steps,
        cfg: cfg.cfg,
        sampler_name: "euler",
        scheduler: "simple",
        positive: ["13", 0],
        negative: ["13", 1],
        latent_image: ["13", 2],
        start_at_step: 0,
        end_at_step: Math.floor(cfg.steps / 2),
        return_with_leftover_noise: "enable",
      },
    },
    "15": {
      class_type: "KSamplerAdvanced",
      inputs: {
        model: ["8", 0],
        add_noise: "disable",
        noise_seed: seed,
        steps: cfg.steps,
        cfg: cfg.cfg,
        sampler_name: "euler",
        scheduler: "simple",
        positive: ["13", 0],
        negative: ["13", 1],
        latent_image: ["14", 0],
        start_at_step: Math.floor(cfg.steps / 2),
        end_at_step: 10000,
        return_with_leftover_noise: "disable",
      },
    },
    "16": {
      class_type: "VAEDecode",
      inputs: { samples: ["15", 0], vae: ["2", 0] },
    },
    "17": {
      class_type: "CreateVideo",
      inputs: { images: ["16", 0], fps: cfg.fps },
    },
    "18": {
      class_type: "SaveVideo",
      inputs: {
        video: ["17", 0],
        filename_prefix: `video/${cfg.outName}`,
        format: "mp4",
        codec: "h264",
      },
    },
  });

  return wf;
}

async function findNewestVideo(prefix, comfyUrl) {
  const dirs = await resolveComfyDirs(comfyUrl || "http://127.0.0.1:8888");
  if (dirs.remote || !dirs.output) return null;
  const candidates = [
    join(dirs.output, "video"),
    join(COMFY_ROOT, "output", "video"),
    dirs.output,
    join(COMFY_ROOT, "output"),
  ];
  const pred = (f) =>
    f.toLowerCase().endsWith(".mp4") && (!prefix || f.includes(prefix));
  for (const dir of candidates) {
    if (!dir || !existsSync(dir)) continue;
    const files = (await readdir(dir))
      .filter(pred)
      .map((f) => join(dir, f));
    if (!files.length) continue;
    const withStat = await Promise.all(
      files.map(async (f) => ({ f, m: (await stat(f)).mtimeMs })),
    );
    withStat.sort((a, b) => b.m - a.m);
    return withStat[0].f;
  }
  return null;
}

function resolveSongDir(raw) {
  if (!raw) return null;
  const abs = raw.match(/^[A-Za-z]:[\\/]/) || raw.startsWith("/") ? raw : join(ROOT, raw);
  return abs;
}

async function listSongDirs(batchOrSong) {
  const abs = resolveSongDir(batchOrSong);
  if (!abs || !existsSync(abs)) throw new Error(`Path not found: ${batchOrSong}`);
  const kf = join(abs, "keyframes");
  if (existsSync(kf)) return [abs];
  const kids = await readdir(abs);
  const songs = [];
  for (const name of kids) {
    const songDir = join(abs, name);
    if (existsSync(join(songDir, "keyframes"))) songs.push(songDir);
  }
  if (!songs.length) {
    throw new Error(`No song folders with keyframes/ under ${abs}`);
  }
  return songs.sort();
}

async function loadActions(songDir) {
  const p = join(songDir, "scenes", "actions.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(stripBom(await readFile(p, "utf8")));
  } catch {
    return null;
  }
}

/** keyframe name: 01_01_intro.png (composite) or legacy 01_01_intro_adam.png */
function parseKeyframeName(stem) {
  // Legacy: N_beatId_charId
  const legacy = /^(\d+)_(.+)_([a-z0-9]+)$/i.exec(stem);
  if (legacy) {
    const charId = legacy[3].toLowerCase();
    // beat ids never end with known cast names alone when composited as N_beatId
    if (/^(tom|adam|sasha)$/i.test(charId)) {
      return { index: legacy[1], beatId: legacy[2], charId };
    }
  }
  // Composite: N_beatId
  const m = /^(\d+)_(.+)$/i.exec(stem);
  if (!m) return { index: stem, beatId: null, charId: null };
  return { index: m[1], beatId: m[2], charId: null };
}

function motionPromptFor(
  stem,
  actions,
  { kidsHit = false, frameChained = false, castChanged = false } = {},
) {
  const { beatId, charId } = parseKeyframeName(stem);
  const POSE_MOTION = {
    stand: "standing still, tiny breath sway, arms at sides",
    kneel: "kneeling, slight torso sway",
    wave: "waving one hand gently",
    clap: "clapping hands slowly once or twice",
    walk: "walking in place, short steps",
    tiptoe: "tiptoeing softly in place, heels raised",
    sit: "sitting, soft posture shift",
    hands_up: "arms raised, gentle bounce",
    point: "pointing arm held steady with tiny motion",
    stomp: "light foot taps, small bounce",
  };

  let poseIds = [];
  let location = "";
  let camera = "";
  if (actions?.beats && beatId) {
    const beat = actions.beats.find((b) => b.id === beatId);
    if (beat) {
      location = beat.location || "";
      camera = beat.camera || "";
      const chars = Array.isArray(beat.characters) ? beat.characters : [];
      const selected = charId
        ? chars.filter(
            (c) =>
              typeof c === "object" &&
              String(c.name || "").toLowerCase() === charId,
          )
        : chars.filter((c) => typeof c === "object" && c.name);

      if (selected.length) {
        for (const entry of selected) {
          const poseId = String(entry.pose || "stand")
            .toLowerCase()
            .replace(/[\s-]+/g, "_");
          poseIds.push(poseId);
        }
      } else {
        const frames = Array.isArray(beat.keyframes) ? beat.keyframes : [];
        const frame = frames.find(
          (f) => String(f.character || "").toLowerCase() === charId,
        );
        if (frame) {
          poseIds.push(
            String(frame.pose || "stand")
              .toLowerCase()
              .replace(/[\s-]+/g, "_"),
          );
        }
      }
    }
  }

  if (kidsHit) {
    const mood = actions?.mood || "energetic";
    const beat = actions?.beats?.find((b) => b.id === beatId);
    const beatIndex = actions?.beats?.findIndex((b) => b.id === beatId) ?? -1;
    const prevBeat =
      beatIndex > 0 ? actions.beats[beatIndex - 1] : null;
    return kidsHitMotionPrompt({
      poseIds: poseIds.length ? poseIds : ["stand"],
      location,
      camera,
      mood,
      lyricHint: beat?.lyricHint || "",
      storyBeat: beat?.storyBeat || "",
      actionPhase: beat?.actionPhase || "",
      beatRole: beat?.beatRole || "",
      cameraMotion: beat?.cameraMotion || "",
      interaction: beat?.interaction || "",
      emotionIntensity: beat?.emotionIntensity || 0,
      cutMotivation: beat?.cutMotivation || "",
      bridge: !!beat?.bridge,
      enterDir: beat?.enterDir || "",
      exitDir: beat?.exitDir || "",
      placement: beat?.placement || null,
      endPlacement: beat?.endPlacement || null,
      prevBeat,
      hasHelper: !!(
        beat?.placement?.Sasha ||
        beat?.characters?.some((c) => /^sasha$/i.test(c?.name))
      ),
      proximity: beat?.proximity || "",
      closeInteraction: !!beat?.closeInteraction,
      cause: beat?.cause || "",
      effect: beat?.effect || "",
      frameChained: !!frameChained,
      castChanged: !!castChanged,
    });
  }

  let parts = poseIds.map((poseId) => POSE_MOTION[poseId] || POSE_MOTION.stand);
  if (!parts.length) parts = ["gentle natural motion"];

  return [
    "cartoon family music video still",
    parts.join("; "),
    location ? `in ${location}` : null,
    camera ? camera.replace(/_/g, " ") : null,
    "gentle natural motion, keep pose geometry, soft camera push-in",
    "flat 2D anime cartoon style, keep identity and outfit fixed",
    "no sudden pose changes, no morphing, no extra limbs",
  ]
    .filter(Boolean)
    .join(", ");
}

function passesOnlyFilter(stem, onlySet) {
  if (!onlySet) return true;
  for (const token of onlySet) {
    if (
      stem === token ||
      stem.startsWith(`${token}_`) ||
      stem.endsWith(`_${token}`) ||
      stem.includes(`_${token}_`) ||
      // allow bare beat id like 01_intro against stem 03_01_intro
      stem.split("_").slice(1).join("_") === token
    ) {
      return true;
    }
  }
  return false;
}

function beatForStem(stem, actions) {
  if (!actions?.beats?.length) return null;
  const { beatId } = parseKeyframeName(stem);
  if (!beatId) return null;
  return actions.beats.find((b) => b.id === beatId) || null;
}

async function ffprobeDuration(file) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { windowsHide: true, maxBuffer: 2 * 1024 * 1024 },
  );
  const d = Number(String(stdout).trim());
  return Number.isFinite(d) ? d : 0;
}

/** Grab a clean frame near the end (accurate seek after demux). */
async function extractNearEndFrame(mp4Path, outPng, { padSec = 0.08 } = {}) {
  const dur = await ffprobeDuration(mp4Path);
  if (!(dur > 0.05)) {
    throw new Error(`bad duration for ${mp4Path}`);
  }
  const t = Math.max(0, dur - Math.max(0.08, padSec));
  await mkdir(dirname(outPng), { recursive: true });
  // -ss after -i is slower but frame-accurate; avoid black/wrong frames
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      mp4Path,
      "-ss",
      t.toFixed(3),
      "-frames:v",
      "1",
      "-update",
      "1",
      outPng,
    ],
    { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
  );
  if (!existsSync(outPng)) {
    throw new Error(`end-frame not written: ${outPng}`);
  }
  return outPng;
}

function continuityEndPath(clipsDir, stem) {
  return join(clipsDir, "_continuity", `${stem}_end.png`);
}

/**
 * When remaking with --only under frame-chain, also remake subsequent
 * same-room progressive clips that would seed from the remade ones.
 */
function expandOnlyForFrameChain(stems, onlySet, actions) {
  if (!onlySet || !actions?.beats?.length) return onlySet;
  const expanded = new Set(onlySet);
  let grew = true;
  while (grew) {
    grew = false;
    for (let i = 0; i < stems.length - 1; i++) {
      if (!passesOnlyFilter(stems[i], expanded)) continue;
      const prevBeat = beatForStem(stems[i], actions);
      const nextBeat = beatForStem(stems[i + 1], actions);
      if (!shouldChainFromPrevClip(prevBeat, nextBeat)) continue;
      if (!passesOnlyFilter(stems[i + 1], expanded)) {
        expanded.add(stems[i + 1]);
        grew = true;
      }
    }
  }
  return expanded;
}

async function ensureEndFrame(clipsDir, stem, mp4Path) {
  const endPath = continuityEndPath(clipsDir, stem);
  if (existsSync(endPath) && existsSync(mp4Path)) {
    try {
      const endStat = await stat(endPath);
      const clipStat = await stat(mp4Path);
      if (endStat.mtimeMs >= clipStat.mtimeMs) return endPath;
    } catch {
      /* regenerate */
    }
  }
  if (!existsSync(mp4Path)) return null;
  await extractNearEndFrame(mp4Path, endPath);
  return endPath;
}

/**
 * Blend previous clip end-frame with the next authored keyframe.
 * Keeps pixel continuity while allowing pose/cast hints from the still.
 */
async function blendChainStart(endPath, keyframePath, outPath, endWeight = 0.72) {
  const endMeta = await sharp(endPath).metadata();
  const w = endMeta.width;
  const h = endMeta.height;
  if (!w || !h) throw new Error(`bad end-frame size: ${endPath}`);
  const endRaw = await sharp(endPath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const kfRaw = await sharp(keyframePath)
    .resize(w, h, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const a = Math.max(0, Math.min(1, Number(endWeight) || 0.72));
  const b = 1 - a;
  const out = Buffer.alloc(endRaw.data.length);
  for (let i = 0; i < endRaw.data.length; i += 4) {
    out[i] = Math.round(endRaw.data[i] * a + kfRaw.data[i] * b);
    out[i + 1] = Math.round(endRaw.data[i + 1] * a + kfRaw.data[i + 1] * b);
    out[i + 2] = Math.round(endRaw.data[i + 2] * a + kfRaw.data[i + 2] * b);
    out[i + 3] = 255;
  }
  await mkdir(dirname(outPath), { recursive: true });
  await sharp(out, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(outPath);
  return outPath;
}

/** Drop the first N frames (Wan morph) in-place. */
async function trimLeadingFrames(mp4Path, frames = 3, fps = 16) {
  const dur = await ffprobeDuration(mp4Path);
  const skip = Math.max(0, (Number(frames) || 0) / Math.max(1, Number(fps) || 16));
  if (!(dur > skip + 0.2)) return false;
  const tmp = `${mp4Path}.trim.mp4`;
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-ss",
      skip.toFixed(3),
      "-i",
      mp4Path,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      tmp,
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );
  await copyFile(tmp, mp4Path);
  try {
    await unlink(tmp);
  } catch {
    /* ignore */
  }
  return true;
}

async function animateSong(
  songDir,
  cfg,
  comfyUrl,
  { kidsHit = false, frameChain = false } = {},
) {
  const keyframesDir = join(songDir, "keyframes");
  const clipsDir = join(songDir, "clips");
  const continuityDir = join(clipsDir, "_continuity");
  await mkdir(clipsDir, { recursive: true });
  if (frameChain) await mkdir(continuityDir, { recursive: true });

  const actions = await loadActions(songDir);
  const files = (await readdir(keyframesDir))
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .filter((f) => !/_prepolish\./i.test(f))
    .filter((f) => !/^plates$/i.test(f))
    .sort();

  const stems = files.map((f) => basename(f, extname(f)));

  const onlyRaw = flag("--only", null);
  let onlySet = onlyRaw
    ? new Set(onlyRaw.split(",").map((s) => s.trim()).filter(Boolean))
    : null;

  if (frameChain && onlySet) {
    const before = onlySet.size;
    onlySet = expandOnlyForFrameChain(stems, onlySet, actions);
    if (onlySet.size > before) {
      console.log(
        `  frame-chain: --only expanded ${before} → ${onlySet.size} stem(s) (same-room chain)`,
      );
    }
  }

  const manifest = {
    songDir,
    createdAt: new Date().toISOString(),
    kidsHit: !!kidsHit,
    frameChain: !!frameChain,
    wan: {
      width: cfg.width,
      height: cfg.height,
      length: cfg.length,
      fps: cfg.fps,
      steps: cfg.steps,
    },
    clips: [],
  };

  console.log(`\nSong: ${songDir}`);
  console.log(
    `Keyframes: ${files.length}` +
      (kidsHit ? " (kids-hit motion)" : "") +
      (frameChain ? " [last-frame chain]" : ""),
  );

  if (!files.length) {
    throw new Error(
      `No keyframe images in ${keyframesDir}\n` +
        `Re-run 02_0 for this song, then retry 02_1.`,
    );
  }

  let n = 0;
  for (let fileIdx = 0; fileIdx < files.length; fileIdx++) {
    const file = files[fileIdx];
    const stem = stems[fileIdx];
    if (!passesOnlyFilter(stem, onlySet)) continue;
    n += 1;
    const src = join(keyframesDir, file);
    const dest = join(clipsDir, `${stem}.mp4`);
    const beat = beatForStem(stem, actions);
    const prevStem = fileIdx > 0 ? stems[fileIdx - 1] : null;
    const prevBeat = prevStem ? beatForStem(prevStem, actions) : null;
    const chainFromPrev =
      frameChain &&
      prevStem &&
      shouldChainFromPrevClip(prevBeat, beat);
    const castChanged =
      !!prevBeat && !!beat && castChangedBetweenBeats(prevBeat, beat);

    let clipCfg = cfg;
    if (kidsHit && !cfg.lengthLocked && actions?.beats) {
      if (
        beat &&
        Number.isFinite(Number(beat.startSec)) &&
        Number.isFinite(Number(beat.endSec))
      ) {
        const windowSec = Number(beat.endSec) - Number(beat.startSec);
        const len = pickWanLength(windowSec, cfg.fps, cfg.length);
        clipCfg = { ...cfg, length: len };
      }
    }

    if (existsSync(dest) && !has("--force")) {
      const motion = motionPromptFor(stem, actions, { kidsHit });
      console.log(`  (${n}) ${stem} reuse`);
      let endFrame = null;
      if (frameChain) {
        try {
          endFrame = await ensureEndFrame(clipsDir, stem, dest);
        } catch (err) {
          console.warn(
            `      end-frame extract skipped: ${err?.message || err}`,
          );
        }
      }
      manifest.clips.push({
        stem,
        file: dest,
        reused: true,
        motion,
        chainedFrom: null,
        endFrame,
      });
      continue;
    }

    // Resolve Wan start image: prev end frame (hybrid) or authored keyframe
    let startPath = src;
    let chainedFrom = null;
    let blendNote = "";
    if (chainFromPrev) {
      const prevMp4 = join(clipsDir, `${prevStem}.mp4`);
      try {
        const prevEnd = await ensureEndFrame(clipsDir, prevStem, prevMp4);
        if (prevEnd && existsSync(prevEnd)) {
          // Same cast: mostly end-frame. Cast change / big pose hint: blend keyframe in.
          const endWeight = castChanged ? 0.55 : 0.82;
          if (endWeight < 0.99) {
            const blendPath = join(
              continuityDir,
              `${stem}_chain_start.png`,
            );
            startPath = await blendChainStart(
              prevEnd,
              src,
              blendPath,
              endWeight,
            );
            blendNote = castChanged
              ? ` blend←kf ${(100 - endWeight * 100).toFixed(0)}% (cast change)`
              : ` blend←kf ${(100 - endWeight * 100).toFixed(0)}%`;
          } else {
            startPath = prevEnd;
          }
          chainedFrom = prevStem;
        } else {
          console.warn(
            `      frame-chain: no end frame for ${prevStem} — using keyframe`,
          );
        }
      } catch (err) {
        console.warn(
          `      frame-chain: ${err?.message || err} — using keyframe`,
        );
      }
    }

    const motion = motionPromptFor(stem, actions, {
      kidsHit,
      frameChained: !!chainedFrom,
      castChanged: !!chainedFrom && castChanged,
    });

    const outName = `kf_${stem}_${Date.now().toString(36)}`.replace(/[^\w.-]+/g, "_");
    console.log(
      `  (${n}) ${stem} → Wan I2V length=${clipCfg.length}` +
        (chainedFrom ? ` [chain←${chainedFrom}${blendNote}]` : ""),
    );
    console.log(`      motion: ${motion.slice(0, 140)}…`);

    const buf = await readFile(startPath);
    const uploadName = chainedFrom
      ? `family_chain_${stem}.png`
      : `family_kf_${stem}.png`;
    const uploaded = await uploadImage(comfyUrl, uploadName, buf);
    let endUploadedName = null;
    // FLF2V: camera-end crop (or keyframe) so Wan pushes/pans toward end framing
    if (kidsHit && !has("--no-flf")) {
      try {
        const parsed = parseKeyframeName(stem);
        const camCandidates = [];
        if (parsed.beatId) {
          camCandidates.push(
            join(
              keyframesDir,
              "_camera",
              `${parsed.index}_${parsed.beatId}_end.png`,
            ),
          );
        }
        camCandidates.push(join(keyframesDir, "_camera", `${stem}_end.png`));
        let endSrc = null;
        for (const p of camCandidates) {
          if (existsSync(p)) {
            endSrc = p;
            break;
          }
        }
        // Fallback: only when chaining, use authored keyframe as soft end guide
        if (!endSrc && chainedFrom && existsSync(src)) endSrc = src;
        if (endSrc) {
          const endUp = await uploadImage(
            comfyUrl,
            `family_flf_${stem}.png`,
            await readFile(endSrc),
          );
          endUploadedName = endUp.name;
          console.log(
            `      FLF end ← ${endSrc.includes("_camera") ? "camera-end" : "keyframe"}`,
          );
        }
      } catch (err) {
        console.warn(`      FLF end-image upload skipped: ${err?.message || err}`);
      }
    }
    const seed = flag("--seed")
      ? Number(flag("--seed")) + n
      : (Date.now() + n * 17) >>> 0;

    const entry = await queueAndWait(
      comfyUrl,
      wanI2VWorkflow(
        { ...clipCfg, outName },
        uploaded.name,
        motion,
        MOTION_NEGATIVE,
        seed,
        endUploadedName,
      ),
      900000,
      stem,
    );

    await sleep(800);
    // Prefer exact outputs from this prompt_id — local copy or Salad /view download
    let comfySource = null;
    try {
      const extracted = await extractVideoFromHistory(comfyUrl, entry);
      if (extracted?.buffer?.length) {
        await writeFile(dest, extracted.buffer);
        comfySource = extracted.meta?.localPath || extracted.meta?.filename || "history:/view";
        console.log(
          `      downloaded ${extracted.buffer.length} bytes` +
            (extracted.meta?.filename ? ` (${extracted.meta.filename})` : ""),
        );
      } else {
        const outKeys = Object.keys(entry?.outputs || {});
        console.warn(
          `      no video in history outputs [${outKeys.join(",")}]` +
            (outKeys[0]
              ? ` keys=${Object.keys(entry.outputs[outKeys[0]] || {}).join(",")}`
              : ""),
        );
      }
    } catch (err) {
      console.warn(`      history video extract failed: ${err?.message || err}`);
    }
    if (!comfySource) {
      const videoPath = await findNewestVideo(outName, comfyUrl);
      if (videoPath) {
        await copyFile(videoPath, dest);
        comfySource = videoPath;
      }
    }
    if (!comfySource || !existsSync(dest)) {
      throw new Error(`No Wan output found for ${stem} (prefix ${outName})`);
    }
    // Drop first ~3 frames of chained clips (Wan morph into motion)
    if (chainedFrom && !has("--no-overlap-trim")) {
      try {
        const trimmed = await trimLeadingFrames(dest, 3, clipCfg.fps || 16);
        if (trimmed) console.log(`      overlap-trim first 3 frames`);
      } catch (err) {
        console.warn(`      overlap-trim skipped: ${err?.message || err}`);
      }
    }
    console.log(`      → ${dest}`);

    let endFrame = null;
    if (frameChain) {
      try {
        endFrame = await extractNearEndFrame(
          dest,
          continuityEndPath(clipsDir, stem),
        );
        console.log(`      end-frame → ${endFrame}`);
      } catch (err) {
        console.warn(`      end-frame extract failed: ${err?.message || err}`);
      }
    }

    // If this remake breaks a later chain link outside expanded only-set, warn
    if (frameChain && onlyRaw && fileIdx < stems.length - 1) {
      const nextStem = stems[fileIdx + 1];
      const nextBeat = beatForStem(nextStem, actions);
      if (
        shouldChainFromPrevClip(beat, nextBeat) &&
        !passesOnlyFilter(nextStem, onlySet)
      ) {
        console.warn(
          `      warning: ${nextStem} would chain from ${stem} but is outside --only — remake it or drop --only`,
        );
        const nextMp4 = join(clipsDir, `${nextStem}.mp4`);
        const nextEnd = continuityEndPath(clipsDir, nextStem);
        for (const dirty of [nextMp4, nextEnd]) {
          if (existsSync(dirty)) {
            try {
              await unlink(dirty);
              console.warn(`      marked dirty: ${dirty}`);
            } catch {
              /* ignore */
            }
          }
        }
      }
    }

    manifest.clips.push({
      stem,
      file: dest,
      reused: false,
      motion,
      seed,
      length: clipCfg.length,
      comfySource,
      chainedFrom,
      startImage: chainedFrom ? startPath : src,
      endFrame,
    });

    // Progressive preview: concat finished clips + song audio so far
    try {
      const preview = await writePreviewMp4(songDir);
      if (preview) {
        console.log(
          `PREVIEW_READY path=${preview.path} clips=${preview.clips} duration=${preview.durationSec.toFixed(1)}s`,
        );
      }
    } catch (err) {
      console.warn(`      preview stitch skipped: ${err?.message || err}`);
    }
  }

  const manPath = join(clipsDir, "manifest.json");
  await writeFile(manPath, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`  clips manifest: ${manPath}`);
  return manifest;
}

async function main() {
  const songArg = flag("--song", null);
  const batchArg = flag("--batch", null);
  if (!songArg && !batchArg) {
    throw new Error(
      "Pass --song batches/<date>/<slug> or --batch batches/<date>",
    );
  }

  const kidsHit = has("--kids-hit") || has("--energetic-motion");
  // Kids-hit defaults to last-frame chain; --no-frame-chain forces keyframe seeds.
  const frameChain = !!kidsHit && !has("--no-frame-chain");
  const lengthExplicit = has("--length");
  let length = 49;
  if (has("--kids-hit") && !lengthExplicit) {
    length = KIDS_HIT_WAN_LENGTH;
  } else if (lengthExplicit) {
    length = Number(flag("--length", "49"));
  }
  if ((length - 1) % 4 !== 0) {
    length = Math.max(1, Math.round((length - 1) / 4) * 4 + 1);
  }

  const widthExplicit = has("--width");
  const heightExplicit = has("--height");
  const resPreset = resolveOutputResolution(
    flag("--output-resolution", DEFAULT_OUTPUT_RESOLUTION),
  );
  // Match still size from 02_0 when kids-hit or --output-resolution is set.
  const usePresetSize = has("--kids-hit") || has("--output-resolution");
  const cfg = {
    width: Number(
      flag(
        "--width",
        usePresetSize && !widthExplicit ? String(resPreset.wanWidth) : "640",
      ),
    ),
    height: Number(
      flag(
        "--height",
        usePresetSize && !heightExplicit ? String(resPreset.wanHeight) : "1136",
      ),
    ),
    length,
    lengthLocked: lengthExplicit,
    steps: Number(flag("--steps", "4")),
    cfg: Number(flag("--cfg", "1")),
    shift: Number(flag("--shift", "8")),
    fps: Number(flag("--fps", "16")),
  };

  const { resolveComfyUrl } = await import("../lib/gpu-backend.js");
  const comfyUrl =
    flag("--comfy", null) || resolveComfyUrl() || "http://127.0.0.1:8888";
  console.log("02_1 Animate keyframes — Wan 2.2 I2V");
  console.log(
    `  ${cfg.width}x${cfg.height} length=${cfg.length} fps=${cfg.fps} steps=${cfg.steps}` +
      (kidsHit ? " [kids-hit/energetic]" : "") +
      (frameChain ? " [frame-chain]" : has("--no-frame-chain") ? " [no-frame-chain]" : ""),
  );
  console.log(`  Comfy: ${comfyUrl}`);

  await comfy(comfyUrl, "/system_stats");
  if (isSaladUrl(comfyUrl)) {
    // Drop orphaned/wedged Wan jobs from prior mvid kills or LoRA interrupts.
    console.log("  Salad: clearing any stuck queue before Wan…");
    await resetComfyExecution(comfyUrl, { label: "pre-Wan" });
  }

  const targets = await listSongDirs(songArg || batchArg);
  for (const songDir of targets) {
    await animateSong(songDir, cfg, comfyUrl, { kidsHit, frameChain });
  }

  console.log("\n────────────────────────────────────────────────────────");
  console.log(" Next — stitch clips + song → final.mp4:");
  const stitchFlag = has("--kids-hit") ? " --loop-fill" : "";
  for (const songDir of targets) {
    console.log(
      `  node scripts/02_2_stitch-song.js --song ${songArgPath(songDir)}${stitchFlag}`,
    );
  }
  if (targets.length > 1 && batchArg) {
    const batchRel = relative(ROOT, resolveSongDir(batchArg)).replace(/\\/g, "/");
    console.log(" Or stitch the whole batch:");
    console.log(`  node scripts/02_2_stitch-song.js --batch ${batchRel}${stitchFlag}`);
  }
  console.log("────────────────────────────────────────────────────────");
}

main().catch((err) => {
  console.error("\nFailed:", err.message || err);
  process.exit(1);
});
