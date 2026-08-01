/**
 * YouTube packaging: title, description, thumbnail, thumb intro on final.mp4,
 * and export to exports/<Song Title>/.
 */
import { existsSync } from "fs";
import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  readdir,
  unlink,
} from "fs/promises";
import { join, basename, dirname } from "path";
import { fileURLToPath } from "url";
import { promisify } from "util";
import { execFile } from "child_process";
import sharp from "sharp";
import { stripBom } from "./comfy-client.js";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const INTRO_SEC = 2.0;

function safeTitle(raw) {
  return String(raw || "Kids Song")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100) || "Kids Song";
}

function folderNameFromTitle(title) {
  return safeTitle(title);
}

async function ffprobeDuration(path) {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
      ],
      { windowsHide: true },
    );
    return Math.max(0, Number(String(stdout).trim()) || 0);
  } catch {
    return 0;
  }
}

async function loadMeta(songDir) {
  const metaPath = join(songDir, "kids-hit-meta.json");
  const sessionPath = join(songDir, "mvid-session.json");
  let meta = {};
  let session = {};
  if (existsSync(metaPath)) {
    try {
      meta = JSON.parse(stripBom(await readFile(metaPath, "utf8")));
    } catch {
      /* ignore */
    }
  }
  if (existsSync(sessionPath)) {
    try {
      session = JSON.parse(stripBom(await readFile(sessionPath, "utf8")));
    } catch {
      /* ignore */
    }
  }
  let lyrics = "";
  const lyricsPath = join(songDir, "lyrics.txt");
  if (existsSync(lyricsPath)) {
    lyrics = stripBom(await readFile(lyricsPath, "utf8"));
  }
  const title =
    safeTitle(meta.title || session.title || basename(songDir)) || "Kids Song";
  return { meta, session, lyrics, title };
}

export function buildYoutubeTitle(title, objective = "") {
  const t = safeTitle(title);
  const obj = String(objective || "").trim();
  if (/wash|hand/i.test(obj) || /wash/i.test(t)) {
    return `${t} | Kids Hand Washing Song`;
  }
  return `${t} | Kids Song`;
}

export function buildYoutubeDescription({
  title,
  objective,
  theme,
  lyrics,
  cast = ["Adam", "Sasha"],
} = {}) {
  const lines = [
    buildYoutubeTitle(title, objective),
    "",
    objective
      ? `Today's fun: ${objective}.`
      : "A preschool singalong for little helpers.",
    theme ? `Theme: ${theme}.` : null,
    `Featuring ${cast.join(" & ")}.`,
    "",
    "Sing along, move along, and learn through play!",
    "",
    "Lyrics:",
    String(lyrics || "")
      .replace(/^TITLE:.*$/gim, "")
      .replace(/^OBJECTIVE:.*$/gim, "")
      .replace(/^LYRICS:\s*$/gim, "")
      .trim()
      .slice(0, 2500),
    "",
    "#KidsSongs #Preschool #NurseryRhymes #SingAlong #KidsMusic",
    "",
    "Made for kids · Family-friendly",
  ].filter((x) => x != null);
  return lines.join("\n");
}

async function pickHeroKeyframe(songDir) {
  const kfDir = join(songDir, "keyframes");
  if (!existsSync(kfDir)) return null;
  const files = (await readdir(kfDir))
    .filter((f) => /\.png$/i.test(f) && !f.includes("_camera"))
    .sort();
  // Prefer a mid chorus / middle beat if available
  const mid = files[Math.min(Math.floor(files.length / 2), files.length - 1)];
  return mid ? join(kfDir, mid) : null;
}

/**
 * 1280×720 thumbnail: hero still + title bar.
 */
