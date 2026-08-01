/**
 * Room studio: create / list / generate empty scene plates for the cast pipeline.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import { stripBom } from "./comfy-client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCENES_DIR = join(ROOT, "scenes");
const SCENES_JSON = join(SCENES_DIR, "scenes.json");

/** @type {Map<string, object>} */
const roomJobs = new Map();
export const roomStudioEvents = new EventEmitter();

export const ROOM_PRESETS = [
  {
    id: "living_room",
    label: "Living room",
    name: "Living Room",
    still:
      "bright cozy cartoon living room viewed from doorway, soft pastel walls, comfortable sofa with cushions in the midground left, low coffee table in midground center-back, tall plant beside sofa, bookshelf on the right, large window with sheer curtains, framed picture on back wall, bottom 28 percent clear open wooden-floor PLAY LANE, tidy preschool living room, no people",
  },
  {
    id: "kitchen",
    label: "Kitchen",
    name: "Kitchen",
    still:
      "bright family cartoon kitchen viewed from doorway, blue tiled floor, sink with faucet and soap on the left midground counter, cabinets, refrigerator, stove, window above sink, round dining table with two chairs in midground right, bottom 28 percent clear tile PLAY LANE, tidy preschool kitchen, no people",
  },
  {
    id: "bedroom",
    label: "Bedroom",
    name: "Bedroom",
    still:
      "cozy toddler bedroom viewed from doorway, soft pastel walls, toddler bed with blanket and pillows in midground right, bedside table with lamp, toy shelf on the side wall, sunny window with curtains, bottom 28 percent clear wooden-floor PLAY LANE, colorful kids room, no people",
  },
  {
    id: "bathroom",
    label: "Bathroom",
    name: "Bathroom",
    still:
      "soft cartoon bathroom, bathtub with shower curtain against the midground back wall, towel rack, sink and mirror on the side, window light, bottom 28 percent clear light tile PLAY LANE, tidy preschool bath set, no people",
  },
  {
    id: "playroom",
    label: "Playroom",
    name: "Playroom",
    still:
      "bright cartoon playroom viewed from doorway, colorful toy shelf along the back midground wall, soft cushions and a beanbag on the left, window with curtains, small easel in the far corner, bottom 28 percent clear PLAY LANE, tidy preschool play space, no people, no faces on toys",
  },
  {
    id: "dining_room",
    label: "Dining room",
    name: "Dining Room",
    still:
      "bright cartoon dining room viewed from doorway, rectangular wooden table with four chairs in midground, place mats, window with curtains, framed picture, plant in the corner, bottom 28 percent clear wooden-floor PLAY LANE aisle toward the table, tidy preschool dining room, no people",
  },
  {
    id: "hallway",
    label: "Hallway",
    name: "Hallway",
    still:
      "short cartoon home hallway corridor, wooden floor, door frames on left and right, small console table with a plant, soft daylight from the far end, bottom 30 percent clear walking PLAY LANE, tidy preschool set, no people",
  },
  {
    id: "backyard",
    label: "Backyard",
    name: "Backyard",
    still:
      "sunny cartoon backyard, small sandbox and child slide in midground, fence with flowers, trees at the edges, blue sky soft clouds, bottom 30 percent clear grass PLAY LANE, friendly backyard set, no people, no animals",
  },
  {
    id: "classroom",
    label: "Classroom",
    name: "Classroom",
    still:
      "bright preschool cartoon classroom viewed from doorway, low tables and tiny chairs in midground, colorful alphabet wall chart, cubbies along one wall, window with daylight, bottom 28 percent clear floor PLAY LANE, tidy kids classroom, no people",
  },
  {
    id: "garage",
    label: "Garage",
    name: "Garage",
    still:
      "tidy cartoon home garage interior viewed from doorway, workbench and tools on the side wall, parked toy wagon, shelves with boxes, open garage door showing daylight, bottom 28 percent clear concrete PLAY LANE, friendly preschool set, no people, no cars with drivers",
  },
];

