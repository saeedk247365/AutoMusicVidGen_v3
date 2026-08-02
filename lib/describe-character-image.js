/**
 * Vision caption → character prompt autofill (style/outfit/age lock).
 * Identity still comes from the image (FaceID / set-master); this only fills text fields.
 */
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  ensureOllamaRunning,
  DEFAULT_OLLAMA_URL,
} from "./ensure-ollama.js";
import { datasetDirFor, loadCharacter, saveCharacter } from "./character-studio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const DESCRIBE_SYSTEM = `You describe cartoon / kids-character reference images for LoRA training prompts.
Return ONLY valid JSON (no markdown, no prose) with keys:
appearance, outfit, styleTag, age, negative, gender, ageBand, styleFamily
Rules:
- Keep each value short and concrete (appearance <= 40 words, outfit <= 20 words).
- outfit: SIMPLE solid garments only — solid colors, no thin stripes, no tiny asymmetric chest patches, no layered undersleeves, no logos/text. Example: "solid sky blue hoodie, grey sweatpants, orange sneakers".
- appearance: face, hair, age cues, body proportions only.
- styleTag: art style + age/gender lock (e.g. "slim toddler boy cartoon proportions, male child only").
- age: short phrase like "toddler boy, about 2 years old".
- gender: one of boy|girl|man|woman
- ageBand: one of toddler|child|teen|adult
- styleFamily: one of flat2d|kids3d|anime
- negative: comma-separated things to avoid (wrong age, wrong gender, photoreal if image is cartoon, etc.).
- If the image is a real photo, describe the person for a FLAT CARTOON translation (not photoreal wording).
- outfit: SIMPLE solid garments preferred when the image is simple; if the image has a chest patch, stripes, or distinct shoe colors, describe those exact details so prompts match the plate.
- Do NOT invent a second person. Do NOT describe background rooms. Include distinctive marks (fox patch, sleeve stripes, logo) when visible.`;

const DESCRIBE_USER = `Describe this character reference for consistent dataset captions.
Focus on outfit colors, age/proportions, hair, and illustration style.
JSON only.`;

function pickVisionModel(models) {
  const env = (process.env.OLLAMA_VISION_MODEL || "").trim();
  if (env) return env;
  const names = (models || []).map((m) => m.name || m.model || "").filter(Boolean);
  const prefer = [
    /^gemma3:/i,
    /^llava/i,
    /^qwen2\.5-vl/i,
    /^qwen.*vl/i,
    /^minicpm-v/i,
    /^moondream/i,
    /^llama3\.2-vision/i,
  ];
  for (const re of prefer) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  // gemma3:4b is multimodal on current Ollama builds
  if (names.includes("gemma3:4b")) return "gemma3:4b";
  return names[0] || "gemma3:4b";
}

function stripThink(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();
}

function parseDescribeJson(raw) {
  const text = stripThink(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("Vision model did not return JSON");
  }
  const obj = JSON.parse(text.slice(start, end + 1));
  const clean = (v, max = 500) =>
    String(v || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  return {
    appearance: clean(obj.appearance, 400),
    outfit: clean(obj.outfit, 160),
    styleTag: clean(obj.styleTag, 160),
    age: clean(obj.age, 120),
    negative: clean(obj.negative, 400),
    gender: clean(obj.gender, 20).toLowerCase(),
    ageBand: clean(obj.ageBand, 20).toLowerCase(),
    styleFamily: clean(obj.styleFamily, 20).toLowerCase(),
  };
}

export async function listOllamaModels(url = DEFAULT_OLLAMA_URL) {
  const res = await fetch(`${url}/api/tags`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Ollama tags failed: ${res.status}`);
  const data = await res.json();
  return data.models || [];
}

