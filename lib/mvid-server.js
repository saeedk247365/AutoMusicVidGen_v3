/**
 * Express + EJS shell for interactive mvid review.
 */
import express from "express";
import { join, dirname, resolve, relative } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { openFile, resetComfyExecution, comfy } from "./comfy-client.js";
import {
  gpuStatus,
  setGpuBackend,
  resolveComfyUrl,
  resolveComfyUrlForStage,
  getGpuBackend,
  isSaladUrl,
} from "./gpu-backend.js";
import { isComfyUp } from "./ensure-comfy.js";
import {
  saladContainerStatus,
  startContainerGroup,
  stopContainerGroup,
  listContainerGroups,
  saladMgmtConfigured,
} from "./salad-containers.js";
import { collectSystemMetrics } from "./system-metrics.js";
import {
  characterStudioEvents,
  loadCharacter,
  saveCharacter,
  characterStatus,
  startMasterGeneration,
  startMasterFromUpload,
  approveMaster,
  startDatasetGeneration,
  startTrainLora,
  defaultCharacterDoc,
  masterImagePath,
  mastersDirFor,
  datasetDirFor,
  selectMasterCandidate,
  updateShot,
  regenerateShot,
  regenerateKeyframe,
  CHARACTER_PRESETS,
  getJob,
} from "./character-studio.js";
import {
  ROOM_PRESETS,
  listRooms,
  createRoom,
  startRoomGeneration,
  getRoomJob,
  roomStudioEvents,
} from "./room-studio.js";
import {
  packageYouTube,
  exportYouTubePackage,
} from "./youtube-package.js";
import { describeAndAutofillCharacter } from "./describe-character-image.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHARACTERS_DIR = join(ROOT, "characters");
const SCENES_DIR = join(ROOT, "scenes");

