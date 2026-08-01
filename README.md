# AutoMusicVidGen v3

End-to-end **preschool music videos**: train character LoRAs ? write a song ? storyboard ? composite stills ? Wan I2V clips ? `final.mp4`.

Default interactive path is **kids-hit** (~75s home songs, dense timed beats, clip continuity, loop-fill stitch). A longer **classic** path (~180s) remains available via `--classic`.

Repo: [github.com/saeedk247365/AutoMusicVidGen_v3](https://github.com/saeedk247365/AutoMusicVidGen_v3)

---

## What you get

| Stage | Output |
|-------|--------|
| Lyrics (Ollama / Qwen) | `lyrics.txt` + title / objective |
| Song (ACE-Step) | `<slug>.mp3` |
| Plan (Qwen beats) | `scenes/actions.json` ù rooms, cast, poses, timing, continuity fields |
| Keyframes | `keyframes/*.png` ù cast cutouts composited onto empty room plates |
| Clips (Wan 2.2 I2V) | `clips/*.mp4` ù optional last-frame chain + FLF2V |
| Final | `final.mp4` ù timed concat + audio (kids-hit: loop-fill + same-room micro-crossfade) |

Interactive studio: **`npm run mvid`** ? `http://127.0.0.1:3847/`  
Approve gates between stages (or enable **Auto-approve all**).

---

## Full chain (once per character, then repeat songs)

### 0. Prerequisites

| Need | Notes |
|------|--------|
| Node.js 18+ | `node -v` |
| ComfyUI | Port **8888** ù auto-started by `mvid` / `npm run comfy` |
| Checkpoint | `realcartoon3d_v15.safetensors` in Comfy `models/checkpoints/` |
| Wan 2.2 + LightX2V | I2V models + LoRAs expected by `02_1` (see Comfy `models/`) |
| Ollama | `qwen3:14b` (`ollama pull qwen3:14b`) ù **auto-started** if down |
| ACE-Step 1.5 | Path configured in `scripts/02_0_ùjs` |
| ffmpeg / ffprobe | On `PATH` |
| rembg (Python) | Character cutouts during keyframes |
| `.env` (optional) | Salad / GPU ù copy from `.env.example` |

```powershell
npm run comfy          # start local ComfyUI if needed
npm install            # once
```

Characters: `characters/adam.json` (toddler, trigger `adamboy`) and `characters/sasha.json` (Mom helper).

---

### 1. Character dataset + LoRA (Adam, then Sasha)

```bash
# Adam
npm run generate:adam:master     # re-run until face/outfit look right
npm run generate:adam:approve    # lock master (required)
npm run generate:adam            # keyframes + training shots ? dataset/adam/
npm run train:adam               # Comfy must be up ? models/loras/

# Sasha (optional helper cast)
npm run generate:sasha:master
npm run generate:sasha:approve
npm run generate:sasha
npm run train:sasha
```

Optional flags on generate: `--ref "ù"`, `--set-master "ù"`, `--force`.  
Salad training: `npm run train:adam:salad` / `train:sasha:salad`.

**Identity rules (training plates):** chroma-green `#00FF00` only ù never bake kitchen/bedroom into the LoRA. Song plates reuse green ? rembg ? composite onto empty scenes. See [Character dataset](#character-dataset) below for remakes / FaceID / identity gate.

---

### 2. Make a music video (interactive)

```bash
npm run mvid
```

Opens the studio. Typical flow:

1. **Cast & Rooms** ù pick Adam / Sasha and which rooms are allowed  
2. Approve **setup** (or click **Start with this setup** on a fresh project)  
3. Edit **lyrics** ? Approve  
4. Listen to **song** ? Approve  
5. Review **storyline / scripts / room plates** ? Approve plan  
6. Review **keyframes** ? Approve  
7. Watch **clips** / progressive preview ? Approve  
8. **Final** ? `final.mp4`

#### Toolbar / GPU / Salad

| Control | Purpose |
|---------|---------|
| **GPU** | `Local` ù `Split` (prep local, Wan on Salad) ù `Salad Cloud` |
| **Output** | `Preview 768ù768` (default) or `YouTube 1920ù1088` |
| **Batch** | Open any `batches/<date>/<slug>` to review |
| **Continue** | Resume the open batch from the first missing stage |
| **New** | Brand-new project (does not delete old batches) |
| **Pause / Resume / Stop** | Pipeline control (Pause?change GPU?Continue resumes with new route) |
| **Auto-approve all** | Skip gates |
| **Salad Status / Start / Shutdown** | Container billing controls (`SALAD_ORG` + `SALAD_CONTAINER`) |
| **Ops** | Comfy queue, VRAM, interrupt, clear queue, full reset (clips GPU) |

With a batch already open, the primary button reads **Continue from &lt;next stage&gt;** (does **not** restart from lyrics). Use **New** only for a fresh song.

#### CLI useful with `mvid`

```bash
npm run mvid -- --count 1
npm run mvid -- --theme "rainy day indoor march"
npm run mvid -- --song batches/<date>/<slug>    # continue existing folder
npm run mvid -- --classic                       # longer classic path
npm run mvid -- --auto-approve
npm run mvid -- --port 3847
npm run mvid -- --frame-chain                   # kids-hit last-frame chain (default on)
npm run mvid -- --no-frame-chain                # force keyframe?Wan every clip
npm run mvid -- --salad                         # GPU_BACKEND=salad
```

Creates `batches/<YYYYMMDD>/<slug>/`.

---

### 3. Headless kids-hit stages

```bash
npm run mvid:lyrics -- --count 1
npm run mvid:animate -- --song batches/<date>/<slug> --force
npm run mvid:stitch -- --song batches/<date>/<slug> --force
npm run mvid:validate -- --song batches/<date>/<slug>
```

Aliases: `family:kids`, `family:kids:animate`, `family:kids:stitch`.

Continuity contract: [docs/CONTINUITY.md](docs/CONTINUITY.md)  
Golden storyboard: `batches/_templates/continuity-golden-rainy-march.json`

---

### 4. Classic path (~180s)

Fewer beats, freeze-pad stitch, no kids-hit timing / loop-fill unless you add flags.

```bash
npm run mvid -- --classic
# or
npm run mvid:classic
npm run family
npm run family:animate -- --song batches/<date>/<slug>
npm run family:stitch -- --song batches/<date>/<slug>
```

---

## Pipeline diagram

```
characters/*.json + LoRAs
        ?
        ?
  Setup (cast + rooms + theme/title/objective)
        ?
        ?
  02_0  lyrics (Ollama) ? ACE mp3 ? Qwen beats ? room plates ? rembg ? keyframes
        ?                 GUI gates: lyrics ù song ù plan ù keyframes
        ?
  02_1  Wan 2.2 I2V per keyframe
        ?     kids-hit: last-frame chain (default), blend seed, FLF2V end_image,
        ?               overlap-trim first ~3 frames on chained clips
        ?
  02_2  stitch + song audio ? final.mp4
              kids-hit: timed segments + loop-fill + same-room micro-crossfade
```

---

## Kids-hit continuity (current behavior)

Designed so clips **continue** instead of resetting to a static still every beat:

| Feature | Behavior |
|---------|----------|
| **Last-frame chain** | Same room ? seed Wan from previous clip end (default on; `--no-frame-chain` off) |
| **Blend seed** | Mix end-frame + next keyframe (~82/18; ~55/45 on cast change) |
| **FLF2V** | Optional `end_image` = this beatùs keyframe (`--no-flf` to disable) |
| **Overlap trim** | Drop first ~3 frames on chained clips (`--no-overlap-trim`) |
| **Stable cast blocks** | Mom stays 3ù4 consecutive same-room beats (less flicker) |
| **Plate lock** | One cover-crop per room per song; only cutouts change |
| **Fewer / longer beats** | Target ~12ù16 beats |
| **Stitch xfade** | ~0.2s crossfade between same-room clips (`--no-crossfade`) |

Keyframe gallery still shows different storyboards per beat ù that is expected. Video seeding uses chain/blend so motion should not hard-cut to each still in the same room.

---

## Output layout

```
batches/<date>/<slug>/
  lyrics.txt
  <slug>.mp3
  kids-hit-meta.json              # kids-hit
  mvid-session.json               # UI session / setup
  scenes/
    actions.json                  # beat plan
    <location>.png                # room copies
    _locked_<location>.png        # shared plate lock
  keyframes/
    NN_<beatId>.png
    plates/  cutouts/
  clips/
    NN_<beatId>.mp4
    _continuity/<stem>_end.png    # chain end-frames
    manifest.json
  preview.mp4                     # progressive preview while animating
  final.mp4
  final_manifest.json
```

Shared empty rooms live under repo `scenes/` (`home`, `kitchen`, `dining_room`, `doorway`, `hallway`, ù).

---

## Environment (Salad / GPU)

Copy `.env.example` ? `.env` (never commit `.env`):

```env
SALAD_API_KEY=
SALAD_COMFY_URL=https://ù.salad.cloud
SALAD_ORG=                    # portal org slug (needed for Start/Shutdown + instance CPU%)
SALAD_PROJECT=default
SALAD_CONTAINER=amvg-comfyui
GPU_BACKEND=split             # local | salad | split
```

| Backend | Behavior |
|---------|----------|
| `local` | All Comfy on PC |
| `salad` | All Comfy on Salad |
| `split` | Lyrics/stills/local prep on PC; Wan clips on Salad |

```bash
npm run salad:deploy          # create/update container group
npm run salad:status
npm run mvid:salad-test
```

**Ops panel** talks to the **clips** Comfy URL (Salad when split/salad). CPU% needs org + container instance API; VRAM comes from Comfy `/system_stats` even without `SALAD_ORG`.

Ollama URL default: `http://127.0.0.1:11434` (`OLLAMA_URL` / `OLLAMA_BIN` overrides). Lyrics stage auto-runs `ollama serve` if the API is down.

---

## Regen / remake

```bash
# Replan beats from lyrics, regen keyframes
node scripts/02_0_generate-lyrics+song+scene+keyframes.js --kids-hit \
  --song batches/<date>/<slug> --keyframes-only --replan --theme "ù"

# Layout-only (reuse cutouts)
node scripts/02_0_generate-lyrics+song+scene+keyframes.js --kids-hit \
  --song batches/<date>/<slug> --keyframes-only --force --reuse-cutouts

# Remake specific keyframes / clips from the UI, or:
node scripts/02_1_animate-keyframes.js --kids-hit \
  --song batches/<date>/<slug> --force --only 01_intro,03_verse_1
```

Then Continue the batch in the UI, or stitch:

```bash
npm run mvid:stitch -- --song batches/<date>/<slug> --force
```

---

## Characters

```
characters/
  adam.json       # toddler lead (LoRA trigger adamboy)
  sasha.json      # optional Mom helper
  adam/  sasha/   # generated stills only
```

One JSON per character. Cast selection is per-project in the Setup tab (`--cast adam,sasha`).

---

## Character dataset

Master must be **generated and approved** before keyframes/shots.

### Identity locks

- **Chroma-green backgrounds only** for master / keyframes / shots  
- Song plates: green ? cut ? composite onto empty scenes  
- **FaceID** on rebuilds / denoise 0.65  
- **Identity gate** vs master (`--identity-threshold`, `--identity-retries`, `--skip-identity-gate`)  
- Keyframe refresh off by default (`--keyframe-refresh` to enable)

### Remake one pose / shot

```bash
# Shots only
node scripts/generate-dataset.js --character characters/adam.json --out dataset/adam \
  --shots-only --only 04_sitting,05_crawling --force

# Missing keyframes only
node scripts/generate-dataset.js --character characters/adam.json --out dataset/adam \
  --keyframes-only
```

Donùt bare `--force` the full generator unless you intend to touch master/approval.

### Train

```bash
npm run train:adam
# node scripts/train-lora.js --train-config train-config-adam.json --character characters/adam.json
```

Weights ? ComfyUI `models/loras/`. Set `loraName` in the character JSON if the filename differs.

---

## Base checkpoint

Default: `realcartoon3d_v15.safetensors` (SD1.5 cartoon).  
Place under ComfyUI `models/checkpoints/`. SDXL paths are not wired yet.

---

## Known gaps (camera & music)

**Shipped in kids-hit now:** crop-based shot cards (different positions in the room), camera-end stills for Wan FLF, BPM `music-map.json` + snapped cut times, musical crossfade length.

**Still imperfect:** real onset detection (vs BPM grid), richer furniture anchors, UI editors for shot size, and stronger Wan motion on 4-step LightX2V.

---

## Docs & validation

| Doc / command | Purpose |
|---------------|---------|
| [docs/CONTINUITY.md](docs/CONTINUITY.md) | Living-story + frame-chain contract |
| `npm run mvid:validate -- --song ù` | Dry-run continuity repair / check |
| `batches/_templates/continuity-golden-rainy-march.json` | Golden storyboard |

---

## Quick reference

```bash
npm run mvid                          # interactive kids-hit studio
npm run mvid -- --classic             # classic long songs
npm run mvid:lyrics -- --count 1
npm run mvid:animate -- --song ù --force
npm run mvid:stitch -- --song ù --force
npm run generate:adam && npm run train:adam
npm run comfy
```
