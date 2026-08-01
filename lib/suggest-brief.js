/**
 * Instant song brief for Setup: theme + title + objective + default rooms.
 */
import {
  HOME_THEMES,
  KIDS_HIT_STYLES,
  kidsHitMood,
  kidsHitLocationPalette,
} from "./kids-hit.js";
import { objectiveForTheme } from "./kids-hit-continuity.js";

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function titleCase(s) {
  return String(s || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

/** Punchy preschool titles derived from a theme string. */
function titlesForTheme(theme) {
  const raw = String(theme || "").trim();
  const core = raw
    .replace(/\bwith mom\b/gi, "")
    .replace(/\bat home\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const base = titleCase(core || raw);
  const first = base.split(" ")[0] || "Home";
  const out = [
    base,
    `The ${base}`,
    `${base} Fun`,
    `Let's ${base}`,
    `${first} Time`,
    `${base} Song`,
  ];
  if (/rain/i.test(raw)) out.push("Rainy Day March", "March Inside");
  if (/bed|yawn|teeth|story|night/i.test(raw))
    out.push("Bedtime Stretch", "Cozy Night", "Almost Asleep");
  if (/wash|hands|kitchen/i.test(raw))
    out.push("Wash Wash Wash", "Clean Hands Ready");
  if (/tidy|toys|share/i.test(raw)) out.push("Tidy Up Time", "Toys Away");
  if (/stomp|clap/i.test(raw)) out.push("Stomp and Clap", "Clap Along");
  if (/dance|freeze/i.test(raw)) out.push("Dance Then Freeze", "Freeze Dance");
  if (/stretch|morning|hello/i.test(raw))
    out.push("Morning Hello", "Wake Up Stretch");
  if (/shoes|lawn|outside|hop/i.test(raw))
    out.push("Shoes On", "Outside We Go");
  if (/mom/i.test(raw)) out.push(`${base} with Mom`, "Mom and Me");
  if (/porch|wave/i.test(raw)) out.push("Porch Wave", "Wave Hello");
  return [...new Set(out.filter(Boolean))];
}

/**
 * Default rooms for a theme (story rooms only — no doorway/hallway filler).
 * Caps at 3 so setup stays focused; user can add more manually.
 */
export function roomsForTheme(theme, { max = 3 } = {}) {
  const t = String(theme || "").toLowerCase();
  // Wash songs: lock kitchen + sink + home for celebration (order matters for journey)
  if (/wash|hands|soap|kitchen|scrub|rinse/.test(t)) {
    return ["kitchen", "kitchen_sink", "home"].slice(0, Math.max(1, max));
  }
  const palette = kidsHitLocationPalette(theme, []);
  const story = palette.filter(
    (id) => !/^(doorway|hallway)$/i.test(String(id)),
  );
  const picks = (story.length ? story : palette).slice(0, Math.max(1, max));
  return picks.length ? picks : ["home"];
}

/**
 * @param {{ avoidTheme?: string, avoidTitle?: string }} [opts]
 */
export function suggestBrief(opts = {}) {
  const pool = HOME_THEMES.filter((t) => t !== opts.avoidTheme);
  const theme = pick(pool.length ? pool : HOME_THEMES);
  const titles = titlesForTheme(theme).filter((t) => t !== opts.avoidTitle);
  const title = pick(titles.length ? titles : titlesForTheme(theme));
  const objective = objectiveForTheme(theme);
  const mood = kidsHitMood(theme);
  const styles =
    mood === "calm"
      ? KIDS_HIT_STYLES.filter((s) => /lullaby|soft|quiet|gentle|bedtime/i.test(s))
      : KIDS_HIT_STYLES.filter((s) => !/lullaby|bedtime|quiet/i.test(s));
  const style = pick(styles.length ? styles : KIDS_HIT_STYLES);
  const locationIds = roomsForTheme(theme);
  return {
    title,
    theme,
    objective,
    style,
    mood,
    locationIds,
  };
}