function slugId(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

export function createMvidServer(orchestrator, { port = 3847 } = {}) {
  const app = express();
  app.set("view engine", "ejs");
  app.set("views", join(ROOT, "views"));
  app.use(express.json({ limit: "16mb" }));
  app.use(
    "/static",
    express.static(join(ROOT, "public"), {
      etag: false,
      lastModified: false,
      setHeaders(res) {
        res.setHeader("Cache-Control", "no-store");
      },
    }),
  );

  const sseClients = new Set();
  /** @type {{ t: number, message: string }[]} */
  const logHistory = [];
  const MAX_LOG_HISTORY = 400;

  function rememberLog(message) {
    const msg = String(message || "").trim();
    if (!msg) return;
    logHistory.push({ t: Date.now(), message: msg });
    if (logHistory.length > MAX_LOG_HISTORY) {
      logHistory.splice(0, logHistory.length - MAX_LOG_HISTORY);
    }
  }

  function broadcast(event) {
    if (event?.type === "log" && event.message) {
      rememberLog(event.message);
    }
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(data);
      } catch {
        sseClients.delete(res);
      }
    }
  }

  orchestrator.on("sse", broadcast);
  orchestrator.on("state", (state) =>
    broadcast({ type: "state", ...state, gpu: gpuStatus() }),
  );
  characterStudioEvents.on("job", (payload) =>
    broadcast({ type: "character-job", ...payload }),
  );
  roomStudioEvents.on("job", (payload) =>
    broadcast({ type: "room-job", ...payload }),
  );

  app.get("/", (_req, res) => {
    res.render("mvid", {
      initial: { ...orchestrator.getState(), gpu: gpuStatus() },
    });
  });

  app.get("/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();
    res.write(
      `data: ${JSON.stringify({
        type: "state",
        ...orchestrator.getState(),
        gpu: gpuStatus(),
      })}\n\n`,
    );
    if (logHistory.length) {
      res.write(
        `data: ${JSON.stringify({
          type: "log-history",
          lines: logHistory,
        })}\n\n`,
      );
    }
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });

  app.get("/api/state", (_req, res) => {
    res.json({ ...orchestrator.getState(), gpu: gpuStatus() });
  });

  app.get("/api/gpu", async (_req, res) => {
    const status = gpuStatus();
    const up = await isComfyUp(status.comfyUrl);
    res.json({ ...status, comfyUp: up });
  });

  app.get("/api/metrics", async (_req, res) => {
    try {
      const metrics = await collectSystemMetrics();
      res.json(metrics);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/gpu", async (req, res) => {
    const backend = req.body?.backend;
    const result = setGpuBackend(backend);
    if (result.ok) {
      const synced = orchestrator.syncGpuRoute();
      broadcast({
        type: "log",
        message:
          `GPU route → ${synced.backend}` +
          (synced.clipsComfyUrl !== synced.comfyUrl
            ? ` · clips ${synced.clipsComfyUrl}`
            : ` · ${synced.comfyUrl}`),
      });
      broadcast({ type: "gpu", ...gpuStatus() });
      broadcast({ type: "state", ...orchestrator.getState(), gpu: gpuStatus() });
    }
    const up = result.ok
      ? await isComfyUp(result.comfyUrl)
      : false;
    const clipsUp =
      result.ok && result.clipsComfyUrl && result.clipsComfyUrl !== result.comfyUrl
        ? await isComfyUp(result.clipsComfyUrl)
        : up;
    res.status(result.ok ? 200 : 400).json({
      ...result,
      comfyUp: up,
      clipsComfyUp: clipsUp,
    });
  });

  app.get("/api/resolution", (_req, res) => {
    res.json({
      ok: true,
      outputResolution: orchestrator.outputResolution,
      presets: orchestrator.getState().outputResolutions,
    });
  });

  app.post("/api/resolution", (req, res) => {
    const result = orchestrator.setOutputResolution?.(req.body?.id || req.body?.outputResolution);
    if (!result?.ok) {
      return res.status(400).json({ ok: false, error: "Invalid resolution" });
    }
    broadcast({ type: "resolution", ...result });
    broadcast({ type: "state", ...orchestrator.getState(), gpu: gpuStatus() });
    res.json(result);
  });

  app.get("/api/batches", async (_req, res) => {
    try {
      const batchesRoot = join(ROOT, "batches");
      if (!existsSync(batchesRoot)) {
        return res.json({ ok: true, batches: [] });
      }
      const out = [];
      const dates = (await readdir(batchesRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory() && /^\d{8}$/.test(d.name))
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const date of dates) {
        const dayDir = join(batchesRoot, date);
        const slugs = (await readdir(dayDir, { withFileTypes: true }))
          .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
          .map((d) => d.name);
        for (const slug of slugs) {
          const dir = join(dayDir, slug);
          const rel = `batches/${date}/${slug}`;
          let mtime = 0;
          try {
            const { stat } = await import("fs/promises");
            mtime = (await stat(dir)).mtimeMs;
          } catch {
            /* ignore */
          }
          const hasFinal = existsSync(join(dir, "final.mp4"));
          const hasPreview = existsSync(join(dir, "preview.mp4"));
          const hasLyrics = existsSync(join(dir, "lyrics.txt"));
          let hasClips = false;
          let hasKeyframes = false;
          let hasMp3 = false;
          try {
            const clips = existsSync(join(dir, "clips"))
              ? await readdir(join(dir, "clips"))
              : [];
            hasClips = clips.some((f) => /\.mp4$/i.test(f));
            const kfs = existsSync(join(dir, "keyframes"))
              ? await readdir(join(dir, "keyframes"))
              : [];
            hasKeyframes = kfs.some((f) => /\.png$/i.test(f));
            const top = await readdir(dir);
            hasMp3 = top.some((f) => /\.mp3$/i.test(f));
          } catch {
            /* ignore */
          }
          out.push({
            id: `${date}/${slug}`,
            path: rel,
            date,
            slug,
            mtime,
            hasFinal,
            hasPreview,
            hasClips,
            hasKeyframes,
            hasMp3,
            hasLyrics,
          });
        }
      }
      out.sort((a, b) => b.mtime - a.mtime);
      res.json({ ok: true, batches: out, current: orchestrator.songRel || null });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/open-song", async (req, res) => {
    try {
      const path = req.body?.path || req.body?.song || req.body?.id;
      const result = await orchestrator.openSong(path);
      if (!result.ok) return res.status(404).json(result);
      broadcast({ type: "state", ...orchestrator.getState(), gpu: gpuStatus() });
      broadcast({ type: "log", message: `Opened ${result.songDir}` });
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/continue", async (req, res) => {
    try {
      const fromStage = req.body?.fromStage || null;
      const result = await orchestrator.continuePipeline({ fromStage });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/new-project", async (req, res) => {
    try {
      const result = await orchestrator.startNewProject(req.body || {});
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/suggest-brief", (req, res) => {
    try {
      const result = orchestrator.applySuggestedBrief(req.body || {});
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.get("/api/characters", async (_req, res) => {
    try {
      const files = (await readdir(CHARACTERS_DIR)).filter((f) =>
        f.endsWith(".json"),
      );
      const list = [];
      for (const f of files) {
        try {
          const raw = JSON.parse(await readFile(join(CHARACTERS_DIR, f), "utf8"));
          const id = raw.id || f.replace(/\.json$/i, "");
          const masterExists = existsSync(masterImagePath(id));
          const approved = existsSync(
            join(ROOT, "dataset", String(id).toLowerCase(), "master_approved.json"),
          );
          list.push({
            id,
            name: raw.name || raw.id,
            role: raw.role || "",
            appearance: raw.appearance || "",
            outfit: raw.outfit || "",
            negative: raw.negative || "",
            hasLora: !!raw.loraName,
            hasMaster: masterExists,
            masterApproved: masterExists && approved,
          });
        } catch {
          /* skip */
        }
      }
      res.json({ ok: true, characters: list });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.get("/api/characters/:id", async (req, res) => {
    try {
      const status = await characterStatus(req.params.id);
      if (!status.ok) return res.status(404).json(status);
      res.json(status);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.put("/api/characters/:id", async (req, res) => {
    try {
      const id = slugId(req.params.id);
      const prev = await loadCharacter(id);
      if (!prev) {
        return res.status(404).json({ ok: false, error: "Character not found" });
      }
      const body = req.body || {};
      const allowed = [
        "name",
        "role",
        "trigger",
        "age",
        "appearance",
        "outfit",
        "negative",
        "styleTag",
        "loraName",
        "loraStrength",
        "seed",
        "checkpoint",
        "comfyUrl",
      ];
      const patch = {};
      for (const key of allowed) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      const character = await saveCharacter(id, patch);
      res.json({ ok: true, character });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/characters", async (req, res) => {
    try {
      const body = req.body || {};
      const id = slugId(body.id || body.name);
      if (!id) return res.status(400).json({ ok: false, error: "id/name required" });
      const path = join(CHARACTERS_DIR, `${id}.json`);
      if (existsSync(path) && !body.overwrite) {
        return res.status(409).json({ ok: false, error: `Character ${id} exists` });
      }
      const doc = defaultCharacterDoc({
        id,
        name: body.name || id,
        role: body.role || "toddler",
        appearance: body.appearance || "",
        outfit: body.outfit || "",
        negative: body.negative || "",
        styleTag: body.styleTag || "",
        age: body.age || "",
        trigger: body.trigger || id,
      });
      doc.comfyUrl = resolveComfyUrl();
      if (body.checkpoint) doc.checkpoint = body.checkpoint;
      if (body.loraName !== undefined) doc.loraName = body.loraName;
      await mkdir(CHARACTERS_DIR, { recursive: true });
      await writeFile(path, JSON.stringify(doc, null, 2));
      res.json({ ok: true, character: doc });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.get("/api/character-presets", (_req, res) => {
    res.json({ ok: true, presets: CHARACTER_PRESETS });
  });

  app.post("/api/characters/:id/master", async (req, res) => {
    try {
      const result = startMasterGeneration(req.params.id, {
        force: !!req.body?.force,
        count: req.body?.count ?? 1,
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/characters/:id/master-upload", async (req, res) => {
    try {
      const body = req.body || {};
      const kind = body.kind === "set_master" ? "set_master" : "face_ref";
      const b64 = String(body.imageBase64 || "").replace(/^data:[^;]+;base64,/, "");
      if (!b64) {
        return res.status(400).json({ ok: false, error: "imageBase64 required" });
      }
      const buffer = Buffer.from(b64, "base64");
      const result = await startMasterFromUpload(req.params.id, {
        kind,
        buffer,
        ext: body.ext || "png",
        force: body.force !== false,
        count: body.count ?? 2,
        autofill: body.autofill !== false,
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/characters/:id/describe", async (req, res) => {
    try {
      const body = req.body || {};
      const result = await describeAndAutofillCharacter(req.params.id, {
        source: body.source || "auto",
        save: body.save !== false,
        mergeEmptyOnly: !!body.mergeEmptyOnly,
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/characters/:id/select-master", async (req, res) => {
    try {
      const result = await selectMasterCandidate(
        req.params.id,
        req.body?.file || req.body?.candidate,
      );
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.put("/api/characters/:id/shots/:shotId", async (req, res) => {
    try {
      const result = await updateShot(req.params.id, req.params.shotId, req.body || {});
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/characters/:id/shots/:shotId/regenerate", async (req, res) => {
    try {
      const result = await regenerateShot(req.params.id, req.params.shotId, {
        patch: req.body || {},
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/characters/:id/keyframes/:keyframeId/regenerate", async (req, res) => {
    try {
      const result = await regenerateKeyframe(
        req.params.id,
        req.params.keyframeId,
      );
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/characters/:id/approve-master", async (req, res) => {
    try {
      const result = await approveMaster(req.params.id);
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/characters/:id/dataset", async (req, res) => {
    try {
      const result = await startDatasetGeneration(req.params.id, {
        force: !!req.body?.force,
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/characters/:id/train", async (req, res) => {
    try {
      const result = await startTrainLora(req.params.id);
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.get("/api/characters/:id/job", (req, res) => {
    res.json({ ok: true, job: getJob(req.params.id) });
  });

  app.get("/api/scenes", async (_req, res) => {
    try {
      res.json(await listRooms());
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.get("/api/room-presets", (_req, res) => {
    res.json({ ok: true, presets: ROOM_PRESETS });
  });

  app.post("/api/scenes", async (req, res) => {
    try {
      const body = req.body || {};
      const result = await createRoom({
        id: body.id,
        name: body.name,
        still: body.still,
        overwrite: !!body.overwrite,
        generate: body.generate !== false,
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/scenes/:id/generate", async (req, res) => {
    try {
      const result = startRoomGeneration(req.params.id, {
        force: req.body?.force !== false,
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.get("/api/scenes/:id/job", (req, res) => {
    res.json({ ok: true, job: getRoomJob(req.params.id) });
  });

  app.post("/api/setup", async (req, res) => {
    const result = orchestrator.applySetup?.(req.body || {});
    if (!result?.ok) {
      return res
        .status(400)
        .json(result || { ok: false, error: "Setup not supported" });
    }
    // Draft save only — approval goes through /api/approve
    if (req.body?.approve === true && orchestrator.stage === "await_setup") {
      orchestrator.approve("setup", req.body || {});
    }
    res.json({ ok: true, setup: orchestrator.setup, ...orchestrator.getState() });
  });

  app.post("/api/approve", (req, res) => {
    const stage = req.body?.stage;
    const payload = req.body?.payload || {};
    const result = orchestrator.approve(stage, payload);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post("/api/reject", (req, res) => {
    const stage = req.body?.stage;
    const result = orchestrator.reject(stage);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post("/api/scripts/save", async (req, res) => {
    try {
      const result = await orchestrator.applyScriptsBeats(req.body?.beats);
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/remake-keyframe", async (req, res) => {
    try {
      const result = await orchestrator.remakeKeyframe({
        beatId: req.body?.beatId || req.body?.id,
        only: req.body?.only,
        animate: !!req.body?.animate,
        reuseCutouts: req.body?.reuseCutouts !== false,
        saveBeats: req.body?.beats || req.body?.saveBeats || null,
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/delete-clips", async (req, res) => {
    try {
      const result = await orchestrator.deleteClips({
        names: req.body?.names || req.body?.files || null,
        stems: req.body?.stems || null,
        beatId: req.body?.beatId || req.body?.id || null,
      });
      res.status(result.ok ? 200 : 400).json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/auto-approve", (req, res) => {
    orchestrator.setAutoApprove(!!req.body?.enabled);
    res.json({ ok: true, autoApprove: orchestrator.autoApprove });
  });

  app.post("/api/pause", async (_req, res) => {
    const result = await orchestrator.pause();
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post("/api/resume", (_req, res) => {
    const result = orchestrator.resume();
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post("/api/stop", async (req, res) => {
    const result = await orchestrator.stop(
      req.body?.reason || "Stopped by user",
    );
    res.json(result);
  });

  app.post("/api/youtube-package", async (_req, res) => {
    try {
      if (!orchestrator.songDir) {
        return res.status(400).json({ ok: false, error: "No song open" });
      }
      const pkg = await packageYouTube(orchestrator.songDir, {
        log: (m) => broadcast({ type: "log", message: String(m) }),
      });
      await orchestrator.refreshTabsFromDisk();
      broadcast({ type: "state", ...orchestrator.getState(), gpu: gpuStatus() });
      res.json({ ok: true, package: pkg });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/export-youtube", async (_req, res) => {
    try {
      if (!orchestrator.songDir) {
        return res.status(400).json({ ok: false, error: "No song open" });
      }
      if (!existsSync(join(orchestrator.songDir, "youtube", "metadata.json"))) {
        await packageYouTube(orchestrator.songDir, {
          log: (m) => broadcast({ type: "log", message: String(m) }),
        });
      }
      const exp = await exportYouTubePackage(orchestrator.songDir);
      broadcast({
        type: "log",
        message: `Exported YouTube package → ${exp.dest}`,
      });
      res.json({ ok: true, ...exp });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.get("/api/salad/status", async (_req, res) => {
    try {
      const status = await saladContainerStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.get("/api/salad/containers", async (_req, res) => {
    try {
      if (!saladMgmtConfigured()) {
        return res.status(400).json({
          ok: false,
          error: "Set SALAD_ORG in .env to list containers",
        });
      }
      const data = await listContainerGroups();
      res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/salad/start", async (req, res) => {
    try {
      const name = req.body?.name;
      const result = await startContainerGroup(name || undefined);
      const status = await saladContainerStatus();
      res.json({ ok: true, started: result, status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/salad/stop", async (req, res) => {
    try {
      const name = req.body?.name;
      const result = await stopContainerGroup(name || undefined);
      const status = await saladContainerStatus();
      res.json({ ok: true, stopped: result, status });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || String(err) });
    }
  });

  /** Resolve which Comfy URL ops should target (Salad Wan URL when split/salad). */
  function opsComfyUrl(req) {
    const stage = String(req.query?.stage || req.body?.stage || "clips");
    if (stage === "local" || stage === "prep") {
      return resolveComfyUrlForStage("prep");
    }
    return resolveComfyUrlForStage(stage === "clips" ? "clips" : stage);
  }

  app.get("/api/comfy/ops", async (req, res) => {
    try {
      const url = opsComfyUrl(req);
      const salad = isSaladUrl(url);
      const [up, queue, stats] = await Promise.all([
        isComfyUp(url),
        comfy(url, "/queue", { timeoutMs: salad ? 15000 : 5000 }).catch((e) => ({
          error: e.message || String(e),
        })),
        comfy(url, "/system_stats", {
          timeoutMs: salad ? 15000 : 5000,
        }).catch((e) => ({ error: e.message || String(e) })),
      ]);
      const running = Array.isArray(queue?.queue_running)
        ? queue.queue_running
        : [];
      const pending = Array.isArray(queue?.queue_pending)
        ? queue.queue_pending
        : [];
      const devices = Array.isArray(stats?.devices) ? stats.devices : [];
      res.json({
        ok: true,
        url,
        salad,
        backend: getGpuBackend(),
        up,
        queueError: queue?.error || null,
        statsError: stats?.error || null,
        running: running.length,
        pending: pending.length,
        runningIds: running.map((r) => r?.[1] || r?.prompt_id || "?").slice(0, 8),
        pendingIds: pending.map((r) => r?.[1] || r?.prompt_id || "?").slice(0, 8),
        devices: devices.map((d) => ({
          name: d?.name || d?.index || "gpu",
          type: d?.type || null,
          vramTotalMb: d?.vram_total != null ? Math.round(d.vram_total / 1e6) : null,
          vramFreeMb: d?.vram_free != null ? Math.round(d.vram_free / 1e6) : null,
          vramUsedMb:
            d?.vram_total != null && d?.vram_free != null
              ? Math.round((d.vram_total - d.vram_free) / 1e6)
              : null,
        })),
        comfy: stats?.system?.comfyui_version || stats?.system?.comfy || null,
        pytorch: stats?.system?.pytorch_version || null,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/comfy/interrupt", async (req, res) => {
    try {
      const url = opsComfyUrl(req);
      await comfy(url, "/interrupt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        timeoutMs: 30000,
      });
      res.json({ ok: true, url, action: "interrupt" });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/comfy/clear-queue", async (req, res) => {
    try {
      const url = opsComfyUrl(req);
      await comfy(url, "/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear: true }),
        timeoutMs: 30000,
      });
      res.json({ ok: true, url, action: "clear-queue" });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || String(err) });
    }
  });

  app.post("/api/comfy/reset", async (req, res) => {
    try {
      const url = opsComfyUrl(req);
      await resetComfyExecution(url, { label: "ui-reset" });
      res.json({ ok: true, url, action: "reset" });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message || String(err) });
    }
  });

  function safeSongFile(...parts) {
    const songDir = orchestrator.songDir;
    if (!songDir) return null;
    const full = resolve(songDir, ...parts);
    const rel = relative(songDir, full);
    if (!rel || rel.startsWith("..") || rel.split(/[/\\]/).includes("..")) return null;
    if (!existsSync(full)) return null;
    return full;
  }

  function sendSongMedia(res, file) {
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.sendFile(file);
  }

  app.get("/media/song/:name", (req, res) => {
    const file = safeSongFile(req.params.name);
    if (!file) return res.status(404).end();
    sendSongMedia(res, file);
  });

  app.get("/media/keyframes/:name", (req, res) => {
    const file = safeSongFile("keyframes", req.params.name);
    if (!file) return res.status(404).end();
    sendSongMedia(res, file);
  });

  app.get("/media/clips/:name", (req, res) => {
    const file = safeSongFile("clips", req.params.name);
    if (!file) return res.status(404).end();
    sendSongMedia(res, file);
  });

  app.get("/media/preview.mp4", (_req, res) => {
    const file = safeSongFile("preview.mp4");
    if (!file) return res.status(404).end();
    sendSongMedia(res, file);
  });

  app.get("/media/final.mp4", (_req, res) => {
    const file = safeSongFile("final.mp4");
    if (!file) return res.status(404).end();
    sendSongMedia(res, file);
  });

  app.get("/media/youtube/thumbnail.jpg", (_req, res) => {
    const file = safeSongFile("youtube", "thumbnail.jpg");
    if (!file) return res.status(404).end();
    sendSongMedia(res, file);
  });

  app.get("/media/scenes/:name", (req, res) => {
    const name = req.params.name;
    let file = safeSongFile("scenes", name);
    if (!file) {
      const shared = join(ROOT, "scenes", name);
      if (existsSync(shared)) file = shared;
    }
    if (!file) return res.status(404).end();
    sendSongMedia(res, file);
  });

  app.get("/media/dataset/:id/master_identity.png", (req, res) => {
    const id = slugId(req.params.id);
    const file = masterImagePath(id);
    if (!existsSync(file)) return res.status(404).end();
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.sendFile(file);
  });

  app.get("/media/dataset/:id/reference.png", (req, res) => {
    const id = slugId(req.params.id);
    const file = join(datasetDirFor(id), "reference.png");
    if (!existsSync(file)) return res.status(404).end();
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.sendFile(file);
  });

  app.get("/media/dataset/:id/uploads/:file", (req, res) => {
    const id = slugId(req.params.id);
    const name = String(req.params.file || "");
    if (!/^(face_ref|set_master)\.(png|jpe?g|webp)$/i.test(name)) {
      return res.status(400).end();
    }
    const file = join(datasetDirFor(id), "uploads", name);
    if (!existsSync(file)) return res.status(404).end();
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.sendFile(file);
  });

  app.get("/media/dataset/:id/masters/:file", (req, res) => {
    const id = slugId(req.params.id);
    const name = String(req.params.file || "");
    if (!/^candidate_\d+\.png$/i.test(name)) return res.status(400).end();
    const file = join(mastersDirFor(id), name);
    if (!existsSync(file)) return res.status(404).end();
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.sendFile(file);
  });

  app.get("/media/dataset/:id/images/:file", (req, res) => {
    const id = slugId(req.params.id);
    const name = String(req.params.file || "");
    if (!/^[\w.-]+\.(png|jpe?g|webp)$/i.test(name)) return res.status(400).end();
    const file = join(datasetDirFor(id), "images", name);
    if (!existsSync(file)) return res.status(404).end();
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.sendFile(file);
  });

  app.get("/media/dataset/:id/keyframes/:file", (req, res) => {
    const id = slugId(req.params.id);
    const name = String(req.params.file || "");
    if (!/^[\w.-]+\.(png|jpe?g|webp)$/i.test(name)) return res.status(400).end();
    const file = join(datasetDirFor(id), "keyframes", name);
    if (!existsSync(file)) return res.status(404).end();
    res.setHeader("Cache-Control", "no-store, must-revalidate");
    res.sendFile(file);
  });

  function listen() {
    return new Promise((resolveListen, rejectListen) => {
      const server = app.listen(port, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${port}/`;
        console.log(`mvid GUI → ${url}`);
        try {
          openFile(url);
        } catch (err) {
          console.warn(`Could not open browser: ${err.message || err}`);
        }
        resolveListen({ server, url });
      });
      server.on("error", (err) => {
        rejectListen(err);
      });
    });
  }

  return { app, listen, broadcast };
}