export async function renderThumbnail(songDir, title, outPath) {
  const hero = await pickHeroKeyframe(songDir);
  const W = 1280;
  const H = 720;
  const label = safeTitle(title).slice(0, 42);
  const esc = label
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  let base;
  if (hero && existsSync(hero)) {
    base = await sharp(hero)
      .resize(W, H, { fit: "cover", position: "centre" })
      .jpeg({ quality: 90 })
      .toBuffer();
  } else {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#7ec8e3"/><stop offset="100%" stop-color="#f7b267"/>
  </linearGradient></defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
</svg>`;
    base = await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
  }

  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect x="0" y="${H - 140}" width="${W}" height="140" fill="rgba(20,20,30,0.72)"/>
  <text x="48" y="${H - 70}" font-family="Segoe UI, Arial, sans-serif" font-size="54" font-weight="700" fill="white">${esc}</text>
  <text x="48" y="${H - 28}" font-family="Segoe UI, Arial, sans-serif" font-size="28" fill="#ffe08a">Kids Singalong</text>
</svg>`);

  await sharp(base)
    .composite([{ input: overlay, top: 0, left: 0 }])
    .jpeg({ quality: 92 })
    .toFile(outPath);
  return outPath;
}

/**
 * Prepend INTRO_SEC seconds of the thumbnail still to final.mp4 (in place).
 */
export async function prependThumbnailIntro(finalPath, thumbPath, {
  fps = 16,
  width = 768,
  height = 768,
} = {}) {
  if (!existsSync(finalPath) || !existsSync(thumbPath)) {
    throw new Error("final.mp4 or thumbnail missing for intro prepend");
  }
  const workDir = join(dirname(finalPath), "_yt_work");
  await mkdir(workDir, { recursive: true });
  const introStill = join(workDir, "intro_still.png");
  const introMp4 = join(workDir, "intro.mp4");
  const bodyNoAudio = join(workDir, "body_v.mp4");
  const mergedSilent = join(workDir, "merged_v.mp4");
  const outTmp = join(workDir, "final_with_intro.mp4");

  await sharp(thumbPath)
    .resize(width, height, { fit: "cover", position: "centre" })
    .png()
    .toFile(introStill);

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-loop",
      "1",
      "-i",
      introStill,
      "-t",
      String(INTRO_SEC),
      "-r",
      String(fps),
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-an",
      introMp4,
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );

  // Strip audio from body for clean concat, then re-mux with delayed audio
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      finalPath,
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      bodyNoAudio,
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );

  const listPath = join(workDir, "concat.txt");
  await writeFile(
    listPath,
    `file '${introMp4.replace(/\\/g, "/")}'\nfile '${bodyNoAudio.replace(/\\/g, "/")}'\n`,
  );

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-c:v",
      "libx264",
      "-b:v",
      "4M",
      "-pix_fmt",
      "yuv420p",
      "-an",
      mergedSilent,
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );

  // Audio from original starts after intro (adelay in ms)
  const delayMs = Math.round(INTRO_SEC * 1000);
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      mergedSilent,
      "-i",
      finalPath,
      "-filter_complex",
      `[1:a]adelay=${delayMs}|${delayMs},apad[a]`,
      "-map",
      "0:v:0",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-b:v",
      "4M",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest",
      outTmp,
    ],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
  );

  const bak = join(dirname(finalPath), "final_body.mp4");
  if (!existsSync(bak)) {
    await copyFile(finalPath, bak);
  }
  await copyFile(outTmp, finalPath);
  return { introSec: INTRO_SEC, finalPath };
}

/**
 * Build youtube/ folder under songDir and prepend thumb intro to final.mp4.
 */