function slugId(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export async function loadScenePack() {
  if (!existsSync(SCENES_JSON)) {
    return {
      style:
        "flat 2D anime cartoon illustration, clean cel shading, soft pastel colors, cozy furnished preschool interiors, no people",
      negative:
        "photo, photorealistic, people, person, character, face, animal, text, watermark, cluttered floor",
      scenes: [],
    };
  }
  return JSON.parse(stripBom(await readFile(SCENES_JSON, "utf8")));
}

export async function saveScenePack(pack) {
  await mkdir(SCENES_DIR, { recursive: true });
  await writeFile(SCENES_JSON, JSON.stringify(pack, null, 2), "utf8");
  return pack;
}

export async function listRooms() {
  const pack = await loadScenePack();
  const stamp = Date.now();
  return {
    ok: true,
    style: pack.style,
    negative: pack.negative,
    scenes: (pack.scenes || []).map((s) => ({
      id: s.id,
      name: s.name || s.id,
      still: s.still || "",
      hasImage: existsSync(join(SCENES_DIR, `${s.id}.png`)),
      thumbUrl: existsSync(join(SCENES_DIR, `${s.id}.png`))
        ? `/media/scenes/${s.id}.png?t=${stamp}`
        : null,
    })),
  };
}

export async function createRoom({
  id,
  name,
  still,
  overwrite = false,
  generate = false,
} = {}) {
  const roomId = slugId(id || name);
  if (!roomId) return { ok: false, error: "Room id / name required" };
  if (!still || !String(still).trim()) {
    return { ok: false, error: "Still prompt required" };
  }
  const pack = await loadScenePack();
  const scenes = pack.scenes || [];
  const idx = scenes.findIndex((s) => s.id === roomId);
  if (idx >= 0 && !overwrite) {
    return { ok: false, error: `Room ${roomId} already exists` };
  }
  const entry = {
    id: roomId,
    name: name || roomId,
    still: String(still).trim(),
  };
  if (idx >= 0) scenes[idx] = entry;
  else scenes.push(entry);
  pack.scenes = scenes;
  await saveScenePack(pack);

  let job = null;
  if (generate) {
    const started = startRoomGeneration(roomId, { force: true });
    if (!started.ok) return started;
    job = started.job;
  }
  return { ok: true, room: entry, job };
}

function emitRoomJob(id, job) {
  roomJobs.set(id, job);
  roomStudioEvents.emit("job", { id, ...job });
}

export function getRoomJob(id) {
  return roomJobs.get(String(id).toLowerCase()) || null;
}

export function startRoomGeneration(id, { force = false } = {}) {
  const key = String(id).toLowerCase();
  const existing = roomJobs.get(key);
  if (existing?.running) {
    return { ok: false, error: `Room job already running: ${existing.label}` };
  }
  const png = join(SCENES_DIR, `${key}.png`);
  // Allow generate even if JSON entry exists without image
  const packExists = existsSync(SCENES_JSON);
  if (!packExists) {
    return { ok: false, error: "scenes/scenes.json missing" };
  }

  const job = {
    running: true,
    label: `Generate room ${key}`,
    startedAt: Date.now(),
    log: [],
    exitCode: null,
    error: null,
  };
  emitRoomJob(key, job);

  const args = [
    "scripts/generate-scene-still.js",
    "--id",
    key,
    "--comfy",
    "http://127.0.0.1:8888",
  ];
  if (force || existsSync(png)) args.push("--force");

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    windowsHide: true,
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
    emitRoomJob(key, { ...job });
  };

  child.stdout?.on("data", (d) => push(d, "out"));
  child.stderr?.on("data", (d) => push(d, "err"));
  child.on("error", (err) => {
    job.running = false;
    job.error = err.message || String(err);
    job.exitCode = 1;
    emitRoomJob(key, { ...job });
  });
  child.on("exit", (code) => {
    job.running = false;
    job.exitCode = code;
    if (code !== 0 && !job.error) {
      job.error = `${job.label} exited with code ${code}`;
    }
    emitRoomJob(key, { ...job });
  });

  return { ok: true, job };
}
