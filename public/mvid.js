(() => {
  const state = { ...(window.__MVID_INITIAL__ || {}) };
  const $ = (id) => document.getElementById(id);

  const statusMsg = $("statusMsg");
  const stagePill = $("stagePill");
  const autoApprove = $("autoApprove");
  const btnApprove = $("btnApprove");
  const btnReject = $("btnReject");
  const lyricsText = $("lyricsText");
  const planRaw = $("planRaw");
  const logEl = $("log");

  const TAB_TO_GATE = {
    setup: "setup",
    lyrics: "lyrics",
    song: "song",
    storyline: "plan",
    scenes: "plan",
    scripts: "plan",
    keyframes: "keyframes",
    clips: "clips",
    final: "final",
  };

  let activeTab = "setup";
  let setupLoaded = false;
  let setupScenesCache = [];
  let setupSaveTimer = null;

  function log(msg, { t = Date.now(), skipStore = false } = {}) {
    const line = document.createElement("div");
    line.className = "line";
    const stamp = new Date(t).toLocaleTimeString();
    line.textContent = `[${stamp}] ${msg}`;
    line.dataset.t = String(t);
    line.dataset.msg = String(msg);
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    if (!skipStore) persistLogs();
  }

  function persistLogs() {
    try {
      const lines = [...logEl.querySelectorAll(".line")].map((el) => ({
        t: Number(el.dataset.t) || Date.now(),
        message: el.dataset.msg || el.textContent.replace(/^\[[^\]]+\]\s*/, ""),
      }));
      sessionStorage.setItem("mvid-logs", JSON.stringify(lines.slice(-400)));
    } catch {
      /* ignore */
    }
  }

  function restoreLogsFromSession() {
    try {
      const raw = sessionStorage.getItem("mvid-logs");
      if (!raw) return;
      const lines = JSON.parse(raw);
      if (!Array.isArray(lines) || !lines.length) return;
      logEl.innerHTML = "";
      for (const row of lines) {
        if (row?.message) log(row.message, { t: row.t || Date.now(), skipStore: true });
      }
    } catch {
      /* ignore */
    }
  }

  function applyLogHistory(lines) {
    if (!Array.isArray(lines) || !lines.length) return;
    const byKey = new Map();
    for (const el of [...logEl.querySelectorAll(".line")]) {
      const message = el.dataset.msg || "";
      if (!message) continue;
      const t = Number(el.dataset.t) || Date.now();
      byKey.set(`${t}|${message}`, { t, message });
    }
    for (const row of lines) {
      if (!row?.message) continue;
      const t = row.t || Date.now();
      byKey.set(`${t}|${row.message}`, { t, message: row.message });
    }
    const merged = [...byKey.values()].sort((a, b) => a.t - b.t).slice(-400);
    logEl.innerHTML = "";
    for (const row of merged) {
      log(row.message, { t: row.t, skipStore: true });
    }
    persistLogs();
  }

  function waitingGate() {
    if (!state.stage?.startsWith("await_")) return null;
    return state.stage.replace(/^await_/, "");
  }

  function collectSetupPayload() {
    const castIds = [...document.querySelectorAll("#castList input[type=checkbox]:checked")].map(
      (el) => el.value,
    );
    const locationIds = [
      ...document.querySelectorAll("#setupScenesList .room-card.is-on"),
    ].map((el) => el.dataset.id);
    return {
      castIds,
      locationIds,
      locationsExplicit: true,
      roomsLockedByUser: !!state.setup?.roomsLockedByUser,
      title: $("setupTitle")?.value?.trim() || "",
      objective: $("setupObjective")?.value?.trim() || "",
      theme: $("setupTheme")?.value?.trim() || "",
    };
  }

  function updateRoomsCount() {
    const el = $("roomsCount");
    if (!el) return;
    const on = document.querySelectorAll("#setupScenesList .room-card.is-on").length;
    const total = document.querySelectorAll("#setupScenesList .room-card").length;
    el.textContent = total ? `${on} / ${total} selected` : "";
  }

  function renderRoomCards(scenes, selectedIds, { explicit }) {
    const locEl = $("setupScenesList");
    if (!locEl) return;
    const sel = new Set(selectedIds || []);
    locEl.className = "room-grid";
    locEl.innerHTML = (scenes || [])
      .map((s) => {
        const on = explicit ? sel.has(s.id) : true;
        return `<button type="button" class="room-card ${on ? "is-on" : "is-off"}" data-id="${esc(s.id)}" aria-pressed="${on}">
          ${
            s.thumbUrl
              ? `<img src="${esc(s.thumbUrl)}" alt="" loading="lazy" />`
              : `<div class="room-ph">No preview</div>`
          }
          <span class="room-meta">
            <span class="room-name">${esc(s.name || s.id)}</span>
            <span class="room-mark" aria-hidden="true">✓</span>
          </span>
        </button>`;
      })
      .join("");
    updateRoomsCount();
  }

  function scheduleSetupSave() {
    clearTimeout(setupSaveTimer);
    setupSaveTimer = setTimeout(() => {
      persistSetupDraft();
    }, 250);
  }

  async function persistSetupDraft() {
    const payload = collectSetupPayload();
    if (!payload.castIds.length) {
      // Keep previous cast if user briefly unchecked everyone while toggling
      payload.castIds = state.setup?.castIds?.length
        ? state.setup.castIds
        : ["adam", "sasha"];
    }
    state.setup = { ...(state.setup || {}), ...payload };
    try {
      localStorage.setItem("mvid-setup-draft", JSON.stringify(payload));
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok && data.setup) state.setup = data.setup;
      else if (!data.ok) log(`Setup save failed: ${data.error || res.status}`);
    } catch (err) {
      log(`Setup save failed: ${err.message || err}`);
    }
  }

  function readLocalSetupDraft() {
    try {
      const raw = localStorage.getItem("mvid-setup-draft");
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async function loadSetupLists() {
    if (setupLoaded) return;
    try {
      const [charsRes, scenesRes] = await Promise.all([
        fetch("/api/characters"),
        fetch("/api/scenes"),
      ]);
      const chars = await charsRes.json();
      const scenes = await scenesRes.json();
      setupScenesCache = scenes.ok ? scenes.scenes || [] : [];

      // Prefer server setup; fall back to localStorage draft
      const localDraft = readLocalSetupDraft();
      if (
        localDraft?.locationsExplicit &&
        (!state.setup?.locationsExplicit ||
          !(state.setup?.locationIds?.length || state.setup?.locationsExplicit))
      ) {
        state.setup = { ...(state.setup || {}), ...localDraft };
      }

      const castEl = $("castList");
      const selected = new Set(state.setup?.castIds || ["adam", "sasha"]);
      if (chars.ok) {
        castEl.className = "cast-grid";
        castEl.innerHTML = (chars.characters || [])
          .map((c) => {
            const on = selected.has(c.id);
            const badge = c.masterApproved
              ? "master ✓"
              : c.hasMaster
                ? "master ?"
                : c.hasLora
                  ? "LoRA"
                  : c.role || "";
            const initial = esc((c.name || c.id || "?").charAt(0).toUpperCase());
            return `<label class="cast-card ${on ? "is-on" : ""}">
              <input type="checkbox" value="${esc(c.id)}" ${on ? "checked" : ""} />
              <span class="cast-avatar" aria-hidden="true">${initial}</span>
              <span class="cast-info">
                <span class="cast-name">${esc(c.name)}</span>
                <div class="cast-meta">${esc(badge)}</div>
                <div class="cast-blurb">${esc((c.appearance || "").slice(0, 80))}</div>
              </span>
            </label>`;
          })
          .join("");
        castEl.onchange = (ev) => {
          const card = ev.target.closest?.(".cast-card");
          if (card && ev.target.matches?.("input[type=checkbox]")) {
            card.classList.toggle("is-on", ev.target.checked);
          }
          scheduleSetupSave();
        };
        fillStudioSelect(chars.characters || []);
      }

      const explicit = state.setup?.locationsExplicit === true;
      const locIds = explicit
        ? state.setup?.locationIds || []
        : setupScenesCache.map((s) => s.id);
      renderRoomCards(setupScenesCache, locIds, { explicit: true });

      // First paint with defaults → persist so refresh keeps the choice
      if (!explicit) {
        state.setup = {
          ...(state.setup || {}),
          locationIds: locIds,
          locationsExplicit: true,
          castIds: [...selected],
        };
        scheduleSetupSave();
      }

      applyBriefToForm(state.setup);
      for (const id of ["setupTitle", "setupObjective", "setupTheme"]) {
        $(id)?.addEventListener("change", () => scheduleSetupSave());
        $(id)?.addEventListener("blur", () => scheduleSetupSave());
      }
      setupLoaded = true;
    } catch (err) {
      log(`Setup load failed: ${err.message || err}`);
    }
  }

  function applyBriefToForm(brief) {
    if (!brief) return;
    if (brief.title != null && $("setupTitle")) $("setupTitle").value = brief.title;
    if (brief.objective != null && $("setupObjective"))
      $("setupObjective").value = brief.objective;
    if (brief.theme != null && $("setupTheme")) $("setupTheme").value = brief.theme;
    // Auto rooms from brief unless the user locked room picks
    if (
      Array.isArray(brief.locationIds) &&
      brief.locationIds.length &&
      !state.setup?.roomsLockedByUser &&
      setupScenesCache.length
    ) {
      state.setup = {
        ...(state.setup || {}),
        locationIds: brief.locationIds,
        locationsExplicit: true,
        roomsLockedByUser: false,
      };
      renderRoomCards(setupScenesCache, brief.locationIds, { explicit: true });
    }
  }

  function canStartFromSetup() {
    return (
      !state.running &&
      !state.paused &&
      state.stage !== "stopped" &&
      !waitingGate() &&
      (state.viewOnly ||
        state.stage === "idle" ||
        state.stage === "done" ||
        state.stage === "error" ||
        !state.stage)
    );
  }

  /** Open batch with progress → Continue; empty/new → Start new project. */
  function hasOpenSongProgress() {
    return !!(
      state.songDir &&
      (state.progress?.furthestTab ||
        state.tabs?.lyrics?.text ||
        state.tabs?.keyframes?.images?.length ||
        state.tabs?.song?.url)
    );
  }

  function idlePrimaryAction() {
    if (!canStartFromSetup()) return null;
    if (hasOpenSongProgress()) {
      const next = state.progress?.nextLabel || state.progress?.furthestLabel;
      return {
        kind: "continue",
        label: next ? `Continue from ${next}` : "Continue pipeline",
      };
    }
    return { kind: "new", label: "Start with this setup" };
  }

  function updateButtons() {
    const gate = waitingGate();
    const paused = !!state.paused;
    const stopped = !!state.stopped || state.stage === "stopped";
    const startReady = canStartFromSetup();
    const idleAction = idlePrimaryAction();
    // Waiting on a gate, OR idle/view-only first step → Approve starts/continues
    const enabled = (!!gate && !paused && !stopped) || startReady;
    btnApprove.disabled = !enabled;
    btnReject.disabled = !gate || !enabled || gate === "final" || gate === "setup";
    if (gate === "final") btnReject.disabled = !enabled;
    if (gate === "setup") {
      btnApprove.disabled = !enabled;
      btnReject.disabled = true;
    }
    btnApprove.textContent = idleAction
      ? idleAction.label
      : "Approve & continue";
    const btnPause = $("btnPause");
    const btnResume = $("btnResume");
    const btnStop = $("btnStop");
    const btnContinue = $("btnContinue");
    const btnNewProject = $("btnNewProject");
    if (btnPause) btnPause.disabled = paused || stopped || state.stage === "done" || !!state.viewOnly;
    if (btnResume) btnResume.disabled = !paused || stopped;
    if (btnStop) btnStop.disabled = stopped || state.stage === "done" || !!state.viewOnly;
    if (btnContinue) {
      // Allow Continue while paused so Pause → change GPU → Continue resumes with new route
      btnContinue.disabled =
        (!!state.running && !state.paused) || !state.songDir || stopped;
    }
    if (btnNewProject) {
      // Allow New while waiting on setup (reshuffles brief)
      btnNewProject.disabled =
        !!state.running && state.stage !== "await_setup";
      btnNewProject.title =
        state.stage === "await_setup"
          ? "Generate another title / theme / objective"
          : "Start a brand-new project with a fresh brief";
    }
  }

  async function refreshSaladStatus() {
    const pill = $("saladStatusPill");
    if (!pill) return;
    try {
      const res = await fetch("/api/salad/status");
      const data = await res.json();
      state.salad = data;
      if (!data.configured) {
        pill.textContent = "Salad: set SALAD_ORG";
        pill.className = "salad-pill warn";
        return;
      }
      if (!data.ok) {
        pill.textContent = `Salad: ${data.error || "error"}`.slice(0, 48);
        pill.className = "salad-pill err";
        return;
      }
      const g = data.group;
      if (g) {
        const st = g.currentState?.status || g.currentState || "?";
        const run = g.running != null ? ` · ${g.running} run` : "";
        pill.textContent = `Salad: ${st}${run}`;
        pill.className = /stop|fail/i.test(String(st))
          ? "salad-pill warn"
          : "salad-pill ok";
      } else if (data.groups) {
        pill.textContent = `Salad: ${data.groups.length} group(s)`;
        pill.className = "salad-pill ok";
      } else {
        pill.textContent = "Salad: ok";
        pill.className = "salad-pill ok";
      }
    } catch (err) {
      pill.textContent = "Salad: unreachable";
      pill.className = "salad-pill err";
      log(`Salad status: ${err.message || err}`);
    }
  }

  function fmtPct(n) {
    return n == null || !Number.isFinite(Number(n)) ? "—" : `${Math.round(Number(n))}%`;
  }

  function setMeter(scopeEl, key, percent, label) {
    const meter = scopeEl?.querySelector(`.meter[data-key="${key}"]`);
    if (!meter) return;
    const bar = meter.querySelector(".meter-bar");
    const txt = meter.querySelector(".meter-txt");
    const pct = percent == null || !Number.isFinite(Number(percent)) ? null : Number(percent);
    if (bar) bar.style.width = pct == null ? "0%" : `${Math.max(0, Math.min(100, pct))}%`;
    if (txt) txt.textContent = label;
    meter.classList.toggle("hot", pct != null && pct >= 85);
    meter.title = label;
  }

  function renderResourceMeters(data) {
    const root = $("resourceMeters");
    if (!root || !data) return;
    const localGroup = root.querySelector('[data-scope="local"]');
    const saladGroup = root.querySelector('[data-scope="salad"]');
    const local = data.local || {};
    const salad = data.salad || {};

    setMeter(
      localGroup,
      "cpu",
      local.cpuPercent,
      `CPU ${fmtPct(local.cpuPercent)}`,
    );
    setMeter(
      localGroup,
      "ram",
      local.ramPercent,
      `RAM ${fmtPct(local.ramPercent)}`,
    );
    const localGpuLabel =
      local.gpuPercent == null && local.gpuVramPercent == null
        ? "GPU —"
        : `GPU ${fmtPct(local.gpuPercent)}${
            local.gpuVramPercent != null ? ` · VRAM ${fmtPct(local.gpuVramPercent)}` : ""
          }`;
    setMeter(
      localGroup,
      "gpu",
      local.gpuPercent ?? local.gpuVramPercent,
      localGpuLabel,
    );
    if (localGroup) {
      localGroup.title = local.gpuName
        ? `Local · ${local.gpuName}`
        : "Local machine";
    }

    const saladLive = !!(salad.available || salad.comfyUp);
    const saladDown = !!(salad.configured && !saladLive);
    const downLabel =
      salad.httpStatus === 503
        ? "Comfy 503"
        : salad.httpStatus
          ? `HTTP ${salad.httpStatus}`
          : "Comfy down";
    if (saladGroup) {
      saladGroup.classList.toggle("dim", !saladLive);
      const tipParts = [
        salad.gpuName ? salad.gpuName : null,
        salad.note || null,
        saladDown ? downLabel : null,
      ].filter(Boolean);
      saladGroup.title = tipParts.length
        ? `Salad · ${tipParts.join(" · ")}`
        : "Salad Cloud";
    }
    setMeter(
      saladGroup,
      "cpu",
      salad.cpuPercent,
      salad.cpuPercent != null
        ? `CPU ${fmtPct(salad.cpuPercent)}`
        : saladLive
          ? salad.mgmtConfigured
            ? "CPU —"
            : "CPU n/a"
          : saladDown
            ? `CPU · ${downLabel}`
            : "CPU —",
    );
    setMeter(
      saladGroup,
      "ram",
      salad.ramPercent,
      salad.ramPercent != null
        ? `RAM ${fmtPct(salad.ramPercent)}`
        : saladLive
          ? "RAM …"
          : saladDown
            ? `RAM · ${downLabel}`
            : "RAM —",
    );
    const saladGpuLabel =
      salad.gpuPercent != null
        ? `GPU ${fmtPct(salad.gpuPercent)}${
            salad.gpuVramPercent != null ? ` · VRAM ${fmtPct(salad.gpuVramPercent)}` : ""
          }`
        : salad.gpuVramPercent != null
          ? `VRAM ${fmtPct(salad.gpuVramPercent)}`
          : saladLive
            ? "GPU …"
            : saladDown
              ? `GPU · ${downLabel}`
              : "GPU —";
    setMeter(
      saladGroup,
      "gpu",
      salad.gpuPercent ?? salad.gpuVramPercent,
      saladGpuLabel,
    );
  }

  async function refreshMetrics() {
    try {
      const res = await fetch("/api/metrics");
      const data = await res.json();
      if (!data.ok) return;
      state.metrics = data;
      renderResourceMeters(data);
    } catch {
      /* ignore transient poll errors */
    }
  }

  function selectTab(name) {
    activeTab = name;
    document.querySelectorAll(".tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    document.querySelectorAll(".pane").forEach((p) => {
      p.classList.toggle("active", p.id === `pane-${name}`);
    });
  }

  function markTabData(tabs, progress = state.progress) {
    const stepMap = new Map((progress?.steps || []).map((s) => [s.tab, s]));
    const furthest = progress?.furthestTab || null;
    document.querySelectorAll(".tabs button").forEach((b) => {
      const key = b.dataset.tab;
      const step = stepMap.get(key);
      // Only green when this project's progress says the stage finished —
      // never from leftover tab payload after New.
      const done = !!step?.done;
      b.classList.toggle("has-data", done);
      b.classList.toggle("at-progress", key === furthest);
      b.title = done
        ? key === furthest
          ? progress?.complete
            ? "Complete"
            : `Furthest stage: ${progress?.furthestLabel || key}`
          : "Stage complete"
        : "Not reached yet";
    });
    const rail = $("progressRail");
    if (rail && progress?.steps?.length) {
      rail.hidden = false;
      rail.innerHTML = progress.steps
        .map((s) => {
          const cls = [
            "progress-step",
            s.done ? "is-done" : "",
            s.current ? "is-current" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return `<span class="${cls}" data-tab="${esc(s.tab)}" title="${esc(s.label)}">${esc(s.label)}</span>`;
        })
        .join("");
    } else if (rail) {
      rail.hidden = true;
      rail.innerHTML = "";
    }
  }

  function furthestTabFromTabs(tabs) {
    if (tabs?.final?.url) return "final";
    if (tabs?.clips?.videos?.length) return "clips";
    if (tabs?.keyframes?.images?.length) return "keyframes";
    if (tabs?.scripts?.beats?.length) return "scripts";
    if (tabs?.scenes?.locations?.length) return "scenes";
    if (tabs?.storyline?.beats?.length) return "storyline";
    if (tabs?.song?.url) return "song";
    if (tabs?.lyrics?.text) return "lyrics";
    return "setup";
  }

  function jumpToSongProgress(progress, tabs) {
    const tab =
      progress?.furthestTab || furthestTabFromTabs(tabs || state.tabs);
    if (tab) selectTab(tab);
  }

  function renderLyrics(tabs, { force = false } = {}) {
    if (tabs?.lyrics?.text != null) {
      if (
        force ||
        document.activeElement !== lyricsText ||
        !lyricsText.value ||
        waitingGate() === "lyrics"
      ) {
        if (force || document.activeElement !== lyricsText) {
          lyricsText.value = tabs.lyrics.text;
          lyricsText.dataset.touched = "";
        } else if (!lyricsText.dataset.touched) {
          lyricsText.value = tabs.lyrics.text;
        }
      }
    } else if (force) {
      lyricsText.value = "";
      lyricsText.dataset.touched = "";
    }
  }

  function renderSong(tabs) {
    const el = $("songPlayer");
    if (!tabs?.song?.url) {
      el.className = "empty";
      el.textContent = "No audio yet";
      return;
    }
    el.className = "";
    el.innerHTML = `<p>${tabs.song.name}</p><audio controls src="${tabs.song.url}?t=${Date.now()}"></audio>`;
  }

  function renderStoryline(tabs, { force = false } = {}) {
    const el = $("storylineView");
    const s = tabs?.storyline;
    if (!s) {
      el.className = "empty";
      el.textContent = "No storyline yet";
      if (force || document.activeElement !== planRaw) planRaw.value = "";
      return;
    }
    el.className = "";
    const rows = (s.beats || [])
      .map(
        (b) => `<tr>
        <td>${esc(b.id)}</td>
        <td>${esc(b.storyBeat || "")}</td>
        <td>${esc(b.location || "")}</td>
        <td>${esc(b.cause || "")}</td>
        <td>${esc(b.effect || "")}</td>
        <td>${b.startSec ?? ""}–${b.endSec ?? ""}</td>
      </tr>`,
      )
      .join("");
    el.innerHTML = `
      <div class="objective"><strong>Objective:</strong> ${esc(s.objective || "(none)")}
        ${s.theme ? `<div class="meta">theme: ${esc(s.theme)}</div>` : ""}
      </div>
      <table class="beat-table">
        <thead><tr><th>Beat</th><th>Arc</th><th>Room</th><th>Cause</th><th>Effect</th><th>Time</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    if (force || document.activeElement !== planRaw) {
      planRaw.value = s.raw || "";
    }
  }

  function renderScenes(tabs) {
    const el = $("scenesGrid");
    const locs = tabs?.scenes?.locations || [];
    if (!locs.length) {
      el.className = "grid empty";
      el.textContent = "No scenes yet";
      return;
    }
    el.className = "grid";
    el.innerHTML = locs
      .map(
        (l) => `<div class="card">
        ${l.url ? `<img src="${l.url}?t=${Date.now()}" alt="${esc(l.id)}" />` : `<div class="empty">missing</div>`}
        <div class="cap">${esc(l.id)} · ${esc((l.beats || []).join(", "))}</div>
      </div>`,
      )
      .join("");
  }

  function optionList(values, selected) {
    return values
      .map(
        (v) =>
          `<option value="${esc(v)}" ${v === selected ? "selected" : ""}>${esc(v)}</option>`,
      )
      .join("");
  }

  const SCRIPT_POSES = [
    "stand",
    "sit",
    "kneel",
    "wave",
    "point",
    "hands_up",
    "walk",
    "stomp",
    "clap",
    "wash",
    "stretch",
    "tiptoe",
    "dance",
  ];
  const SCRIPT_EXPR = [
    "happy",
    "curious",
    "surprised",
    "excited",
    "proud",
    "worried",
    "determined",
  ];
  const SCRIPT_FACING = ["front", "three_quarter", "profile", "back"];
  const SCRIPT_STORY = ["problem", "discovery", "fun", "celebration"];
  const SCRIPT_CAM = [
    "full_body",
    "medium_full",
    "medium",
    "close_up",
    "wide",
  ];

  function collectScriptEdits() {
    const cards = [...document.querySelectorAll("#scriptsView .shot-card")];
    return cards.map((card) => {
      const id = card.dataset.beatId;
      const val = (sel) => card.querySelector(sel)?.value ?? "";
      const chars = [...card.querySelectorAll(".shot-char")].map((row) => ({
        name: row.dataset.name || row.querySelector("[data-f=name]")?.value || "",
        pose: row.querySelector("[data-f=pose]")?.value || "stand",
        expression: row.querySelector("[data-f=expression]")?.value || "happy",
        facing: row.querySelector("[data-f=facing]")?.value || "front",
      }));
      return {
        id,
        lyricHint: val("[data-f=lyricHint]"),
        cause: val("[data-f=cause]"),
        effect: val("[data-f=effect]"),
        interaction: val("[data-f=interaction]"),
        cutMotivation: val("[data-f=cutMotivation]"),
        actionPhase: val("[data-f=actionPhase]"),
        storyBeat: val("[data-f=storyBeat]"),
        location: val("[data-f=location]"),
        camera: val("[data-f=camera]"),
        characters: chars,
      };
    });
  }

  /** beatId → { at, keyframeMtime, animate } for "Just remade" badges */
  const remadeFlash = new Map();
  let remakingBeatId = null;

  function markRemade(payload) {
    const at = payload?.at || Date.now();
    for (const item of payload?.remade || []) {
      const id = item.beatId;
      if (!id) continue;
      remadeFlash.set(id, {
        at,
        keyframeMtime: item.keyframeMtime || at,
        animate: !!payload.animate,
      });
    }
    for (const id of payload?.only || []) {
      if (!remadeFlash.has(id)) {
        remadeFlash.set(id, { at, keyframeMtime: at, animate: !!payload.animate });
      }
    }
    // Expire badges after 2 minutes
    setTimeout(() => {
      for (const [id, meta] of remadeFlash) {
        if (meta.at === at) remadeFlash.delete(id);
      }
    }, 120000);
  }

  function isJustRemade(beatId) {
    return remadeFlash.has(beatId);
  }

  function renderScripts(tabs) {
    const el = $("scriptsView");
    const beats = tabs?.scripts?.beats || [];
    if (!beats.length) {
      el.className = "empty";
      el.textContent = "No scripts yet";
      return;
    }
    // Don't wipe in-progress edits
    if (el.contains(document.activeElement)) return;

    const locs = tabs?.scripts?.locations?.length
      ? tabs.scripts.locations
      : [...new Set(beats.map((b) => b.location).filter(Boolean))];

    el.className = "shot-list";
    el.innerHTML = beats
      .map((b) => {
        const chars = (b.characters || []).length
          ? b.characters
          : [{ name: "Adam", pose: "stand", expression: "happy", facing: "front" }];
        const charHtml = chars
          .map(
            (c) => `<div class="shot-char" data-name="${esc(c.name)}">
            <span class="shot-char-name">${esc(c.name)}</span>
            <label>Pose <select data-f="pose">${optionList(SCRIPT_POSES, c.pose || "stand")}</select></label>
            <label>Face <select data-f="expression">${optionList(SCRIPT_EXPR, c.expression || "happy")}</select></label>
            <label>Facing <select data-f="facing">${optionList(SCRIPT_FACING, c.facing || "front")}</select></label>
          </div>`,
          )
          .join("");
        const t0 = b.startSec != null ? Number(b.startSec).toFixed(1) : "?";
        const t1 = b.endSec != null ? Number(b.endSec).toFixed(1) : "?";
        return `<article class="shot-card" data-beat-id="${esc(b.id)}" data-stem="${esc(b.keyframeStem || "")}">
          <header class="shot-head">
            <div>
              <h4>Shot ${esc(String(b.index || ""))}: ${esc(b.id)}</h4>
              <p class="meta">${esc(b.section || "")} · ${t0}s–${t1}s · file ${esc(b.keyframeStem || "")}.png</p>
            </div>
            <div class="shot-actions">
              ${isJustRemade(b.id) ? `<span class="remade-badge inline">Just remade</span>` : ""}
              <button type="button" class="btn tiny" data-act="goto-kf" data-beat="${esc(b.id)}">View still</button>
              <button type="button" class="btn tiny primary" data-act="remake" data-beat="${esc(b.id)}"${remakingBeatId === b.id ? " disabled" : ""}>${remakingBeatId === b.id ? "Remaking…" : "Remake still"}</button>
              <button type="button" class="btn tiny" data-act="remake-clip" data-beat="${esc(b.id)}"${remakingBeatId === b.id ? " disabled" : ""}>Remake still+clip</button>
            </div>
          </header>
          <p class="shot-plain">This shot is a frozen picture of what happens on this lyric line. Change the fields, then remake the still.</p>
          <div class="shot-grid">
            <label class="field wide">Lyric line (what kids hear)
              <input data-f="lyricHint" value="${esc(b.lyricHint || "")}" />
            </label>
            <label class="field">What just happened (cause)
              <input data-f="cause" value="${esc(b.cause || "")}" />
            </label>
            <label class="field">What this shot shows (effect)
              <input data-f="effect" value="${esc(b.effect || "")}" />
            </label>
            <label class="field wide">Action on screen (plain English)
              <input data-f="interaction" value="${esc(b.interaction || "")}" />
            </label>
            <label class="field">Room
              <select data-f="location">${optionList(locs.length ? locs : [b.location || "home"], b.location || "")}</select>
            </label>
            <label class="field">Story beat
              <select data-f="storyBeat">${optionList(SCRIPT_STORY, b.storyBeat || "fun")}</select>
            </label>
            <label class="field">Camera
              <select data-f="camera">${optionList(SCRIPT_CAM, b.camera || "full_body")}</select>
            </label>
            <label class="field">Why we cut here
              <input data-f="cutMotivation" value="${esc(b.cutMotivation || "")}" />
            </label>
            <label class="field">Action phase
              <input data-f="actionPhase" value="${esc(b.actionPhase || "")}" />
            </label>
          </div>
          <div class="shot-cast">
            <h5>Who is in the shot</h5>
            ${charHtml}
          </div>
        </article>`;
      })
      .join("");
  }

  function renderKeyframes(tabs) {
    const el = $("keyframesGrid");
    const images = tabs?.keyframes?.images || [];
    if (!images.length) {
      el.className = "grid empty";
      el.textContent = "No keyframes yet";
      return;
    }
    el.className = "grid";
    el.innerHTML = images
      .map((img) => {
        const bust = img.mtime || Date.now();
        const just = isJustRemade(img.beatId);
        const busy = remakingBeatId === img.beatId;
        return `<div class="card kf-card${just ? " just-remade" : ""}${busy ? " remaking" : ""}" data-beat="${esc(img.beatId || "")}">
        ${just ? `<span class="remade-badge">Just remade</span>` : ""}
        <img src="${img.url}?t=${bust}" alt="${esc(img.name)}" />
        <div class="cap">${esc(img.name)}${img.mtime ? ` · ${new Date(img.mtime).toLocaleTimeString()}` : ""}</div>
        <div class="kf-actions">
          <button type="button" class="btn tiny" data-act="edit-script" data-beat="${esc(img.beatId || "")}">Edit script</button>
          <button type="button" class="btn tiny primary" data-act="remake" data-beat="${esc(img.beatId || "")}"${busy ? " disabled" : ""}>${busy ? "Remaking…" : "Remake"}</button>
        </div>
      </div>`;
      })
      .join("");
  }

  function renderClips(tabs) {
    const previewEl = $("previewPlayer");
    if (previewEl) {
      const preview = tabs?.preview;
      if (!preview?.url) {
        previewEl.className = "empty";
        previewEl.textContent = "Preview will appear after the first clip…";
      } else {
        const mtime = preview.mtime || Date.now();
        const n = preview.clips || tabs?.clips?.videos?.length || "?";
        const wasPlaying = $("previewVideo");
        const resumeAt = wasPlaying && !wasPlaying.paused ? wasPlaying.currentTime : null;
        previewEl.className = "";
        previewEl.innerHTML = `<p class="hint">Progressive preview · ${n} clip(s) + sound · playing clip highlighted below</p>
          <video id="previewVideo" controls src="${preview.url}?t=${mtime}"></video>`;
        const vid = $("previewVideo");
        if (vid && resumeAt != null) {
          vid.currentTime = resumeAt;
          vid.play().catch(() => {});
        }
        wirePreviewClipHighlight(vid, tabs);
      }
    }

    const el = $("clipsGrid");
    const videos = tabs?.clips?.videos || [];
    if (!videos.length) {
      el.className = "grid empty";
      el.textContent = "No clips yet";
      return;
    }
    el.className = "grid";
    el.innerHTML = videos
      .map((v) => {
        const bust = v.mtime || Date.now();
        const stem = v.stem || String(v.name || "").replace(/\.mp4$/i, "");
        const beatId = /^(\d+)_(.+)$/.exec(stem)?.[2] || stem;
        const dur = Number(v.durationSec) || 0;
        return `<div class="card clip-card" data-stem="${esc(stem)}" data-name="${esc(v.name)}" data-beat="${esc(beatId)}" data-duration="${dur}">
        <video controls src="${v.url}?t=${bust}"></video>
        <div class="cap">${esc(v.name)}${v.mtime ? ` · ${new Date(v.mtime).toLocaleTimeString()}` : ""}</div>
        <div class="kf-actions">
          <button type="button" class="btn tiny danger" data-act="delete-clip" data-name="${esc(v.name)}" data-stem="${esc(stem)}" data-beat="${esc(beatId)}">Delete</button>
        </div>
      </div>`;
      })
      .join("");
  }

  function wirePreviewClipHighlight(vid, tabs) {
    if (!vid) return;
    const videos = tabs?.clips?.videos || [];
    if (!videos.length) return;

    // Build cumulative timeline from clip durations when present; else equal split
    const durs = videos.map((v) => {
      const d = Number(v.durationSec);
      return d > 0 ? d : 0;
    });
    const known = durs.filter((d) => d > 0);
    const avg =
      known.length > 0
        ? known.reduce((a, b) => a + b, 0) / known.length
        : 5;
    const spans = durs.map((d) => (d > 0 ? d : avg));
    const ends = [];
    let t = 0;
    for (const s of spans) {
      t += s;
      ends.push(t);
    }

    const update = () => {
      const ct = vid.currentTime || 0;
      let idx = ends.findIndex((end) => ct < end - 0.01);
      if (idx < 0) idx = videos.length - 1;
      document.querySelectorAll("#clipsGrid .clip-card").forEach((card, i) => {
        card.classList.toggle("is-playing", i === idx);
      });
      const active = document.querySelector("#clipsGrid .clip-card.is-playing");
      if (active && !vid.paused) {
        const rect = active.getBoundingClientRect();
        const parent = $("clipsGrid");
        if (parent && (rect.top < parent.getBoundingClientRect().top || rect.bottom > parent.getBoundingClientRect().bottom + 80)) {
          active.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      }
    };

    vid.addEventListener("timeupdate", update);
    vid.addEventListener("play", update);
    vid.addEventListener("seeked", update);
    vid.addEventListener("pause", () => {
      /* keep highlight on last frame */
    });
  }

  function renderFinal(tabs) {
    const el = $("finalPlayer");
    const ytEl = $("youtubePackage");
    if (!tabs?.final?.url) {
      el.className = "empty";
      el.textContent = "No final yet";
      if (ytEl) {
        ytEl.hidden = true;
        ytEl.className = "yt-package empty";
        ytEl.innerHTML = "";
      }
      return;
    }
    el.className = "";
    el.innerHTML = `<video controls src="${tabs.final.url}?t=${Date.now()}"></video>`;
    if (!ytEl) return;
    const yt = tabs.final.youtube;
    if (!yt?.title) {
      ytEl.hidden = false;
      ytEl.className = "yt-package";
      ytEl.innerHTML = `
        <div class="yt-actions">
          <button type="button" id="btnYtPackage" class="btn">Build YouTube package</button>
          <button type="button" id="btnYtDownload" class="btn primary">Download</button>
          <span id="ytExportMsg" class="muted"></span>
        </div>`;
      wireYtButtons();
      return;
    }
    ytEl.hidden = false;
    ytEl.className = "yt-package";
    const thumb = yt.thumbnailUrl
      ? `<img class="yt-thumb" src="${yt.thumbnailUrl}?t=${Date.now()}" alt="YouTube thumbnail"/>`
      : "";
    ytEl.innerHTML = `
      <div class="yt-grid">
        ${thumb}
        <div class="yt-meta">
          <h3>YouTube</h3>
          <p class="yt-title"><strong>Title</strong><br/>${escapeHtml(yt.title)}</p>
          <p class="yt-desc"><strong>Description</strong></p>
          <pre class="yt-desc-body">${escapeHtml(yt.description || "")}</pre>
          <div class="yt-actions">
            <button type="button" id="btnYtDownload" class="btn primary">Download</button>
            <span id="ytExportMsg" class="muted"></span>
          </div>
        </div>
      </div>`;
    wireYtButtons();
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function wireYtButtons() {
    const dl = $("btnYtDownload");
    const build = $("btnYtPackage");
    const msg = $("ytExportMsg");
    if (dl && !dl._wired) {
      dl._wired = true;
      dl.addEventListener("click", async () => {
        if (msg) msg.textContent = "Exporting…";
        try {
          const r = await fetch("/api/export-youtube", { method: "POST" });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || "export failed");
          if (msg) msg.textContent = `Saved → ${j.dest}`;
          log(`Downloaded package → ${j.dest}`);
        } catch (err) {
          if (msg) msg.textContent = err.message || String(err);
        }
      });
    }
    if (build && !build._wired) {
      build._wired = true;
      build.addEventListener("click", async () => {
        if (msg) msg.textContent = "Building…";
        try {
          const r = await fetch("/api/youtube-package", { method: "POST" });
          const j = await r.json();
          if (!j.ok) throw new Error(j.error || "package failed");
          const st = await fetch("/api/state").then((x) => x.json());
          applyState(st);
          if (msg) msg.textContent = "Package ready";
        } catch (err) {
          if (msg) msg.textContent = err.message || String(err);
        }
      });
    }
  }

  function renderAll(tabs, { force = false } = {}) {
    renderLyrics(tabs, { force });
    renderSong(tabs);
    renderStoryline(tabs, { force });
    renderScenes(tabs);
    renderScripts(tabs);
    renderKeyframes(tabs);
    renderClips(tabs);
    renderFinal(tabs);
    markTabData(tabs, state.progress);
  }

  function applyState(s, { jumpProgress = false } = {}) {
    const prevSong = state.songDir;
    Object.assign(state, s);
    if (s.progress != null) state.progress = s.progress;
    if (s.statusMessage) statusMsg.textContent = s.statusMessage;
    if (s.stage) stagePill.textContent = s.stage;
    if (typeof s.autoApprove === "boolean") autoApprove.checked = s.autoApprove;
    if (typeof s.paused === "boolean") state.paused = s.paused;
    if (typeof s.stopped === "boolean") state.stopped = s.stopped;
    if (typeof s.viewOnly === "boolean") state.viewOnly = s.viewOnly;
    if (typeof s.running === "boolean") state.running = s.running;
    if (s.gpu?.backend && $("gpuBackend")) $("gpuBackend").value = s.gpu.backend;
    if (s.outputResolution && $("outputResolution")) {
      $("outputResolution").value = s.outputResolution;
    }
    const pill = $("projectPill");
    if (pill) {
      pill.textContent = s.songDir ? `Project: ${s.songDir}` : "Project: —";
      pill.title = s.songDir
        ? `Active project (saved across restarts)\n${s.songDir}`
        : "No project open";
    }
    if (s.songDir && $("batchPicker")) {
      const opt = [...$("batchPicker").options].find((o) => o.value === s.songDir);
      if (opt) $("batchPicker").value = s.songDir;
    }
    const songChanged =
      Object.prototype.hasOwnProperty.call(s, "songDir") &&
      s.songDir !== prevSong;
    if (s.tabs) {
      state.tabs = s.tabs;
      renderAll(s.tabs, {
        force: jumpProgress || songChanged || !!s.viewOnly,
      });
    } else if (state.tabs) {
      markTabData(state.tabs, state.progress);
    }
    updateButtons();
    // Drop stale setup-start intent once we've moved on
    if (
      state._pendingSetupStart &&
      s.stage &&
      s.stage !== "await_setup" &&
      s.stage !== "setup" &&
      s.stage !== "idle"
    ) {
      state._pendingSetupStart = null;
    }
    if (songChanged) {
      setupLoaded = false;
    }
    if (setupLoaded && s.setup?.locationsExplicit && setupScenesCache.length) {
      // Don't wipe a live UI selection with an empty server list
      const liveIds = [
        ...document.querySelectorAll("#setupScenesList .room-card.is-on"),
      ].map((el) => el.dataset.id);
      const ids =
        s.setup.locationIds?.length
          ? s.setup.locationIds
          : liveIds.length
            ? liveIds
            : [];
      renderRoomCards(setupScenesCache, ids, {
        explicit: true,
      });
      applyBriefToForm(s.setup);
    } else {
      loadSetupLists();
    }

    const gate = waitingGate();
    if (gate && !state.paused && !jumpProgress && !songChanged) {
      const tab =
        gate === "setup"
          ? "setup"
          : gate === "plan"
            ? "storyline"
            : gate === "song"
              ? "song"
              : gate === "lyrics"
                ? "lyrics"
                : gate === "keyframes"
                  ? "keyframes"
                  : gate === "clips"
                    ? "clips"
                    : gate === "final"
                      ? "final"
                      : activeTab;
      selectTab(tab);
      if (gate === "setup") maybeApprovePendingSetup();
    } else if (jumpProgress || songChanged) {
      jumpToSongProgress(s.progress || state.progress, s.tabs || state.tabs);
    }
  }

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  document.querySelectorAll(".tabs button").forEach((b) => {
    b.addEventListener("click", () => selectTab(b.dataset.tab));
  });

  $("progressRail")?.addEventListener("click", (ev) => {
    const step = ev.target.closest(".progress-step");
    if (step?.dataset.tab) selectTab(step.dataset.tab);
  });

  lyricsText.addEventListener("input", () => {
    lyricsText.dataset.touched = "1";
  });

  autoApprove.addEventListener("change", async () => {
    const enabled = autoApprove.checked;
    updateButtons();
    try {
      // Flush cast/rooms before auto-resolving the setup gate
      if (enabled && waitingGate() === "setup") {
        await persistSetupDraft();
      }
      const res = await fetch("/api/auto-approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await res.json();
      if (!data.ok) {
        log(`Auto-approve failed: ${data.error || res.status}`);
        autoApprove.checked = false;
        updateButtons();
        return;
      }
      state.autoApprove = !!data.autoApprove;
      if (enabled) {
        const gate = waitingGate();
        log(
          gate
            ? `Auto-approve ON — approving ${gate}…`
            : "Auto-approve ON — will skip future gates",
        );
        // Belt-and-suspenders: if still waiting, send an explicit approve
        if (gate) {
          const payload = {};
          if (gate === "setup") Object.assign(payload, collectSetupPayload());
          if (gate === "lyrics") payload.text = lyricsText.value;
          if (gate === "plan") payload.raw = planRaw.value;
          await fetch("/api/approve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ stage: gate, payload }),
          });
        }
      } else {
        log("Auto-approve OFF");
      }
    } catch (err) {
      log(`Auto-approve error: ${err.message || err}`);
      autoApprove.checked = false;
      updateButtons();
    }
  });

  $("gpuBackend")?.addEventListener("change", async () => {
    const backend = $("gpuBackend").value;
    const res = await fetch("/api/gpu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend }),
    });
    const data = await res.json();
    if (!data.ok) {
      log(`GPU switch failed: ${data.error || res.status}`);
      $("gpuBackend").value = state.gpu?.backend || "local";
      return;
    }
    state.gpu = data;
    const routeNote =
      data.backend === "split"
        ? ` · prep ${data.comfyUrl || "local"} · clips ${data.clipsComfyUrl || "?"}`
        : "";
    log(
      `GPU → ${data.backend} (${data.comfyUrl})${data.comfyUp ? " · up" : " · not reachable yet"}${routeNote}`,
    );
  });

  $("outputResolution")?.addEventListener("change", async () => {
    const id = $("outputResolution").value;
    const res = await fetch("/api/resolution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!data.ok) {
      log(`Resolution switch failed: ${data.error || res.status}`);
      $("outputResolution").value = state.outputResolution || "preview";
      return;
    }
    state.outputResolution = data.outputResolution;
    const p = data.preset;
    log(
      `Output → ${data.outputResolution}` +
        (p ? ` (${p.stillWidth}×${p.stillHeight} stills / Wan)` : ""),
    );
  });

  async function refreshBatchPicker() {
    const sel = $("batchPicker");
    if (!sel) return;
    try {
      const res = await fetch("/api/batches");
      const data = await res.json();
      if (!data.ok) return;
      const cur = data.current || state.songDir || "";
      const prev = sel.value;
      sel.innerHTML = `<option value="">— open batch —</option>`;
      for (const b of data.batches || []) {
        const marks = [
          b.hasFinal ? "final" : null,
          b.hasClips ? "clips" : null,
          b.hasKeyframes ? "kf" : null,
        ]
          .filter(Boolean)
          .join(",");
        const opt = document.createElement("option");
        opt.value = b.path;
        opt.textContent = `${b.date}/${b.slug}${marks ? ` [${marks}]` : ""}`;
        sel.appendChild(opt);
      }
      sel.value = cur || prev || "";
    } catch (err) {
      console.warn(err);
    }
  }

  $("batchPicker")?.addEventListener("change", async () => {
    const path = $("batchPicker").value;
    if (!path) return;
    const res = await fetch("/api/open-song", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = await res.json();
    if (!data.ok) {
      log(`Open batch failed: ${data.error || res.status}`);
      return;
    }
    setupLoaded = false;
    applyState(data, { jumpProgress: true });
    log(
      `Opened ${data.songDir}` +
        (data.progress?.summary ? ` · ${data.progress.summary}` : ""),
    );
  });

  $("btnContinue")?.addEventListener("click", async () => {
    const res = await fetch("/api/continue", { method: "POST" });
    const data = await res.json();
    if (!data.ok) log(`Continue failed: ${data.error}`);
    else if (data.resumed) {
      state.paused = false;
      log(
        `Resumed with GPU ${data.backend || state.gpu?.backend || "?"}` +
          (data.clipsComfyUrl ? ` · clips ${data.clipsComfyUrl}` : ""),
      );
      updateButtons();
    } else log(`Continuing pipeline for ${data.songDir || state.songDir}`);
  });

  $("btnNewProject")?.addEventListener("click", async () => {
    const reshuffle = state.stage === "await_setup";
    const setupPayload = collectSetupPayload();
    if (!reshuffle) {
      if (
        !confirm(
          "Start a brand-new project with a fresh title & theme? Your current batch stays on disk.",
        )
      ) {
        return;
      }
      try {
        localStorage.removeItem("mvid-setup-draft");
      } catch {
        /* ignore */
      }
      setupLoaded = false;
    }
    const res = await fetch("/api/new-project", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(setupPayload),
    });
    const data = await res.json();
    if (!data.ok) return log(`New project failed: ${data.error}`);
    if (data.brief || data.setup) {
      state.setup = { ...(state.setup || {}), ...(data.setup || data.brief) };
      applyBriefToForm(data.setup || data.brief);
      // Keep the rooms the user had selected (don't let empty server wipe UI)
      if (setupPayload.locationIds?.length && $("setupScenesList")) {
        renderRoomCards(setupScenesCache, setupPayload.locationIds, {
          explicit: true,
        });
        state.setup.locationIds = setupPayload.locationIds;
        state.setup.locationsExplicit = true;
      }
    }
    if (data.reshuffled) {
      scheduleSetupSave();
      log(`New brief: “${data.brief?.title || "?"}”`);
    } else {
      log(`Starting new project — “${data.brief?.title || "…"}”`);
    }
  });

  $("btnShuffleBrief")?.addEventListener("click", async () => {
    const res = await fetch("/api/suggest-brief", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!data.ok) return log(`Shuffle failed: ${data.error}`);
    state.setup = { ...(state.setup || {}), ...(data.setup || data.brief) };
    applyBriefToForm(data.setup || data.brief);
    scheduleSetupSave();
    log(`Shuffled brief: “${data.brief?.title || "?"}”`);
  });

  $("btnPause")?.addEventListener("click", async () => {
    const res = await fetch("/api/pause", { method: "POST" });
    const data = await res.json();
    if (!data.ok) log(`Pause failed: ${data.error}`);
    else log(`Paused (from ${data.from || "?"})`);
    state.paused = true;
    updateButtons();
  });

  $("btnResume")?.addEventListener("click", async () => {
    const res = await fetch("/api/resume", { method: "POST" });
    const data = await res.json();
    if (!data.ok) log(`Resume failed: ${data.error}`);
    else {
      log(
        `Resumed · GPU ${data.backend || state.gpu?.backend || "?"}` +
          (data.clipsComfyUrl ? ` · clips ${data.clipsComfyUrl}` : ""),
      );
    }
    state.paused = false;
    updateButtons();
  });

  $("btnStop")?.addEventListener("click", async () => {
    if (!confirm("Stop the pipeline? You will need to restart mvid to continue.")) return;
    const res = await fetch("/api/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Stopped by user" }),
    });
    const data = await res.json();
    log(data.ok ? "Stopped" : `Stop failed: ${data.error}`);
    state.stopped = true;
    state.paused = false;
    updateButtons();
  });

  $("btnSaladRefresh")?.addEventListener("click", () => refreshSaladStatus());
  $("btnSaladStart")?.addEventListener("click", async () => {
    log("Starting Salad container…");
    const res = await fetch("/api/salad/start", { method: "POST" });
    const data = await res.json();
    if (!data.ok) log(`Salad start failed: ${data.error}`);
    else log("Salad start requested (billing begins when instances run)");
    await refreshSaladStatus();
  });
  $("btnSaladStop")?.addEventListener("click", async () => {
    if (!confirm("Shutdown Salad container group to stop GPU billing?")) return;
    log("Stopping Salad container…");
    const res = await fetch("/api/salad/stop", { method: "POST" });
    const data = await res.json();
    if (!data.ok) log(`Salad shutdown failed: ${data.error}`);
    else log("Salad shutdown requested");
    await refreshSaladStatus();
  });

  async function refreshComfyOps() {
    const body = $("saladOpsBody");
    const urlEl = $("saladOpsUrl");
    if (body) body.textContent = "Loading…";
    try {
      const res = await fetch("/api/comfy/ops?stage=clips");
      const data = await res.json();
      if (!data.ok) {
        if (body) body.textContent = data.error || "Ops failed";
        return;
      }
      if (urlEl) urlEl.textContent = data.url || "";
      const lines = [
        `backend=${data.backend}  salad=${data.salad ? "yes" : "no"}  up=${data.up ? "yes" : "no"}`,
        `queue: running=${data.running}  pending=${data.pending}`,
      ];
      if (data.runningIds?.length) {
        lines.push(`running ids: ${data.runningIds.join(", ")}`);
      }
      if (data.pendingIds?.length) {
        lines.push(`pending ids: ${data.pendingIds.join(", ")}`);
      }
      if (data.queueError) lines.push(`queue err: ${data.queueError}`);
      if (data.devices?.length) {
        for (const d of data.devices) {
          lines.push(
            `gpu ${d.name}: VRAM ${d.vramUsedMb ?? "?"} / ${d.vramTotalMb ?? "?"} MB` +
              (d.vramFreeMb != null ? ` (free ${d.vramFreeMb})` : ""),
          );
        }
      } else if (data.statsError) {
        lines.push(`stats err: ${data.statsError}`);
      }
      if (data.comfy) lines.push(`comfy ${data.comfy}`);
      if (data.pytorch) lines.push(`pytorch ${data.pytorch}`);
      if (body) body.textContent = lines.join("\n");
    } catch (err) {
      if (body) body.textContent = err.message || String(err);
    }
  }

  $("btnSaladOps")?.addEventListener("click", async () => {
    const panel = $("saladOpsPanel");
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) await refreshComfyOps();
  });
  $("btnSaladOpsClose")?.addEventListener("click", () => {
    const panel = $("saladOpsPanel");
    if (panel) panel.hidden = true;
  });
  $("btnComfyRefreshOps")?.addEventListener("click", () => refreshComfyOps());
  $("btnComfyInterrupt")?.addEventListener("click", async () => {
    log("Comfy interrupt…");
    const res = await fetch("/api/comfy/interrupt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "clips" }),
    });
    const data = await res.json();
    log(data.ok ? "Interrupted" : `Interrupt failed: ${data.error}`);
    await refreshComfyOps();
  });
  $("btnComfyClearQueue")?.addEventListener("click", async () => {
    if (!confirm("Clear the Comfy queue on the clips GPU?")) return;
    log("Clearing Comfy queue…");
    const res = await fetch("/api/comfy/clear-queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "clips" }),
    });
    const data = await res.json();
    log(data.ok ? "Queue cleared" : `Clear failed: ${data.error}`);
    await refreshComfyOps();
  });
  $("btnComfyReset")?.addEventListener("click", async () => {
    if (!confirm("Interrupt + clear queue + free VRAM on clips GPU?")) return;
    log("Resetting Comfy execution…");
    const res = await fetch("/api/comfy/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "clips" }),
    });
    const data = await res.json();
    log(data.ok ? "Comfy reset done" : `Reset failed: ${data.error}`);
    await refreshComfyOps();
  });

  $("btnCreateChar")?.addEventListener("click", async () => {
    const name = $("newCharName").value.trim();
    if (!name) return log("Character name required");
    const res = await fetch("/api/characters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        role: $("newCharRole").value,
        appearance: $("newCharAppearance").value,
        outfit: $("newCharOutfit").value,
        negative: $("newCharNegative")?.value || "",
        styleTag: $("newCharStyle")?.value || "",
        age: window.__newCharAge || "",
      }),
    });
    const data = await res.json();
    if (!data.ok) return log(`Create character failed: ${data.error}`);
    log(`Created character ${data.character.id} — open Character studio to generate master`);
    $("newCharName").value = "";
    $("newCharAppearance").value = "";
    $("newCharOutfit").value = "";
    if ($("newCharNegative")) $("newCharNegative").value = "";
    if ($("newCharStyle")) $("newCharStyle").value = "";
    window.__newCharAge = "";
    setupLoaded = false;
    await loadSetupLists();
    if ($("studioCharSelect")) {
      $("studioCharSelect").value = data.character.id;
      await loadStudioCharacter(data.character.id);
    }
  });

  let studioId = "";
  let studioPoll = null;
  let roomPoll = null;
  let characterPresets = [];
  let roomPresets = [];

  function fillStudioSelect(list) {
    const sel = $("studioCharSelect");
    if (!sel) return;
    const prev = sel.value || studioId;
    sel.innerHTML =
      `<option value="">Select…</option>` +
      (list || [])
        .map(
          (c) =>
            `<option value="${esc(c.id)}">${esc(c.name || c.id)}</option>`,
        )
        .join("");
    if (prev && [...sel.options].some((o) => o.value === prev)) {
      sel.value = prev;
    }
  }

  function renderPresetChips(containerId, presets, onPick) {
    const el = $(containerId);
    if (!el) return;
    el.innerHTML = (presets || [])
      .map(
        (p) =>
          `<button type="button" class="preset-chip" data-preset="${esc(p.id)}">${esc(p.label)}</button>`,
      )
      .join("");
    el.onclick = (ev) => {
      const btn = ev.target.closest(".preset-chip");
      if (!btn) return;
      const preset = (presets || []).find((p) => p.id === btn.dataset.preset);
      if (preset) onPick(preset);
    };
  }

  function applyCharPreset(preset, target) {
    if (!preset) return;
    if (target === "new") {
      if ($("newCharRole")) $("newCharRole").value = preset.role || "toddler";
      if ($("newCharAppearance")) $("newCharAppearance").value = preset.appearance || "";
      if ($("newCharOutfit")) $("newCharOutfit").value = preset.outfit || "";
      if ($("newCharNegative")) $("newCharNegative").value = preset.negative || "";
      if ($("newCharStyle")) $("newCharStyle").value = preset.styleTag || "";
      window.__newCharAge = preset.age || "";
      if (!$("newCharName")?.value?.trim()) {
        $("newCharName").value = preset.label;
      }
    } else {
      if ($("studioAppearance")) $("studioAppearance").value = preset.appearance || "";
      if ($("studioOutfit")) $("studioOutfit").value = preset.outfit || "";
      if ($("studioNegative")) $("studioNegative").value = preset.negative || "";
      if ($("studioStyleTag")) $("studioStyleTag").value = preset.styleTag || "";
      if ($("studioAge")) $("studioAge").value = preset.age || "";
    }
    log(`Filled ${preset.label} prompts`);
  }

  async function loadPresets() {
    try {
      const [cRes, rRes] = await Promise.all([
        fetch("/api/character-presets"),
        fetch("/api/room-presets"),
      ]);
      const cData = await cRes.json();
      const rData = await rRes.json();
      if (cData.ok) {
        characterPresets = cData.presets || [];
        renderPresetChips("newCharPresets", characterPresets, (p) =>
          applyCharPreset(p, "new"),
        );
        renderPresetChips("studioPresets", characterPresets, (p) =>
          applyCharPreset(p, "studio"),
        );
      }
      if (rData.ok) {
        roomPresets = rData.presets || [];
        renderPresetChips("roomPresets", roomPresets, (p) => {
          if ($("newRoomName")) $("newRoomName").value = p.name || p.label;
          if ($("newRoomId")) $("newRoomId").value = p.id || "";
          if ($("newRoomStill")) $("newRoomStill").value = p.still || "";
          log(`Filled room preset: ${p.label}`);
        });
      }
    } catch (err) {
      console.warn("preset load failed", err);
    }
  }
  loadPresets();

  function toast(message, kind = "") {
    const stack = $("toastStack");
    if (!stack) {
      log(message);
      return;
    }
    const el = document.createElement("div");
    el.className = `toast${kind ? ` is-${kind}` : ""}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.remove();
    }, 6500);
    log(message);
  }

  function setStudioBusy(busy) {
    for (const id of [
      "btnStudioSave",
      "btnStudioMaster",
      "btnStudioApprove",
      "btnStudioDataset",
      "btnStudioTrain",
      "btnStudioFaceRef",
      "btnStudioStill",
      "btnStudioDescribe",
      "studioCharSelect",
      "studioMasterCount",
    ]) {
      const el = $(id);
      if (el) el.disabled = !!busy;
    }
  }

  function updateStudioBanner(job, { forceIdle = false, dataset = null } = {}) {
    const banner = $("studioBanner");
    const title = $("studioBannerTitle");
    const sub = $("studioBannerSub");
    const spin = $("studioBannerSpin");
    if (!banner || !title) return;
    if (forceIdle || !job) {
      banner.hidden = true;
      banner.classList.remove("is-error", "is-ok");
      if (spin) spin.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.classList.toggle("is-error", !job.running && job.exitCode !== 0);
    banner.classList.toggle("is-ok", !job.running && job.exitCode === 0);
    if (spin) spin.hidden = !job.running;
    const progressLabel = dataset?.progress?.label;
    if (job.running) {
      title.textContent = progressLabel
        ? `${job.label || "Job"} — ${progressLabel}`
        : `${job.label || "Job"} running…`;
      const last = (job.log || []).slice(-1)[0]?.line || "Working on local Comfy…";
      if (sub) sub.textContent = last;
    } else if (job.exitCode === 0) {
      title.textContent = `${job.label || "Job"} finished`;
      if (sub) {
        sub.textContent = progressLabel
          ? `${progressLabel} ready`
          : "Refresh below — dataset thumbs appear when images are ready.";
      }
    } else {
      title.textContent = `${job.label || "Job"} failed`;
      const errLine =
        job.error ||
        (job.log || []).slice().reverse().find((l) => /fail|error/i.test(l.line || ""))?.line ||
        `Exit code ${job.exitCode}`;
      if (sub) sub.textContent = errLine;
    }
  }

  function renderStudioJob(job, dataset = null) {
    const logEl = $("studioLog");
    const hint = $("studioLogHint");
    if (!logEl) return;
    updateStudioBanner(job, { dataset });
    if (!job) {
      logEl.textContent = "Select a character, then generate.";
      if (hint) hint.textContent = "Live job output";
      return;
    }
    const lines = (job.log || []).slice(-60).map((l) => l.line);
    logEl.textContent = [
      `${job.label || "Job"}${job.running ? "…" : job.exitCode === 0 ? " ✓" : ` (exit ${job.exitCode})`}`,
      dataset?.progress?.label ? `Progress: ${dataset.progress.label}` : "",
      ...lines,
      job.error ? `ERROR: ${job.error}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    logEl.scrollTop = logEl.scrollHeight;
    if (hint) {
      hint.textContent = job.running
        ? dataset?.progress?.label || "Updating live…"
        : job.exitCode === 0
          ? "Completed"
          : "Failed — see ERROR line";
    }
  }

  function renderCandidates(list) {
    const el = $("studioCandidates");
    if (!el) return;
    const items = list || [];
    if (!items.length) {
      el.hidden = true;
      el.innerHTML = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = items
      .map(
        (c, i) =>
          `<button type="button" class="studio-cand" data-file="${esc(c.file)}" title="Use this master">
            <img src="${esc(c.url)}" alt="Candidate ${i + 1}" loading="lazy" />
            <span class="studio-cand-label">Pick ${i + 1}</span>
          </button>`,
      )
      .join("");
  }

  let activeShotId = "";
  let studioDatasetImages = [];
  let studioSlideshow = [];
  let studioSlideshowIndex = 0;
  let studioSlideshowRemaking = false;

  function closeShotEditor() {
    activeShotId = "";
    const ed = $("shotEditor");
    if (ed) ed.hidden = true;
    document
      .querySelectorAll(".studio-dataset-tile.is-active")
      .forEach((el) => el.classList.remove("is-active"));
  }

  function openShotEditor(img) {
    if (!img?.editable || !img.shot) {
      toast("This file isn’t an editable training shot", "error");
      return;
    }
    activeShotId = img.shotId;
    studioDatasetImages = studioDatasetImages || [];
    const ed = $("shotEditor");
    if (!ed) return;
    ed.hidden = false;
    if ($("shotEditorImg")) $("shotEditorImg").src = img.url;
    if ($("shotEditorTitle")) $("shotEditorTitle").textContent = img.shotId;
    if ($("shotEditorFile")) $("shotEditorFile").textContent = img.file;
    const s = img.shot;
    if ($("shotPose")) $("shotPose").value = s.pose || "";
    if ($("shotAngle")) $("shotAngle").value = s.angle || "";
    if ($("shotCaptionExtra")) $("shotCaptionExtra").value = s.captionExtra || "";
    if ($("shotAngleKey")) $("shotAngleKey").value = s.angleKey || "front";
    if ($("shotPoseKey")) $("shotPoseKey").value = s.poseKey || "stand";
    if ($("shotExpression")) $("shotExpression").value = s.expression || "neutral";
    if ($("shotBust")) $("shotBust").checked = !!s.bust;
    if ($("shotAppearance")) $("shotAppearance").value = s.appearance || "";
    if ($("shotOutfit")) $("shotOutfit").value = s.outfit || "";
    if ($("shotNegative")) $("shotNegative").value = s.negative || "";
    if ($("shotExtraNegative")) $("shotExtraNegative").value = s.extraNegative || "";
    document.querySelectorAll(".studio-dataset-tile").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.shotId === img.shotId);
    });
    ed.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function readShotEditorPatch() {
    return {
      pose: $("shotPose")?.value || "",
      angle: $("shotAngle")?.value || "",
      captionExtra: $("shotCaptionExtra")?.value || "",
      angleKey: $("shotAngleKey")?.value || "front",
      poseKey: $("shotPoseKey")?.value || "stand",
      expression: $("shotExpression")?.value || "neutral",
      bust: !!$("shotBust")?.checked,
      appearance: $("shotAppearance")?.value || "",
      outfit: $("shotOutfit")?.value || "",
      negative: $("shotNegative")?.value || "",
      extraNegative: $("shotExtraNegative")?.value || "",
    };
  }

  function buildSlideshowItems(dataset) {
    const keyframes = dataset?.keyframes || [];
    const images = dataset?.images || [];
    const items = [];
    for (const img of keyframes) {
      items.push({
        kind: "keyframe",
        id: img.id || String(img.file || "").replace(/\.[^.]+$/, ""),
        file: img.file,
        url: img.url,
        label: img.id || img.file,
        gateFail: Boolean(img.gateFail),
      });
    }
    for (const img of images) {
      items.push({
        kind: "shot",
        id: img.shotId || String(img.file || "").replace(/\.[^.]+$/, ""),
        file: img.file,
        url: img.url,
        label: img.shotId || img.file,
        editable: Boolean(img.editable),
        shot: img.shot || null,
        gateFail: Boolean(img.gateFail),
      });
    }
    return items;
  }

  function syncLightboxUi() {
    const box = $("datasetLightbox");
    if (!box || box.hidden) return;
    const item = studioSlideshow[studioSlideshowIndex];
    if (!item) return;
    const img = $("datasetLightboxImg");
    const cap = $("datasetLightboxCaption");
    const hint = $("datasetLightboxHint");
    const busy = $("datasetLightboxBusy");
    const remake = $("btnLightboxRemake");
    const edit = $("btnLightboxEdit");
    if (img) img.src = item.url;
    if (cap) {
      cap.textContent = `${item.label} · ${item.kind} · ${studioSlideshowIndex + 1} / ${studioSlideshow.length}`;
    }
    if (hint) {
      hint.textContent = item.gateFail
        ? "Gate failed on this plate — Remake recommended."
        : item.kind === "keyframe"
          ? item.id === "front"
            ? "front remakes by re-copying the approved master."
            : "Remake regenerates this keyframe from the nearest source."
          : "Remake regenerates this training shot.";
    }
    if (busy) busy.hidden = !studioSlideshowRemaking;
    if (remake) remake.disabled = studioSlideshowRemaking;
    if (edit) {
      edit.hidden = !(item.kind === "shot" && item.editable);
      edit.disabled = studioSlideshowRemaking;
    }
  }

  function openDatasetSlideshow(index = 0) {
    if (!studioSlideshow.length) return;
    studioSlideshowIndex = Math.max(0, Math.min(index, studioSlideshow.length - 1));
    const box = $("datasetLightbox");
    if (box) box.hidden = false;
    syncLightboxUi();
  }

  function closeDatasetSlideshow() {
    const box = $("datasetLightbox");
    if (box) box.hidden = true;
    studioSlideshowRemaking = false;
    syncLightboxUi();
  }

  function stepDatasetSlideshow(delta) {
    if (!studioSlideshow.length) return;
    const n = studioSlideshow.length;
    studioSlideshowIndex = (studioSlideshowIndex + delta + n) % n;
    syncLightboxUi();
  }

  async function remakeSlideshowItem(item) {
    if (!studioId || !item || studioSlideshowRemaking) return;
    studioSlideshowRemaking = true;
    syncLightboxUi();
    toast(`Remaking ${item.label}…`);
    try {
      let res;
      if (item.kind === "keyframe") {
        res = await fetch(
          `/api/characters/${encodeURIComponent(studioId)}/keyframes/${encodeURIComponent(item.id)}/regenerate`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        );
      } else {
        res = await fetch(
          `/api/characters/${encodeURIComponent(studioId)}/shots/${encodeURIComponent(item.id)}/regenerate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          },
        );
      }
      const data = await res.json();
      if (!data.ok) {
        toast(`Remake failed: ${data.error}`, "error");
        studioSlideshowRemaking = false;
        syncLightboxUi();
        return;
      }
      if (data.copied) {
        toast(`front.png re-copied from master`, "ok");
        studioSlideshowRemaking = false;
        await refreshStudioStatus();
        // refresh current slide URL after status
        const refreshed = studioSlideshow[studioSlideshowIndex];
        if (refreshed && $("datasetLightboxImg")) {
          $("datasetLightboxImg").src = refreshed.url;
        }
        syncLightboxUi();
        return;
      }
      if (data.job) {
        renderStudioJob(data.job);
        setStudioBusy(true);
        startStudioPoll();
      }
    } catch (err) {
      toast(`Remake error: ${err.message || err}`, "error");
      studioSlideshowRemaking = false;
      syncLightboxUi();
    }
  }

  function renderDatasetGrid(dataset, { jobRunning = false } = {}) {
    const grid = $("studioDatasetGrid");
    const meta = $("studioDatasetMeta");
    const prog = $("studioDatasetProgress");
    const progFill = $("studioDatasetProgressFill");
    const progText = $("studioDatasetProgressText");
    if (!grid) return;
    const images = dataset?.images || [];
    const keyframes = dataset?.keyframes || [];
    studioDatasetImages = images;
    const prevId = studioSlideshow[studioSlideshowIndex]?.id;
    const prevKind = studioSlideshow[studioSlideshowIndex]?.kind;
    studioSlideshow = buildSlideshowItems(dataset);
    if (prevId) {
      const idx = studioSlideshow.findIndex(
        (x) => x.id === prevId && x.kind === prevKind,
      );
      if (idx >= 0) studioSlideshowIndex = idx;
    }
    // Job finished while remaking — clear busy and refresh lightbox image
    if (studioSlideshowRemaking && !jobRunning) {
      studioSlideshowRemaking = false;
    }
    if (!$("datasetLightbox")?.hidden) syncLightboxUi();

    const count = dataset?.trainingImageCount ?? dataset?.imageCount ?? images.length ?? 0;
    const shotTotal = dataset?.shotCount || 0;
    const kf = dataset?.keyframeCount || 0;
    const kfTotal = dataset?.keyframeTotal || 0;
    const progress = dataset?.progress || {};
    const phase = progress.phase || (count > 0 ? "shots" : "keyframes");

    if (meta) {
      const parts = [];
      if (progress.label) parts.push(progress.label);
      else parts.push(`${count} images`);
      if (kfTotal) parts.push(`${kf} / ${kfTotal} keyframes`);
      else if (kf) parts.push(`${kf} keyframes`);
      if (dataset?.ready) parts.push("ready");
      if (jobRunning) parts.push("generating…");
      meta.textContent = parts.join(" · ");
    }

    if (prog && progFill && progText) {
      const overallTotal = Number(progress.overallTotal) || (kfTotal + shotTotal) || shotTotal || kfTotal;
      const overallDone = Number(progress.overallDone);
      const done =
        Number.isFinite(overallDone)
          ? overallDone
          : phase === "keyframes"
            ? kf
            : count;
      const total = overallTotal || Number(progress.total) || 0;
      if (total > 0) {
        prog.hidden = false;
        const pct = Math.round((Math.min(done, total) / total) * 100);
        progFill.style.width = `${pct}%`;
        progText.textContent =
          progress.label ||
          (phase === "keyframes"
            ? `${kf} / ${kfTotal || total}`
            : `${count} / ${shotTotal || total}`);
      } else {
        prog.hidden = !jobRunning;
      }
    }

    const tileHtml = (item, index) => {
      const fail = item.gateFail ? " is-gate-fail" : "";
      return `<div class="studio-dataset-tile-wrap">
        <button type="button" class="studio-dataset-tile${fail}" data-slide-index="${index}" title="${esc(item.label)}">
          <img src="${esc(item.url)}" alt="${esc(item.label)}" loading="lazy" />
          <span>${esc(item.label)}</span>
        </button>
        <button type="button" class="btn tiny primary tile-remake" data-remake-index="${index}">Remake</button>
      </div>`;
    };

    const kfItems = studioSlideshow
      .map((it, i) => ({ it, i }))
      .filter((x) => x.it.kind === "keyframe");
    const shotItems = studioSlideshow
      .map((it, i) => ({ it, i }))
      .filter((x) => x.it.kind === "shot");

    const kfBlock =
      kfItems.length > 0
        ? `<div class="studio-dataset-section">
            <div class="studio-dataset-section-title">Keyframes ${kf}${kfTotal ? ` / ${kfTotal}` : ""}</div>
            <div class="studio-dataset-grid-inner">
              ${kfItems.map(({ it, i }) => tileHtml(it, i)).join("")}
            </div>
          </div>`
        : "";

    const shotBlock =
      shotItems.length > 0
        ? `<div class="studio-dataset-section">
            <div class="studio-dataset-section-title">Training shots ${count}${shotTotal ? ` / ${shotTotal}` : ""}</div>
            <div class="studio-dataset-grid-inner">
              ${shotItems.map(({ it, i }) => tileHtml(it, i)).join("")}
            </div>
          </div>`
        : "";

    if (!kfBlock && !shotBlock) {
      grid.innerHTML = `<span class="meta">${
        jobRunning
          ? phase === "keyframes"
            ? "Building keyframe bank…"
            : "Waiting for first training shot…"
          : "No training images yet"
      }</span>`;
      if (!jobRunning) closeShotEditor();
      return;
    }

    grid.innerHTML = `${kfBlock}${shotBlock}${
      jobRunning && phase === "keyframes" && !shotBlock
        ? `<p class="meta">Keyframe bank first — training shots start after ${kfTotal || "all"} keyframes.</p>`
        : ""
    }`;

    if (activeShotId) {
      const still = images.find((i) => i.shotId === activeShotId);
      if (still) {
        if ($("shotEditorImg")) $("shotEditorImg").src = still.url;
      } else if (!jobRunning) {
        closeShotEditor();
      }
    }
  }

  function renderStudioSteps(data) {
    const root = $("studioSteps");
    if (!root) return;
    const m = data.master || {};
    const d = data.dataset || {};
    const l = data.lora || {};
    const job = data.job;
    const set = (step, state) => {
      const el = root.querySelector(`[data-step="${step}"]`);
      if (!el) return;
      el.classList.toggle("is-done", state === "done");
      el.classList.toggle("is-active", state === "active");
    };
    const masterState = m.approved
      ? "done"
      : job?.running && /master/i.test(job.label || "")
        ? "active"
        : m.exists
          ? "active"
          : "";
    const datasetState = d.ready
      ? "done"
      : job?.running && /dataset/i.test(job.label || "")
        ? "active"
        : d.imageCount > 0
          ? "active"
          : m.approved
            ? "active"
            : "";
    const trainState = l.exists
      ? "done"
      : job?.running && /train|lora/i.test(job.label || "")
        ? "active"
        : d.ready
          ? "active"
          : "";
    set("master", masterState);
    set("dataset", datasetState);
    set("train", trainState);
  }

  function renderStudioStatus(data) {
    const st = $("studioStatus");
    const img = $("studioMasterImg");
    const empty = $("studioMasterEmpty");
    if (!st) return;
    const m = data.master || {};
    const d = data.dataset || {};
    const l = data.lora || {};
    const candCount = (data.candidates || []).length;
    st.textContent = [
      m.approved
        ? "Master: approved"
        : m.exists
          ? "Master: pending approval"
          : "Master: not generated",
      candCount ? `Candidates: ${candCount} — tap one to select` : "",
      `Dataset: ${d.imageCount || 0} images` +
        (d.keyframeCount ? ` · ${d.keyframeCount} keyframes` : "") +
        (d.shotCount != null ? ` · ${d.shotCount} shots` : "") +
        (d.ready ? " (ready)" : ""),
      l.name
        ? `LoRA: ${l.name}${l.exists ? " (file found)" : " (not trained yet)"}`
        : "LoRA: not set",
      data.job?.running ? `Job: ${data.job.label}…` : "",
    ]
      .filter(Boolean)
      .join("\n");

    if (m.url && img) {
      img.hidden = false;
      if (empty) empty.hidden = true;
      img.src = m.url;
    } else if (img) {
      img.hidden = true;
      img.removeAttribute("src");
      if (empty) empty.hidden = false;
    }

    renderCandidates(data.candidates);
    renderDatasetGrid(d, { jobRunning: !!data.job?.running });
    renderStudioSteps(data);
    renderStudioUploads(data.uploads);

    const approve = $("btnStudioApprove");
    const dataset = $("btnStudioDataset");
    const train = $("btnStudioTrain");
    const busy = !!data.job?.running;
    if (approve) approve.disabled = busy || !m.exists || !!m.approved;
    if (dataset) dataset.disabled = busy || !m.approved;
    if (train) train.disabled = busy || !(d.imageCount >= 4);
    setStudioBusy(busy);
    if (approve && m.approved) approve.textContent = "Approved";
    else if (approve) approve.textContent = "Approve";
    renderStudioJob(data.job, d);
  }

  async function loadStudioCharacter(id) {
    studioId = id || "";
    const body = $("studioBody");
    const emptyHint = $("studioEmptyHint");
    if (!id) {
      if (body) body.hidden = true;
      if (emptyHint) emptyHint.hidden = false;
      return;
    }
    if (body) body.hidden = false;
    if (emptyHint) emptyHint.hidden = true;
    const res = await fetch(`/api/characters/${encodeURIComponent(id)}`);
    const data = await res.json();
    if (!data.ok) {
      toast(`Studio load failed: ${data.error}`, "error");
      return;
    }
    const c = data.character || {};
    if ($("studioAppearance")) $("studioAppearance").value = c.appearance || "";
    if ($("studioOutfit")) $("studioOutfit").value = c.outfit || "";
    if ($("studioNegative")) $("studioNegative").value = c.negative || "";
    if ($("studioStyleTag")) $("studioStyleTag").value = c.styleTag || "";
    if ($("studioAge")) $("studioAge").value = c.age || "";
    if ($("studioTrigger")) $("studioTrigger").value = c.trigger || "";
    renderStudioStatus(data);
    if (data.job?.running) startStudioPoll();
  }

  async function refreshStudioStatus() {
    if (!studioId) return;
    const res = await fetch(`/api/characters/${encodeURIComponent(studioId)}`);
    const data = await res.json();
    if (data.ok) renderStudioStatus(data);
  }

  function startStudioPoll() {
    if (studioPoll) return;
    studioPoll = setInterval(async () => {
      if (!studioId) return;
      await refreshStudioStatus();
      const res = await fetch(`/api/characters/${encodeURIComponent(studioId)}/job`);
      const data = await res.json();
      if (!data.job?.running) {
        clearInterval(studioPoll);
        studioPoll = null;
        await refreshStudioStatus();
        setupLoaded = false;
        await loadSetupLists();
        if (data.job) {
          if (data.job.exitCode === 0) {
            toast(`${data.job.label || "Job"} finished`, "ok");
          } else {
            const err =
              data.job.error ||
              (data.job.log || [])
                .slice()
                .reverse()
                .find((l) => /fail|error/i.test(l.line || ""))?.line ||
              `exit ${data.job.exitCode}`;
            toast(`${data.job.label || "Job"} failed: ${err}`, "error");
          }
        }
      }
    }, 1200);
  }

  $("studioCharSelect")?.addEventListener("change", async (ev) => {
    await loadStudioCharacter(ev.target.value);
  });

  $("studioCandidates")?.addEventListener("click", async (ev) => {
    const btn = ev.target.closest(".studio-cand");
    if (!btn || !studioId) return;
    const file = btn.dataset.file;
    toast(`Selecting master ${file}…`);
    const res = await fetch(
      `/api/characters/${encodeURIComponent(studioId)}/select-master`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file }),
      },
    );
    const data = await res.json();
    if (!data.ok) return toast(`Select failed: ${data.error}`, "error");
    toast(`Selected ${file} — other candidates cleared`, "ok");
    await refreshStudioStatus();
  });

  $("studioDatasetGrid")?.addEventListener("click", (ev) => {
    const remakeBtn = ev.target.closest("[data-remake-index]");
    if (remakeBtn) {
      ev.preventDefault();
      const idx = Number(remakeBtn.dataset.remakeIndex);
      const item = studioSlideshow[idx];
      if (!item) return;
      openDatasetSlideshow(idx);
      remakeSlideshowItem(item);
      return;
    }
    const tile = ev.target.closest(".studio-dataset-tile");
    if (!tile) return;
    const idx = Number(tile.dataset.slideIndex);
    if (!Number.isFinite(idx)) return;
    openDatasetSlideshow(idx);
  });

  $("btnLightboxPrev")?.addEventListener("click", () => stepDatasetSlideshow(-1));
  $("btnLightboxNext")?.addEventListener("click", () => stepDatasetSlideshow(1));
  $("btnLightboxRemake")?.addEventListener("click", () => {
    const item = studioSlideshow[studioSlideshowIndex];
    if (item) remakeSlideshowItem(item);
  });
  $("btnLightboxEdit")?.addEventListener("click", () => {
    const item = studioSlideshow[studioSlideshowIndex];
    if (!item || item.kind !== "shot") return;
    const img = (studioDatasetImages || []).find((i) => i.shotId === item.id);
    if (img) openShotEditor(img);
  });
  $("datasetLightbox")?.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-lightbox-close]")) closeDatasetSlideshow();
  });
  document.addEventListener("keydown", (ev) => {
    const box = $("datasetLightbox");
    if (!box || box.hidden) return;
    if (ev.key === "Escape") closeDatasetSlideshow();
    if (ev.key === "ArrowLeft") stepDatasetSlideshow(-1);
    if (ev.key === "ArrowRight") stepDatasetSlideshow(1);
  });

  $("btnShotEditorClose")?.addEventListener("click", () => closeShotEditor());

  $("btnShotSave")?.addEventListener("click", async () => {
    if (!studioId || !activeShotId) return;
    const patch = readShotEditorPatch();
    const res = await fetch(
      `/api/characters/${encodeURIComponent(studioId)}/shots/${encodeURIComponent(activeShotId)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    const data = await res.json();
    if (!data.ok) return toast(`Save shot failed: ${data.error}`, "error");
    toast(`Saved prompts for ${activeShotId}`, "ok");
    await refreshStudioStatus();
  });

  $("btnShotRegen")?.addEventListener("click", async () => {
    if (!studioId || !activeShotId) return;
    const patch = readShotEditorPatch();
    toast(`Regenerating ${activeShotId}…`);
    const res = await fetch(
      `/api/characters/${encodeURIComponent(studioId)}/shots/${encodeURIComponent(activeShotId)}/regenerate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      },
    );
    const data = await res.json();
    if (!data.ok) return toast(`Regen failed: ${data.error}`, "error");
    if (data.job) {
      renderStudioJob(data.job);
      setStudioBusy(true);
      startStudioPoll();
    }
  });

  $("btnStudioSave")?.addEventListener("click", async () => {
    if (!studioId) return;
    const res = await fetch(`/api/characters/${encodeURIComponent(studioId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appearance: $("studioAppearance")?.value || "",
        outfit: $("studioOutfit")?.value || "",
        negative: $("studioNegative")?.value || "",
        styleTag: $("studioStyleTag")?.value || "",
        age: $("studioAge")?.value || "",
        trigger: $("studioTrigger")?.value || "",
      }),
    });
    const data = await res.json();
    log(data.ok ? `Saved ${studioId} prompts` : `Save failed: ${data.error}`);
  });

  async function postStudioAction(path, label, body = {}) {
    if (!studioId) return;
    toast(`${label}…`);
    const res = await fetch(
      `/api/characters/${encodeURIComponent(studioId)}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    const data = await res.json();
    if (!data.ok) {
      toast(`${label} failed: ${data.error}`, "error");
      return;
    }
    if (data.job) {
      renderStudioJob(data.job);
      setStudioBusy(true);
      startStudioPoll();
    } else {
      await refreshStudioStatus();
      toast(`${label} done`, "ok");
    }
  }

  function renderStudioUploads(uploads) {
    const u = uploads || {};
    const faceImg = $("studioFaceRefPreview");
    const faceStatus = $("studioFaceRefStatus");
    const stillImg = $("studioStillPreview");
    const stillStatus = $("studioStillStatus");
    if (faceImg) {
      if (u.faceRefUrl) {
        faceImg.hidden = false;
        faceImg.src = u.faceRefUrl;
      } else {
        faceImg.hidden = true;
        faceImg.removeAttribute("src");
      }
    }
    if (faceStatus) {
      faceStatus.textContent = u.faceRef ? "Face ref saved" : "";
    }
    if (stillImg) {
      if (u.cartoonStillUrl) {
        stillImg.hidden = false;
        stillImg.src = u.cartoonStillUrl;
      } else {
        stillImg.hidden = true;
        stillImg.removeAttribute("src");
      }
    }
    if (stillStatus) {
      stillStatus.textContent = u.cartoonStill ? "Still uploaded" : "";
    }
  }

  function fileToBase64Payload(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.onload = () => {
        const result = String(reader.result || "");
        const m = /^data:([^;]+);base64,(.+)$/i.exec(result);
        if (!m) return reject(new Error("Invalid image data"));
        const mime = m[1].toLowerCase();
        let ext = "png";
        if (mime.includes("jpeg") || mime.includes("jpg")) ext = "jpg";
        else if (mime.includes("webp")) ext = "webp";
        else if (mime.includes("png")) ext = "png";
        resolve({ imageBase64: m[2], ext, mime });
      };
      reader.readAsDataURL(file);
    });
  }

  function applyDescribedFields(fields) {
    if (!fields) return;
    if (fields.appearance != null && $("studioAppearance")) {
      $("studioAppearance").value = fields.appearance;
    }
    if (fields.outfit != null && $("studioOutfit")) {
      $("studioOutfit").value = fields.outfit;
    }
    if (fields.styleTag != null && $("studioStyleTag")) {
      $("studioStyleTag").value = fields.styleTag;
    }
    if (fields.age != null && $("studioAge")) {
      $("studioAge").value = fields.age;
    }
    if (fields.negative != null && $("studioNegative")) {
      $("studioNegative").value = fields.negative;
    }
  }

  async function uploadStudioMaster(kind, file) {
    if (!studioId) return toast("Select a character first", "error");
    if (!file) return;
    try {
      const payload = await fileToBase64Payload(file);
      const count = Number($("studioMasterCount")?.value || 2);
      const label =
        kind === "face_ref"
          ? `Invent master(s) from face photo`
          : `Install cartoon still as master`;
      toast(`${label}… (describing image for outfit/style lock)`);
      setStudioBusy(true);
      const res = await fetch(
        `/api/characters/${encodeURIComponent(studioId)}/master-upload`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            imageBase64: payload.imageBase64,
            ext: payload.ext,
            force: true,
            count,
            autofill: true,
          }),
        },
      );
      const data = await res.json();
      if (!data.ok) {
        setStudioBusy(false);
        return toast(`${label} failed: ${data.error}`, "error");
      }
      if (data.describe?.ok && data.describe.fields) {
        applyDescribedFields(data.describe.fields);
        toast(
          `Prompts autofilled from image (${data.describe.model || "vision"})`,
          "ok",
        );
      } else if (data.describe && !data.describe.ok) {
        toast(
          `Upload OK — prompt autofill skipped: ${data.describe.error}`,
          "error",
        );
      }
      if (data.job) {
        renderStudioJob(data.job);
        startStudioPoll();
      } else {
        await refreshStudioStatus();
        toast(`${label} done`, "ok");
      }
    } catch (err) {
      setStudioBusy(false);
      toast(err.message || String(err), "error");
    }
  }

  $("btnStudioDescribe")?.addEventListener("click", async () => {
    if (!studioId) return toast("Select a character first", "error");
    const st = $("studioDescribeStatus");
    if (st) st.textContent = "Describing…";
    toast("Autofilling prompts from image…");
    setStudioBusy(true);
    try {
      const res = await fetch(
        `/api/characters/${encodeURIComponent(studioId)}/describe`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "auto", save: true }),
        },
      );
      const data = await res.json();
      setStudioBusy(false);
      if (!data.ok) {
        if (st) st.textContent = "Failed";
        return toast(`Describe failed: ${data.error}`, "error");
      }
      applyDescribedFields(data.fields);
      if (st) st.textContent = `Filled via ${data.model || "vision"}`;
      toast("Prompts autofilled — review Appearance / Outfit, then Save", "ok");
      await refreshStudioStatus();
    } catch (err) {
      setStudioBusy(false);
      if (st) st.textContent = "Failed";
      toast(err.message || String(err), "error");
    }
  });

  $("btnStudioMaster")?.addEventListener("click", () => {
    const count = Number($("studioMasterCount")?.value || 1);
    postStudioAction("/master", `Generate ${count} master(s)`, {
      force: true,
      count,
    });
  });
  $("btnStudioFaceRef")?.addEventListener("click", () => {
    $("studioFaceRefFile")?.click();
  });
  $("studioFaceRefFile")?.addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    await uploadStudioMaster("face_ref", file);
  });
  $("btnStudioStill")?.addEventListener("click", () => {
    $("studioStillFile")?.click();
  });
  $("studioStillFile")?.addEventListener("change", async (ev) => {
    const file = ev.target.files?.[0];
    ev.target.value = "";
    await uploadStudioMaster("set_master", file);
  });
  $("btnStudioApprove")?.addEventListener("click", () =>
    postStudioAction("/approve-master", "Approve master"),
  );
  $("btnStudioDataset")?.addEventListener("click", () =>
    postStudioAction("/dataset", "Generate dataset"),
  );
  $("btnStudioTrain")?.addEventListener("click", () =>
    postStudioAction("/train", "Train LoRA"),
  );

  function renderRoomJob(job) {
    const logEl = $("roomLog");
    if (!logEl) return;
    if (!job) {
      logEl.hidden = true;
      logEl.textContent = "";
      return;
    }
    logEl.hidden = false;
    const lines = (job.log || []).slice(-30).map((l) => l.line);
    logEl.textContent = [
      `${job.label || "Room job"}${job.running ? "…" : job.exitCode === 0 ? " ✓" : ` (exit ${job.exitCode})`}`,
      ...lines,
      job.error ? `ERROR: ${job.error}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    logEl.scrollTop = logEl.scrollHeight;
  }

  function startRoomPoll(roomId) {
    if (roomPoll) clearInterval(roomPoll);
    roomPoll = setInterval(async () => {
      const res = await fetch(`/api/scenes/${encodeURIComponent(roomId)}/job`);
      const data = await res.json();
      renderRoomJob(data.job);
      if (!data.job?.running) {
        clearInterval(roomPoll);
        roomPoll = null;
        setupLoaded = false;
        await loadSetupLists();
        log(
          data.job?.exitCode === 0
            ? `Room ${roomId} plate ready`
            : `Room ${roomId} generate finished with errors`,
        );
      }
    }, 2500);
  }

  $("btnCreateRoom")?.addEventListener("click", async () => {
    const name = $("newRoomName")?.value?.trim();
    const still = $("newRoomStill")?.value?.trim();
    if (!name) return log("Room name required");
    if (!still) return log("Room still prompt required");
    const id = $("newRoomId")?.value?.trim() || "";
    const generate = !!$("newRoomGenerate")?.checked;
    log(generate ? `Creating room + generating plate…` : `Creating room…`);
    const res = await fetch("/api/scenes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, still, generate }),
    });
    const data = await res.json();
    if (!data.ok) return log(`Create room failed: ${data.error}`);
    log(`Saved room ${data.room.id}`);
    $("newRoomName").value = "";
    $("newRoomId").value = "";
    $("newRoomStill").value = "";
    setupLoaded = false;
    await loadSetupLists();
    if (data.job) {
      renderRoomJob(data.job);
      startRoomPoll(data.room.id);
    }
  });

  $("setupScenesList")?.addEventListener("click", (ev) => {
    const card = ev.target.closest(".room-card");
    if (!card) return;
    const on = !card.classList.contains("is-on");
    card.classList.toggle("is-on", on);
    card.classList.toggle("is-off", !on);
    card.setAttribute("aria-pressed", on ? "true" : "false");
    state.setup = { ...(state.setup || {}), roomsLockedByUser: true };
    updateRoomsCount();
    scheduleSetupSave();
  });

  $("btnRoomsAll")?.addEventListener("click", () => {
    document.querySelectorAll("#setupScenesList .room-card").forEach((card) => {
      card.classList.add("is-on");
      card.classList.remove("is-off");
      card.setAttribute("aria-pressed", "true");
    });
    state.setup = { ...(state.setup || {}), roomsLockedByUser: true };
    updateRoomsCount();
    scheduleSetupSave();
  });

  $("btnRoomsNone")?.addEventListener("click", () => {
    document.querySelectorAll("#setupScenesList .room-card").forEach((card) => {
      card.classList.remove("is-on");
      card.classList.add("is-off");
      card.setAttribute("aria-pressed", "false");
    });
    state.setup = { ...(state.setup || {}), roomsLockedByUser: true };
    updateRoomsCount();
    scheduleSetupSave();
  });

  async function saveScripts() {
    const beats = collectScriptEdits();
    if (!beats.length) {
      log("No script cards to save");
      return { ok: false };
    }
    const status = $("scriptsSaveStatus");
    if (status) status.textContent = "Saving…";
    const res = await fetch("/api/scripts/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ beats }),
    });
    const data = await res.json();
    if (!data.ok) {
      if (status) status.textContent = data.error || "Save failed";
      log(`Save scripts failed: ${data.error || res.status}`);
      return data;
    }
    if (status) status.textContent = "Saved";
    log(`Saved ${beats.length} shot script(s)`);
    return data;
  }

  async function remakeBeat(beatId, { animate = false } = {}) {
    if (!beatId || remakingBeatId) return;
    const beats = collectScriptEdits();
    remakingBeatId = beatId;
    statusMsg.textContent = `Remaking ${beatId}${animate ? " + clip" : ""}…`;
    log(`Remaking ${beatId}${animate ? " + clip" : ""}…`);
    renderScripts(state.tabs);
    renderKeyframes(state.tabs);
    try {
      const res = await fetch("/api/remake-keyframe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          beatId,
          animate,
          reuseCutouts: true,
          beats,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        log(`Remake failed: ${data.error || res.status}`);
        statusMsg.textContent = `Remake failed: ${data.error || res.status}`;
        return;
      }
      markRemade(data);
      const mt = data.remade?.[0]?.keyframeMtime;
      log(
        `Remake finished: ${beatId}` +
          (mt ? ` · still ${new Date(mt).toLocaleTimeString()}` : " · still updated"),
      );
      statusMsg.textContent = `Remade ${beatId} — open Keyframes to compare`;
      selectTab(animate ? "clips" : "keyframes");
      requestAnimationFrame(() => {
        const card = document.querySelector(
          `.kf-card[data-beat="${CSS.escape(beatId)}"]`,
        );
        card?.scrollIntoView({ behavior: "smooth", block: "center" });
        card?.classList.add("just-remade-pulse");
      });
    } finally {
      remakingBeatId = null;
      renderScripts(state.tabs);
      renderKeyframes(state.tabs);
    }
  }

  async function deleteClip({ name, stem, beatId } = {}) {
    if (!name && !stem && !beatId) return;
    const label = name || stem || beatId;
    if (!confirm(`Delete clip ${label}?`)) return;
    log(`Deleting clip ${label}…`);
    const res = await fetch("/api/delete-clips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ names: name ? [name] : null, stems: stem ? [stem] : null, beatId }),
    });
    const data = await res.json();
    if (!data.ok) {
      log(`Delete failed: ${data.error || res.status}`);
      return;
    }
    log(`Deleted ${data.deleted?.join(", ") || label} · ${data.remaining ?? "?"} left`);
    selectTab("clips");
  }

  $("btnSaveScripts")?.addEventListener("click", () => {
    saveScripts();
  });

  document.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const beat = btn.dataset.beat;
    if (act === "goto-kf" || act === "edit-script") {
      if (act === "edit-script") selectTab("scripts");
      else selectTab("keyframes");
      if (act === "goto-kf") {
        selectTab("keyframes");
        const card = document.querySelector(`.kf-card[data-beat="${CSS.escape(beat)}"]`);
        card?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      if (act === "edit-script") {
        const card = document.querySelector(`.shot-card[data-beat-id="${CSS.escape(beat)}"]`);
        card?.scrollIntoView({ behavior: "smooth", block: "center" });
        card?.querySelector("[data-f=lyricHint]")?.focus();
      }
      return;
    }
    if (act === "remake") {
      remakeBeat(beat, { animate: false });
      return;
    }
    if (act === "remake-clip") {
      remakeBeat(beat, { animate: true });
      return;
    }
    if (act === "delete-clip") {
      deleteClip({
        name: btn.dataset.name,
        stem: btn.dataset.stem,
        beatId: beat,
      });
    }
  });

  btnApprove.addEventListener("click", async () => {
    const gate = waitingGate();

    // Idle / browsing: Continue an open batch, or start a brand-new project
    if (!gate) {
      if (!canStartFromSetup()) return;
      const idleAction = idlePrimaryAction();
      if (idleAction?.kind === "continue") {
        btnApprove.disabled = true;
        try {
          const res = await fetch("/api/continue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              fromStage: state.progress?.nextTab || state.progress?.furthestTab || null,
            }),
          });
          const data = await res.json();
          if (!data.ok) {
            log(`Continue failed: ${data.error || res.status}`);
            updateButtons();
            return;
          }
          log(
            data.resumed
              ? `Resumed pipeline`
              : `Continuing from ${state.progress?.nextLabel || state.progress?.furthestLabel || "next stage"}…`,
          );
        } catch (err) {
          log(`Continue failed: ${err.message || err}`);
          updateButtons();
        }
        return;
      }
      const payload = collectSetupPayload();
      if (!payload.castIds?.length) {
        log("Pick at least one cast member");
        return;
      }
      if (!payload.locationIds?.length) {
        log("Pick at least one room");
        return;
      }
      btnApprove.disabled = true;
      try {
        await persistSetupDraft();
        // When await_setup appears, approve it once with this payload
        state._pendingSetupStart = payload;
        const res = await fetch("/api/new-project", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!data.ok) {
          state._pendingSetupStart = null;
          log(`Start failed: ${data.error || res.status}`);
          updateButtons();
          return;
        }
        log("Starting new project with current cast & rooms…");
        selectTab("setup");
        // If setup gate is already up (fast path), approve immediately
        setTimeout(() => maybeApprovePendingSetup(), 50);
      } catch (err) {
        state._pendingSetupStart = null;
        log(`Start failed: ${err.message || err}`);
        updateButtons();
      }
      return;
    }

    const payload = {};
    if (gate === "setup") Object.assign(payload, collectSetupPayload());
    if (gate === "lyrics") payload.text = lyricsText.value;
    if (gate === "plan") {
      // Prefer raw JSON; if shot cards edited, merge those fields into raw first
      try {
        const edits = collectScriptEdits();
        if (edits.length && planRaw.value.trim()) {
          const plan = JSON.parse(planRaw.value);
          const byId = new Map(edits.map((e) => [e.id, e]));
          plan.beats = (plan.beats || []).map((b) => {
            const e = byId.get(b.id);
            if (!e) return b;
            return {
              ...b,
              ...Object.fromEntries(
                Object.entries(e).filter(([k, v]) => k !== "id" && v != null && v !== ""),
              ),
            };
          });
          planRaw.value = JSON.stringify(plan, null, 2);
        }
      } catch {
        /* keep planRaw as-is */
      }
      payload.raw = planRaw.value;
    }
    if (gate === "setup" && !payload.castIds?.length) {
      log("Pick at least one cast member");
      return;
    }
    if (gate === "setup" && !payload.locationIds?.length) {
      log("Pick at least one room");
      return;
    }
    btnApprove.disabled = true;
    btnReject.disabled = true;
    const res = await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: gate, payload }),
    });
    const data = await res.json();
    if (!data.ok) {
      log(`Approve failed: ${data.error || res.status}`);
      updateButtons();
    } else {
      log(`Approved ${gate}`);
      lyricsText.dataset.touched = "";
    }
  });

  async function maybeApprovePendingSetup() {
    if (!state._pendingSetupStart) return;
    const gate = waitingGate();
    // Auto-approve (or a prior click) may already have left setup — drop quietly
    if (gate !== "setup") {
      if (gate || state.stage === "lyrics" || state.stage?.startsWith("lyrics")) {
        state._pendingSetupStart = null;
      }
      return;
    }
    const payload = state._pendingSetupStart;
    state._pendingSetupStart = null;
    try {
      const res = await fetch("/api/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage: "setup", payload }),
      });
      const data = await res.json();
      if (!data.ok) {
        // Harmless if the server already auto-approved setup
        if (/not waiting on setup/i.test(data.error || "")) return;
        log(`Setup approve failed: ${data.error || res.status}`);
        updateButtons();
      } else {
        log("Approved setup");
      }
    } catch (err) {
      log(`Setup approve failed: ${err.message || err}`);
      updateButtons();
    }
  }

  btnReject.addEventListener("click", async () => {
    const gate = waitingGate();
    if (!gate) return;
    btnApprove.disabled = true;
    btnReject.disabled = true;
    const res = await fetch("/api/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stage: gate }),
    });
    const data = await res.json();
    if (!data.ok) {
      log(`Regenerate failed: ${data.error || res.status}`);
      updateButtons();
    } else {
      log(`Regenerate ${gate}`);
      lyricsText.dataset.touched = "";
    }
  });

  const es = new EventSource("/events");
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "log") log(msg.message);
      else if (msg.type === "log-history") applyLogHistory(msg.lines);
      else if (msg.type === "brief") {
        if (msg.setup || msg.title) {
          state.setup = { ...(state.setup || {}), ...(msg.setup || msg) };
          applyBriefToForm(msg.setup || msg);
        }
      } else if (msg.type === "character-job") {
        if (msg.id && msg.id === studioId) {
          renderStudioJob(msg);
          if (!msg.running) {
            studioSlideshowRemaking = false;
            refreshStudioStatus();
            if (msg.exitCode === 0) toast(`${msg.label || "Job"} finished`, "ok");
            else if (msg.exitCode != null) {
              const errText = msg.error || `exit ${msg.exitCode}`;
              toast(`${msg.label || "Job"} failed: ${errText}`, "error");
              const hint = $("datasetLightboxHint");
              if (hint && !$("datasetLightbox")?.hidden) {
                hint.textContent = errText;
              }
            }
            syncLightboxUi();
          } else {
            setStudioBusy(true);
            startStudioPoll();
          }
        }
      } else if (msg.type === "tabs") {
        state.tabs = msg.tabs;
        if (msg.progress) state.progress = msg.progress;
        renderAll(msg.tabs);
      } else if (msg.type === "remake_done") {
        markRemade(msg);
        log(
          `Still updated: ${(msg.only || []).join(", ")}` +
            (msg.animate ? " (+ clip)" : ""),
        );
        if (state.tabs) {
          renderKeyframes(state.tabs);
          renderScripts(state.tabs);
          if (msg.animate) renderClips(state.tabs);
        }
        const id = msg.only?.[0];
        if (id) {
          selectTab(msg.animate ? "clips" : "keyframes");
          requestAnimationFrame(() => {
            const card = document.querySelector(
              `.kf-card[data-beat="${CSS.escape(id)}"]`,
            );
            card?.scrollIntoView({ behavior: "smooth", block: "center" });
          });
        }
      } else if (msg.type === "clips_deleted") {
        log(`Clips deleted: ${(msg.deleted || []).join(", ")}`);
      } else if (msg.type === "gpu") {
        state.gpu = msg;
        if ($("gpuBackend") && msg.backend) $("gpuBackend").value = msg.backend;
        log(`GPU: ${msg.backend} → ${msg.comfyUrl}`);
      } else if (msg.type === "resolution") {
        state.outputResolution = msg.outputResolution;
        if ($("outputResolution") && msg.outputResolution) {
          $("outputResolution").value = msg.outputResolution;
        }
      } else if (msg.type === "stage" || msg.type === "state" || msg.type === "auto_approve") {
        applyState(msg);
        if (msg.message) log(msg.message);
        if (msg.type === "state") refreshBatchPicker();
      }
    } catch (err) {
      console.warn(err);
    }
  };
  es.onerror = () => log("SSE disconnected — retrying…");

  restoreLogsFromSession();
  applyState(state);
  renderAll(state.tabs || {});
  refreshBatchPicker();
  log("Connected to mvid GUI");
  refreshSaladStatus();
  refreshMetrics();
  setInterval(refreshMetrics, 2000);
  setInterval(refreshSaladStatus, 30000);
})();