export async function packageYouTube(songDir, { log = console.log } = {}) {
  const { meta, lyrics, title } = await loadMeta(songDir);
  const ytDir = join(songDir, "youtube");
  await mkdir(ytDir, { recursive: true });

  const ytTitle = buildYoutubeTitle(title, meta.objective);
  const description = buildYoutubeDescription({
    title,
    objective: meta.objective,
    theme: meta.theme,
    lyrics,
    cast: ["Adam", "Sasha"],
  });

  const thumbPath = join(ytDir, "thumbnail.jpg");
  await renderThumbnail(songDir, title, thumbPath);
  await writeFile(join(ytDir, "title.txt"), ytTitle + "\n", "utf8");
  await writeFile(join(ytDir, "description.txt"), description + "\n", "utf8");

  const finalPath = join(songDir, "final.mp4");
  let introApplied = false;
  if (existsSync(finalPath)) {
    // Probe size from final
    let width = 768;
    let height = 768;
    let fps = 16;
    try {
      const { stdout } = await execFileAsync(
        "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height,r_frame_rate",
          "-of",
          "json",
          finalPath,
        ],
        { windowsHide: true },
      );
      const j = JSON.parse(stdout);
      const s = j.streams?.[0];
      if (s?.width) width = s.width;
      if (s?.height) height = s.height;
      if (s?.r_frame_rate && String(s.r_frame_rate).includes("/")) {
        const [a, b] = String(s.r_frame_rate).split("/").map(Number);
        if (a && b) fps = Math.round(a / b) || 16;
      }
    } catch {
      /* defaults */
    }

    // Avoid double-prepending if already packaged
    const marker = join(ytDir, "intro_applied.json");
    if (!existsSync(marker)) {
      log(`  YouTube: prepending ${INTRO_SEC}s thumbnail intro…`);
      await prependThumbnailIntro(finalPath, thumbPath, { fps, width, height });
      await writeFile(
        marker,
        JSON.stringify({ introSec: INTRO_SEC, at: new Date().toISOString() }, null, 2),
      );
      introApplied = true;
    }
  }

  const durationSec = existsSync(finalPath)
    ? await ffprobeDuration(finalPath)
    : meta.durationSec || 75;

  const metadata = {
    title: ytTitle,
    description,
    thumbnail: "thumbnail.jpg",
    tags: [
      "kids songs",
      "preschool",
      "nursery rhymes",
      "sing along",
      "hand washing",
      "adam",
      "sasha",
    ],
    category: "Education",
    madeForKids: true,
    durationSec,
    introSec: INTRO_SEC,
    songTitle: title,
    objective: meta.objective || "",
    theme: meta.theme || "",
    createdAt: new Date().toISOString(),
  };
  await writeFile(
    join(ytDir, "metadata.json"),
    JSON.stringify(metadata, null, 2),
    "utf8",
  );

  log(`  YouTube package ready: ${ytDir}`);
  return {
    ytDir,
    title: ytTitle,
    description,
    thumbnailPath: thumbPath,
    introApplied,
    metadata,
  };
}

/**
 * Copy packaged assets into exports/<Song Title>/.
 */
export async function exportYouTubePackage(songDir, {
  exportsRoot = join(ROOT, "exports"),
} = {}) {
  const { meta, title } = await loadMeta(songDir);
  const ytDir = join(songDir, "youtube");
  if (!existsSync(ytDir)) {
    await packageYouTube(songDir);
  }
  const folder = folderNameFromTitle(title);
  const dest = join(exportsRoot, folder);
  await mkdir(dest, { recursive: true });

  const finalSrc = join(songDir, "final.mp4");
  const videoName = `${folder}.mp4`;
  if (existsSync(finalSrc)) {
    await copyFile(finalSrc, join(dest, videoName));
  }

  const thumbSrc = join(ytDir, "thumbnail.jpg");
  if (existsSync(thumbSrc)) {
    await copyFile(thumbSrc, join(dest, "thumbnail.jpg"));
  }

  let ytTitle = buildYoutubeTitle(title, meta.objective);
  let description = "";
  try {
    ytTitle = stripBom(await readFile(join(ytDir, "title.txt"), "utf8")).trim();
  } catch {
    /* keep built */
  }
  try {
    description = stripBom(
      await readFile(join(ytDir, "description.txt"), "utf8"),
    ).trim();
  } catch {
    description = buildYoutubeDescription({
      title,
      objective: meta.objective,
      theme: meta.theme,
    });
  }

  await writeFile(
    join(dest, "title.txt"),
    `${ytTitle}\n\n${description}\n`,
    "utf8",
  );

  return {
    dest,
    videoPath: join(dest, videoName),
    titlePath: join(dest, "title.txt"),
    thumbnailPath: join(dest, "thumbnail.jpg"),
    title: ytTitle,
    folder,
  };
}

export { ROOT as YT_ROOT, INTRO_SEC };
