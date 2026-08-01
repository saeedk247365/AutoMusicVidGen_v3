/**
 * Generate one empty room still from scenes/scenes.json into scenes/<id>.png
 *
 *   node scripts/generate-scene-still.js --id kitchen --force
 *   node scripts/generate-scene-still.js --id kitchen --comfy http://127.0.0.1:8888
 */
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  parseArgs,
  stripBom,
  comfy,
  queueAndWait,
  extractImageFromHistory,
  checkpointStillWorkflow,
} from "../lib/comfy-client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCENES_DIR = join(ROOT, "scenes");
const SCENES_JSON = join(SCENES_DIR, "scenes.json");

const args = parseArgs(process.argv.slice(2));
function flag(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
function has(name) {
  return args.has(name);
}

const SCENE_ID = String(flag("--id", "") || "").toLowerCase().trim();
const FORCE = has("--force");
const COMFY_URL = flag("--comfy", process.env.COMFY_URL || "http://127.0.0.1:8888");
const WIDTH = Number(flag("--width", "768"));
const HEIGHT = Number(flag("--height", "768"));
const SEED = Number(flag("--seed", String(55000 + Math.floor(Math.random() * 1000))));

const STILL_NEGATIVE =
  "people, person, character, human, silhouette, face, hands, animal, text, watermark, logo, photorealistic, 3d render, blurry, low quality, cluttered floor play lane, empty barren room";

function buildScenePrompt(scenePack, scene) {
  return [
    scenePack.style,
    scene.still,
    "furnished cozy preschool room",
    "readable furniture in midground",
    "clear open floor play lane in the foreground",
    "no people",
    "no characters",
    "no silhouettes",
    "no shadows of people",
    "no reflections of people",
    "no faces",
    "no animals",
  ].join(", ");
}

async function main() {
  if (!SCENE_ID) {
    throw new Error("Usage: node scripts/generate-scene-still.js --id <scene_id> [--force]");
  }
  if (!existsSync(SCENES_JSON)) {
    throw new Error(`Missing ${SCENES_JSON}`);
  }
  const pack = JSON.parse(stripBom(await readFile(SCENES_JSON, "utf8")));
  const scene = (pack.scenes || []).find((s) => s.id === SCENE_ID);
  if (!scene) {
    throw new Error(`Scene id not in scenes.json: ${SCENE_ID}`);
  }

  const dest = join(SCENES_DIR, `${SCENE_ID}.png`);
  if (existsSync(dest) && !FORCE) {
    console.log(`skip exists: ${dest} (pass --force to regenerate)`);
    return;
  }
  if (FORCE && existsSync(dest)) {
    try {
      await unlink(dest);
    } catch {
      /* ignore */
    }
  }

  await comfy(COMFY_URL, "/system_stats");
  const cfg = {
    checkpoint: "realcartoon3d_v15.safetensors",
    width: WIDTH,
    height: HEIGHT,
    steps: 28,
    cfg: 7,
  };
  const prompt = buildScenePrompt(pack, scene);
  const negative = `${pack.negative || ""}, ${STILL_NEGATIVE}`;
  const prefix = `family_scene_${SCENE_ID}`;
  console.log(`[scene] ${SCENE_ID} → ${dest}`);
  console.log(`  comfy=${COMFY_URL} seed=${SEED}`);

  const wf = checkpointStillWorkflow(cfg, prompt, negative, SEED >>> 0, prefix);
  const entry = await queueAndWait(COMFY_URL, wf, 900000, prefix);
  const buf = await extractImageFromHistory(COMFY_URL, entry);
  await mkdir(SCENES_DIR, { recursive: true });
  await writeFile(dest, Buffer.from(buf));
  console.log(`  saved: ${dest}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
