// Song Map loading + shared music helpers.

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set([1, 3, 6, 8, 10]); // pitch classes that are black keys

export function midiToName(m) {
  return `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;
}

export function isBlack(m) {
  return BLACK.has(m % 12);
}

// Stable, readable colour per pitch class (chromatic hue wheel).
export function pcColor(m, alpha = 1) {
  const hue = (m % 12) * 30; // 12 classes across 360deg
  return `hsla(${hue}, 75%, 58%, ${alpha})`;
}

// Load a Song Map and resolve its audio path relative to the map's location.
// cache:"no-cache" = always revalidate — Save (§19) rewrites the map on disk and reloads,
// and a heuristically-cached copy would silently show the pre-edit song.
// A shareable (zip) player runs from file://, where fetch is blocked — there the Generator
// embeds the map as window.PC_EMBED_SONG and we skip the network entirely (mapUrl still
// gives the base for resolving the bundled audio paths).
export async function loadSong(mapUrl) {
  let map;
  if (window.PC_EMBED_SONG) {
    map = window.PC_EMBED_SONG;
  } else {
    const res = await fetch(mapUrl, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Could not load song map: ${res.status} ${mapUrl}`);
    map = await res.json();
  }
  // PC_EMBED_BASE: the standalone player's audio folder, independent of the ?song= query
  // (some file:// navigations drop the query — the map is embedded, but audio paths need this).
  const base = window.PC_EMBED_BASE || mapUrl.slice(0, mapUrl.lastIndexOf("/") + 1);
  map._audioUrl = new URL(base + map.audio, window.location.href).href;
  if (map.reference?.audio) {
    map.reference._audioUrl = new URL(base + map.reference.audio, window.location.href).href;
  }
  (map.levels || []).forEach((L) => {
    if (L.audio) L._audioUrl = new URL(base + L.audio, window.location.href).href;
  });

  // Derived pitch range across all note events (for keyboard / roll extents).
  let lo = 127, hi = 0;
  const scan = (arr) => (arr || []).forEach((n) => {
    lo = Math.min(lo, n.midi ?? n.notes?.[0] ?? lo);
    hi = Math.max(hi, n.midi ?? n.notes?.[n.notes.length - 1] ?? hi);
  });
  scan(map.melody);
  scan(map.accompaniment);
  (map.chords || []).forEach((c) => (c.notes || []).forEach((p) => {
    lo = Math.min(lo, p); hi = Math.max(hi, p);
  }));
  // Pad to whole octaves and a comfortable minimum span.
  map._range = { lo: Math.min(lo, 48), hi: Math.max(hi, 72) };

  annotateLevels(map);
  return map;
}

// Level-engine ranking (§17): rank melody by pitch-class first appearance, chords by root
// first appearance, and derive chord-tone events for rendering.
function annotateLevels(map) {
  const pc = (m) => ((m % 12) + 12) % 12;

  const noteRank = new Map();                       // pitch class -> rank (first appearance)
  [...(map.melody || [])].sort((a, b) => a.t0 - b.t0).forEach((n) => {
    const k = pc(n.midi);
    if (!noteRank.has(k)) noteRank.set(k, noteRank.size + 1);
  });
  (map.melody || []).forEach((n) => { n.noteRank = noteRank.get(pc(n.midi)); n.part = "melody"; });
  map._noteCount = noteRank.size;

  const chordRank = new Map();                      // root pitch class -> rank
  [...(map.chords || [])].sort((a, b) => a.t0 - b.t0).forEach((c) => {
    const k = pc(c.notes?.[0] ?? 0);
    if (!chordRank.has(k)) chordRank.set(k, chordRank.size + 1);
  });
  (map.chords || []).forEach((c) => { c.chordRank = chordRank.get(pc(c.notes?.[0] ?? 0)); });
  map._chordCount = chordRank.size;

  map._chordNotes = [];                             // chord tones as note events, for the charts
  (map.chords || []).forEach((c) => (c.notes || []).forEach((midi) => {
    map._chordNotes.push({
      t0: c.t0, t1: c.t1, midi, name: midiToName(midi), part: "chord",
      chordRank: c.chordRank, clef: "bass", hand: "L",
    });
  }));
}

// Visible-at-level filter (§17): melody by noteRank, chords by chordRank.
export function visibleAtLevel(n, melodyMax, chordMax) {
  if (n.part === "chord") return n.chordRank <= chordMax;
  return n.noteRank <= melodyMax;
}

// Faded-peek (§17b): unlocked notes at full strength, not-yet-unlocked notes dimmed so the
// learner glimpses what's coming rather than having it hidden.
export const LOCKED_ALPHA = 0.2;
export function levelFade(n, melodyMax, chordMax) {
  return visibleAtLevel(n, melodyMax, chordMax) ? 1 : LOCKED_ALPHA;
}

// All note events that are "active" at time t (with a small look-ahead in pxlead handled by renderer).
export function activeNotes(events, t) {
  return events.filter((n) => t >= n.t0 && t < n.t1);
}

export function activeChord(chords, t) {
  return chords.find((c) => t >= c.t0 && t < c.t1) || null;
}
