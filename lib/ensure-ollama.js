/**
 * Ensure local Ollama is reachable; start `ollama serve` if needed.
 */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import { platform, homedir } from "os";
import { sleep } from "./comfy-client.js";

export const DEFAULT_OLLAMA_URL = (
  process.env.OLLAMA_URL || "http://127.0.0.1:11434"
).replace(/\/$/, "");

export async function isOllamaUp(url = DEFAULT_OLLAMA_URL) {
  try {
    const res = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function candidateBins() {
  const bins = [];
  const envBin = (process.env.OLLAMA_BIN || "").trim();
  if (envBin) bins.push(envBin);

  if (platform() === "win32") {
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    bins.push(join(local, "Programs", "Ollama", "ollama.exe"));
    bins.push(join(local, "Ollama", "ollama.exe"));
    bins.push("ollama.exe");
    bins.push("ollama");
  } else {
    bins.push("/usr/local/bin/ollama");
    bins.push("/opt/homebrew/bin/ollama");
    bins.push(join(homedir(), ".local", "bin", "ollama"));
    bins.push("ollama");
  }
  return bins;
}

export function resolveOllamaBin() {
  for (const bin of candidateBins()) {
    if (!bin.includes("/") && !bin.includes("\\")) {
      // bare name — leave to PATH via spawn
      return bin;
    }
    if (existsSync(bin)) return bin;
  }
  return platform() === "win32" ? "ollama.exe" : "ollama";
}

/**
 * Start Ollama API server in the background (detached).
 */
export function startOllamaBackground() {
  const bin = resolveOllamaBin();
  console.log(`Starting Ollama: ${bin} serve`);
  const child = spawn(bin, ["serve"], {
    cwd: homedir(),
    stdio: "ignore",
    detached: true,
    windowsHide: true,
    env: { ...process.env },
  });
  child.on("error", (err) => {
    console.error(`Failed to spawn Ollama (${bin}): ${err.message || err}`);
  });
  child.unref();
  return child;
}

/**
 * If Ollama is down, start it and wait until /api/tags responds.
 * @returns {{ started: boolean, url: string }}
 */
export async function ensureOllamaRunning(
  url = DEFAULT_OLLAMA_URL,
  { timeoutMs = 90000, pollMs = 1500, onLog = null } = {},
) {
  const base = (url || DEFAULT_OLLAMA_URL).replace(/\/$/, "");
  if (await isOllamaUp(base)) {
    console.log(`Ollama already running at ${base}`);
    return { started: false, url: base };
  }

  const msg = `Ollama not reachable at ${base} — starting…`;
  console.log(msg);
  if (typeof onLog === "function") onLog(msg);

  startOllamaBackground();

  const startedAt = Date.now();
  let lastLog = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(pollMs);
    if (await isOllamaUp(base)) {
      const ok = `Ollama ready at ${base}`;
      console.log(ok);
      if (typeof onLog === "function") onLog(ok);
      return { started: true, url: base };
    }
    const now = Date.now();
    if (now - lastLog > 10000) {
      lastLog = now;
      const wait = `Waiting for Ollama… ${Math.round((now - startedAt) / 1000)}s`;
      console.log(wait);
      if (typeof onLog === "function") onLog(wait);
    }
  }

  throw new Error(
    `Ollama did not become ready at ${base} within ${Math.round(timeoutMs / 1000)}s. Install Ollama or set OLLAMA_BIN / OLLAMA_URL.`,
  );
}