export async function describeImageBuffer(buffer, { model = null } = {}) {
  await ensureOllamaRunning();
  const models = await listOllamaModels();
  const visionModel = model || pickVisionModel(models);
  const b64 = Buffer.from(buffer).toString("base64");

  const controller = new AbortController();
  const kill = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(`${DEFAULT_OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: visionModel,
        stream: false,
        think: false,
        messages: [
          { role: "system", content: DESCRIBE_SYSTEM },
          {
            role: "user",
            content: DESCRIBE_USER,
            images: [b64],
          },
        ],
        options: { temperature: 0.2, top_p: 0.9, num_predict: 500 },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama vision ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    const content = data?.message?.content || data?.response || "";
    const fields = parseDescribeJson(content);
    return { ok: true, model: visionModel, fields };
  } catch (err) {
    if (err?.name === "AbortError") {
      return { ok: false, error: "Vision describe timed out" };
    }
    return { ok: false, error: err.message || String(err) };
  } finally {
    clearTimeout(kill);
  }
}

export function resolveDescribeSourcePath(id, source = "auto") {
  const key = String(id).toLowerCase();
  const outDir = datasetDirFor(key);
  const uploads = join(outDir, "uploads");
  const candidates = {
    master: join(outDir, "master_identity.png"),
    reference: join(outDir, "reference.png"),
    face_ref: ["png", "jpg", "jpeg", "webp"].map((e) =>
      join(uploads, `face_ref.${e}`),
    ),
    set_master: ["png", "jpg", "jpeg", "webp"].map((e) =>
      join(uploads, `set_master.${e}`),
    ),
  };

  if (source === "auto") {
    const order = [
      candidates.master,
      candidates.reference,
      ...candidates.set_master,
      ...candidates.face_ref,
    ];
    return order.find((p) => existsSync(p)) || null;
  }
  if (source === "face_ref") {
    return candidates.face_ref.find((p) => existsSync(p)) || null;
  }
  if (source === "set_master") {
    return candidates.set_master.find((p) => existsSync(p)) || null;
  }
  if (source === "reference") {
    return existsSync(candidates.reference) ? candidates.reference : null;
  }
  if (source === "master") {
    return existsSync(candidates.master) ? candidates.master : null;
  }
  return null;
}

/**
 * Describe upload/master and optionally patch character JSON prompt fields.
 */
export async function describeAndAutofillCharacter(
  id,
  { source = "auto", save = true, mergeEmptyOnly = false } = {},
) {
  const key = String(id).toLowerCase();
  const char = await loadCharacter(key);
  if (!char) return { ok: false, error: "Character not found" };

  const path = resolveDescribeSourcePath(key, source);
  if (!path) {
    return {
      ok: false,
      error: "No image to describe — upload a face photo or cartoon still first",
    };
  }

  const buf = await readFile(path);
  const described = await describeImageBuffer(buf);
  if (!described.ok) return described;

  const fields = described.fields;
  const patch = {};
  const textKeys = ["appearance", "outfit", "styleTag", "age", "negative"];
  for (const k of textKeys) {
    if (!fields[k]) continue;
    if (mergeEmptyOnly && String(char[k] || "").trim()) continue;
    patch[k] = fields[k];
  }
  const genderOk = ["boy", "girl", "man", "woman"].includes(fields.gender);
  const ageOk = ["toddler", "child", "teen", "adult"].includes(fields.ageBand);
  const styleOk = ["flat2d", "kids3d", "anime"].includes(fields.styleFamily);
  if (genderOk && !(mergeEmptyOnly && char.gender)) patch.gender = fields.gender;
  if (ageOk && !(mergeEmptyOnly && char.ageBand)) patch.ageBand = fields.ageBand;
  if (styleOk && !(mergeEmptyOnly && char.styleFamily)) {
    patch.styleFamily = fields.styleFamily;
  }

  let character = char;
  if (save && Object.keys(patch).length) {
    character = await saveCharacter(key, patch);
  }

  return {
    ok: true,
    model: described.model,
    sourcePath: path.replace(/\\/g, "/").replace(ROOT.replace(/\\/g, "/") + "/", ""),
    fields,
    patch,
    character,
  };
}
