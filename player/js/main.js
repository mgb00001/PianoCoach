import { loadSong, activeNotes, activeChord, visibleAtLevel } from "./songmap.js";
import { Transport } from "./transport.js";
import { KeyboardRenderer } from "./renderers/keyboard.js";
import { PianoRollRenderer } from "./renderers/pianoroll.js";
import { NotationRenderer } from "./renderers/notation.js";
import { LyricsRenderer } from "./renderers/lyrics.js";
import { EditablePianoRollRenderer } from "./renderers/editablepianoroll.js";

// §19 Edit mode: 5th "Edit" chart mode, GENERATOR-PREVIEW ONLY. Enabled only when the
// generator embeds the player with ?edit=1. The standalone shareable player never sets it,
// so the Edit mode + Save button simply never appear (that's the generator-only guard).
const EDIT = new URLSearchParams(location.search).has("edit");

const DEFAULT_SONG = "../samples/demo_all_out_of_love/song_map.json";
const LOOKAHEAD = 0.45;                       // seconds of "upcoming note" glow
const DPR = Math.min(window.devicePixelRatio || 1, 2);

const $ = (id) => document.getElementById(id);
const state = { mode: "keyboard", zoom: 120, level: 1, melodyMax: 2, chordMax: 0 };

// §17 fixed level table: how many melody notes (pitch classes) + chord roots are revealed.
const INF = Infinity;
const LEVEL_TABLE = [
  { level: 1, mel: 2, chord: 0 }, { level: 2, mel: 4, chord: 0 },
  { level: 3, mel: 6, chord: 0 }, { level: 4, mel: 8, chord: 0 },
  { level: 5, mel: 10, chord: 1 }, { level: 6, mel: INF, chord: 2 },
  { level: 7, mel: INF, chord: 3 }, { level: 8, mel: INF, chord: 4 },
  { level: 9, mel: INF, chord: 5 }, { level: 10, mel: INF, chord: 6 },
];
let notationRef = null;
let editor = null;   // §19 EditablePianoRollRenderer (generator preview only)
let editDirty = false;
let editScrub = null;      // edit-mode vertical time scrubber
let editScrubbing = false; // user is dragging the scrubber (don't fight it from the frame loop)
let app = null; // { transport, song, secPerBar, halfBar, LOOP_BARS, ... }
let _lastBeat = -1;

const LOOP_BARS = 2;

boot();

async function boot() {
  const url = new URLSearchParams(location.search).get("song") || DEFAULT_SONG;
  let song;
  try {
    song = await loadSong(url);
  } catch (e) {
    document.body.insertAdjacentHTML("beforeend",
      `<pre style="position:fixed;inset:20px;color:#f66;background:#111;padding:20px;overflow:auto">${e.message}</pre>`);
    throw e;
  }

  // header
  $("song-title").textContent = `${song.title}${song.artist ? " — " + song.artist : ""}`;
  $("song-key").textContent = `${song.key.tonic} ${song.key.mode}`;
  $("song-tempo").textContent = `${song.tempo.bpm} BPM · ${song.time_signature}`;
  $("synthetic-badge").hidden = !song.synthetic;
  populateLevels(song);

  const transport = new Transport(song._audioUrl, song);
  transport.setVolume(+$("volume").value);

  const beatsPerBar = parseInt((song.time_signature || "4/4").split("/")[0], 10) || 4;
  const secPerBar = (60 / song.tempo.bpm) * beatsPerBar;
  const totalBars = Math.max(1, ...(song.beats || [{ bar: 1 }]).map((b) => b.bar));
  app = { transport, song, secPerBar, secPerBeat: secPerBar / beatsPerBar, beatsPerBar,
          halfBar: secPerBar / 2, totalBars, LOOP_BARS };
  $("bc-total") && ($("bc-total").textContent = ` / ${totalBars}`);

  const renderers = {
    keyboard: new KeyboardRenderer($("kbd-canvas"), song),
    pianoroll: new PianoRollRenderer($("roll-canvas"), song),
  };
  const notation = {
    clef: makeNotation("clef", song, true),
    score: makeNotation("score", song, false),
  };
  notationRef = notation;

  // §19 Edit mode — only wired when the generator embeds us with ?edit=1.
  if (EDIT) {
    editor = new EditablePianoRollRenderer($("edit-canvas"), song, () => { editDirty = true; });
    renderers.edit = editor;
    setupEditMode(transport, song);
  }

  wireControls(transport, song);

  const lyrics = new LyricsRenderer($("lyrics-ribbon"), song);
  if (!lyrics.hasLyrics()) {
    $("btn-lyrics").style.display = "none";
  }
  $("btn-lyrics").addEventListener("click", (e) => {
    const show = $("lyrics-ribbon").hidden;      // currently hidden -> turn on
    $("lyrics-ribbon").hidden = !show;
    e.currentTarget.classList.toggle("active", show);
    if (show) lyrics.update(transport.time);
    layoutActive();                              // stage resized -> relayout active chart
  });

  // Compare / preview the original recording (§15). Reference becomes master while on.
  if (!transport.hasReference()) {
    $("btn-compare").style.display = "none";
  }
  $("btn-compare").addEventListener("click", (e) => {
    const on = !e.currentTarget.classList.contains("active");
    e.currentTarget.classList.toggle("active", on);
    transport.setPreview(on);
  });

  // Level engine: switch backing track + task on level change
  $("level").addEventListener("change", (e) => applyLevel(+e.target.value));
  applyLevel(+$("level").value || 1);

  layoutActive();
  window.addEventListener("resize", layoutActive);
  transport.audio.addEventListener("loadedmetadata", () => updateReadout(transport));
  transport.audio.addEventListener("ended", () => setPlayIcon(false));

  // Restore edit mode + position after a Save-triggered reload (§ point 3).
  if (EDIT) {
    let restore = null;
    try { restore = JSON.parse(sessionStorage.getItem("pc_restore") || "null"); } catch (_) { /* ignore */ }
    if (restore && restore.mode) {
      sessionStorage.removeItem("pc_restore");
      const btn = document.querySelector(`.mode-btn[data-mode="${restore.mode}"]`);
      if (btn) btn.click();
      if (restore.t) {
        const seekBack = () => { transport.seek(restore.t); editor && editor.scrollToTime(restore.t); };
        if (transport.audio.readyState >= 1) seekBack();
        else transport.audio.addEventListener("loadedmetadata", seekBack, { once: true });
      }
    }
  }

  requestAnimationFrame(function frame() {
    transport.tick();
    const t = transport.time;

    // keyboard: unlocked notes light bright (active/soon); locked-but-playing light faded (§17b peek)
    const activeMidi = [], soonMidi = [], fadedMidi = [];
    for (const n of [...(song.melody || []), ...(song._chordNotes || [])]) {
      const on = t >= n.t0 && t < n.t1;
      if (visibleAtLevel(n, state.melodyMax, state.chordMax)) {
        if (on) activeMidi.push(n.midi);
        else if (n.t0 > t && n.t0 <= t + LOOKAHEAD) soonMidi.push(n.midi);
      } else if (on) {
        fadedMidi.push(n.midi);
      }
    }

    try {
      if (state.mode === "clef" || state.mode === "score") {
        notation[state.mode].updateCursor(t);
      } else {
        const rstate = { time: t, activeMidi, soonMidi, fadedMidi, zoom: state.zoom, loop: transport.loop,
                         melodyMax: state.melodyMax, chordMax: state.chordMax, playing: transport.playing,
                         rate: transport._rate || 1 };
        const r = renderers[state.mode];
        if (r) r.render(rstate, DPR);
      }
      if (EDIT && state.mode === "edit") syncEditScrub(t);
    } catch (err) {
      console.error("render error in mode", state.mode, err);
      window.PC && (window.PC.lastError = String(err && err.stack || err));
    }

    updateReadout(transport);
    updateBarReadout();
    updateBeatUI(t);
    if (!$("lyrics-ribbon").hidden) lyrics.update(t);
    requestAnimationFrame(frame);
  });

  // expose for debugging / preview automation
  window.PC = { transport, song, state, notation, renderers, lyrics };
}

// §19 Edit mode wiring (generator preview only). Injects the 5th "Edit" mode button
// (picked up by wireControls' generic .mode-btn handler) and a Save button that POSTs the
// edited melody to /api/edit → re-synth → reload the preview. Entering edit pauses playback.
function setupEditMode(transport, song) {
  const modebar = $("modebar");

  const editBtn = document.createElement("button");
  editBtn.className = "mode-btn";
  editBtn.dataset.mode = "edit";
  editBtn.textContent = "✏️ Edit";
  modebar.appendChild(editBtn);
  editBtn.addEventListener("click", () => {           // static editor → stop playback
    if (transport.playing) { transport.pause(); setPlayIcon(false); }
    layoutActive();                                    // size the edit canvas now it's visible
  });

  // Edit actions: Undo + Copy/Cut/Paste. Keyboard equivalents live in the editor (Ctrl+Z/C/X/V).
  const mkBtn = (id, text, title) => {
    const b = document.createElement("button");
    b.id = id; b.textContent = text; b.title = title; b.disabled = true;
    modebar.appendChild(b);
    return b;
  };
  const undoBtn = mkBtn("btn-undo-edit", "↶ Undo",
    "Undo the last edit (Ctrl+Z). Ctrl+click to undo everything back to the last save.");
  const copyBtn = mkBtn("btn-copy-edit", "⧉ Copy",
    "Duplicate the highlighted notes in place (Ctrl+C), then arrow the copies to their new spot");
  // Ctrl/⌘+click Undo = revert the whole session back to the last save.
  // blur(): a clicked button keeps keyboard focus, so a later Enter/Space re-fires it —
  // e.g. Enter after Copy silently stamped extra duplicates.
  undoBtn.addEventListener("click", (e) => {
    if (e.ctrlKey || e.metaKey) editor.undoAll(); else editor.undo();
    undoBtn.blur();
  });
  copyBtn.addEventListener("click", () => { editor.copy(); copyBtn.blur(); });

  // Accompaniment instrument — applies on Save (the backing track is re-synthesised server-side).
  const instSel = document.createElement("select");
  instSel.id = "edit-instrument";
  instSel.title = "Accompaniment instrument — applies when you save (re-synthesises the backing track)";
  instSel.innerHTML = '<option value="grand">🎹 Grand piano</option>' +
                      '<option value="rhodes">🎹 Rhodes</option>';
  instSel.value = song.instrument === "rhodes" ? "rhodes" : "grand";
  const instSaved = instSel.value;                     // as on disk — differs ⇒ pending edit
  modebar.appendChild(instSel);
  instSel.addEventListener("change", () => { instSel.blur(); editor.onEditState(); });

  editor.onEditState = () => {
    undoBtn.disabled = !editor.canUndo();
    copyBtn.disabled = !editor.canCopy();
    // blink Save while anything (note edits or instrument) differs from the last save
    saveBtn.classList.toggle("pending", editor.canUndo() || instSel.value !== instSaved);
  };

  // Live play-scrub: dragging/wheeling the roll while playing nudges the song (seek); the editor
  // keeps the now-line locked. Wired here so the editor can reach the transport.
  editor.onNudge = (deltaSeconds) => {
    const d = transport.duration || 0;
    let t = transport.time + deltaSeconds;
    if (d) t = Math.max(0, Math.min(t, d));
    transport.seek(t);
  };

  // Horizontal scrubber, placed alongside the bar counter so the bar reads live as you drag.
  // Fast back-and-forth over a tricky bar; works while playing (drag to nudge without pausing).
  const scrubWrap = document.createElement("div");
  scrubWrap.className = "edit-scrub-wrap";
  scrubWrap.id = "edit-scrub-wrap";
  scrubWrap.innerHTML =
    '<span class="edit-scrub-lbl">Start</span>' +
    '<input id="edit-scrub" class="edit-scrub" type="range" min="0" max="1000" step="1" value="0"' +
    ' title="Scrub / nudge through the song (works while playing)">' +
    '<span class="edit-scrub-lbl">End</span>';
  (document.querySelector(".topbar") || modebar).appendChild(scrubWrap);   // next to #bar-counter
  editScrub = scrubWrap.querySelector("#edit-scrub");
  const seekFromScrub = () => {
    const dur = songDuration();
    if (!dur) return;
    const tt = (+editScrub.value / 1000) * dur;
    transport.seek(tt);
    editor.scrollToTime(tt);          // move the view immediately (paused = no auto-scroll)
    editor.render(editor._lastState, DPR);
    updateBarReadout();
  };
  editScrub.addEventListener("pointerdown", () => { editScrubbing = true; });
  editScrub.addEventListener("input", seekFromScrub);
  window.addEventListener("pointerup", () => { editScrubbing = false; });

  const saveBtn = document.createElement("button");
  saveBtn.id = "btn-save-edit";
  saveBtn.textContent = "💾 Save edits";
  saveBtn.title = "Rewrite the melody + re-synth the backing track, then reload the preview";
  saveBtn.style.cssText = "margin-left:auto;background:#2a8a5f;color:#fff;font-weight:600;";
  modebar.appendChild(saveBtn);
  saveBtn.addEventListener("click", async () => {
    saveBtn.blur();                                    // Enter later must not re-save
    const songUrl = new URLSearchParams(location.search).get("song") || "";
    const m = songUrl.match(/samples\/([^/]+)\//);
    if (!m) { alert("Can't determine the song slug from the URL."); return; }
    saveBtn.disabled = true; saveBtn.textContent = "Saving…";
    try {
      let r;
      try {
        r = await fetch(`/api/edit/${m[1]}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ melody: editor.getMelody(), instrument: instSel.value }),
        });
      } catch (netErr) {
        throw new Error("Couldn't reach the Generator backend. Saving edits needs the PianoCoach " +
                        "Generator (webgen) running — it doesn't work on the static player server.");
      }
      // A static file server answers POST with a non-JSON 501/404 page → give a clear reason.
      const ct = r.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        const snippet = (await r.text()).replace(/\s+/g, " ").slice(0, 160);
        throw new Error(`The backend didn't handle the save (HTTP ${r.status}). Saving needs the ` +
                        `PianoCoach Generator (webgen) running, not the static player server.` +
                        (snippet ? `\n\nServer said: ${snippet}` : ""));
      }
      const j = await r.json();
      if (j.ok) {
        editDirty = false;
        // Re-synth requires a reload; remember to land back in Edit mode at the same spot.
        try {
          sessionStorage.setItem("pc_restore", JSON.stringify({ mode: "edit", t: transport.time }));
        } catch (_) { /* private mode — just reload */ }
        location.reload();
      } else throw new Error(j.detail || "unknown error");
    } catch (e) {
      alert("Save failed: " + e.message);
      saveBtn.disabled = false; saveBtn.textContent = "💾 Save edits";
    }
  });

  applyEditChrome();                                   // set the initial (non-edit) chrome state
}

// Edit mode is a full-song editor: the learner levels (note/chord reveal + faded peek) don't
// apply, so hide the Level control + banner while editing, and show Undo/Save only there.
function applyEditChrome() {
  const inEdit = state.mode === "edit";
  const levelCtl = $("level") && $("level").closest(".ctl");
  if (levelCtl) levelCtl.style.display = inEdit ? "none" : "";
  const banner = $("level-task");
  if (banner) banner.style.display = inEdit ? "none" : "";
  const scrubWrap = $("edit-scrub-wrap");
  ["btn-undo-edit", "btn-copy-edit", "edit-instrument", "btn-save-edit"]
    .forEach((id) => { const b = $(id); if (b) b.style.display = inEdit ? "" : "none"; });
  if (scrubWrap) scrubWrap.style.display = inEdit ? "" : "none";
}

// Keep the edit-mode scrubber thumb in step with playback (unless the user is dragging it).
function syncEditScrub(t) {
  if (!editScrub || editScrubbing) return;
  const dur = songDuration();
  if (dur) editScrub.value = String(Math.round((t / dur) * 1000));
}

function wireControls(transport, song) {
  $("btn-play").addEventListener("click", async () => {
    await transport.toggle();
    setPlayIcon(transport.playing);
  });
  $("btn-reset").addEventListener("click", () => { transport.reset(); });

  $("tempo").addEventListener("input", (e) => {
    transport.setRate(+e.target.value);
    $("tempo-val").textContent = e.target.value + "%";
  });
  $("volume").addEventListener("input", (e) => transport.setVolume(+e.target.value));
  $("zoom").addEventListener("input", (e) => { state.zoom = +e.target.value; });

  $("btn-metro").addEventListener("click", (e) => {
    const on = !e.currentTarget.classList.contains("active");
    e.currentTarget.classList.toggle("active", on);
    transport.setMetronome(on);
  });

  $("btn-loop").addEventListener("click", (e) => {
    const on = !e.currentTarget.classList.contains("active");
    e.currentTarget.classList.toggle("active", on);
    if (on) {
      applyLoopFrom(snapHalf(transport.time));       // 2-bar window from current position
      transport.audio.currentTime = transport.loop.a;
    } else {
      transport.setLoop(null);
    }
    updateBarReadout();
  });

  // Nudge the cursor ± half a bar (snapped). The 2-bar loop follows if active.
  $("btn-nudge-fwd").addEventListener("click", () => nudge(+1));
  $("btn-nudge-back").addEventListener("click", () => nudge(-1));

  $("btn-theme").addEventListener("click", () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  });

  document.querySelectorAll(".mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.mode = btn.dataset.mode;
      document.querySelectorAll(".chart").forEach((c) => {
        c.hidden = c.dataset.chart !== state.mode;
      });
      if (EDIT) applyEditChrome();                     // levels don't apply while editing
      layoutActive();
    });
  });
}

// §17 level engine: a level is a DISPLAY FILTER over one full accompaniment.
function levelName(def, song) {
  const notes = (def.mel === INF || def.mel >= (song._noteCount || 0)) ? "All notes" : `${def.mel} notes`;
  if (def.chord === 0) return notes;
  const nChords = Math.min(def.chord, song._chordCount || def.chord);
  return `${notes} + ${nChords} chord${nChords > 1 ? "s" : ""}`;
}

function populateLevels(song) {
  $("level").innerHTML = LEVEL_TABLE
    .map((d) => `<option value="${d.level}">${d.level} · ${levelName(d, song)}</option>`).join("");
}

// Switch levels: update the display filter (melody notes + chord roots revealed) + banner.
function applyLevel(levelNum) {
  const def = LEVEL_TABLE.find((d) => d.level === levelNum) || LEVEL_TABLE[0];
  state.level = levelNum;
  state.melodyMax = def.mel;
  state.chordMax = def.chord;

  if (notationRef) {                                 // notation renders once -> re-render filtered
    notationRef.clef.setFilter(def.mel, def.chord);
    notationRef.score.setFilter(def.mel, def.chord);
    if (state.mode === "clef" || state.mode === "score") layoutActive();
  }
  const banner = $("level-task");
  if (banner) {
    banner.hidden = false;
    banner.innerHTML =
      `<span class="lt-num">Level ${levelNum}</span>` +
      `<span class="lt-name">${levelName(def, app.song)}</span>` +
      `<span class="lt-play">— repeat until it's effortless</span>`;
  }
}

// ---- loop + half-bar nudge ---------------------------------------------------
function songDuration() { return app.transport.duration || app.song.source?.duration_s || 0; }
function snapHalf(t) { return Math.round(t / app.halfBar) * app.halfBar; }

function applyLoopFrom(start) {
  const dur = songDuration();
  const maxStart = dur ? Math.max(0, dur - app.halfBar) : start;
  const a = Math.max(0, Math.min(start, maxStart));
  const b = Math.min(a + app.LOOP_BARS * app.secPerBar, dur || a + app.LOOP_BARS * app.secPerBar);
  app.transport.setLoop({ a, b });
}

function nudge(dir) {
  const idx = Math.max(0, Math.round(app.transport.time / app.halfBar) + dir);
  let nt = idx * app.halfBar;
  const dur = songDuration();
  if (dur) nt = Math.min(nt, dur);
  app.transport.audio.currentTime = nt;
  if (app.transport.loop) applyLoopFrom(nt);
  updateBarReadout();
}

// Top bar/beat counter + metronome beat-light, driven off the beat grid each frame.
function updateBeatUI(t) {
  if (!app) return;
  const beats = app.song.beats || [];
  let idx = -1;
  for (let i = 0; i < beats.length; i++) { if (beats[i].t <= t) idx = i; else break; }
  const bar = idx >= 0 ? beats[idx].bar : 1;
  const beat = idx >= 0 ? beats[idx].beat : 1;
  const bcBar = $("bc-bar"), bcBeat = $("bc-beat");
  if (bcBar) bcBar.textContent = bar;
  if (bcBeat) bcBeat.textContent = beat;

  if (idx !== _lastBeat) {
    _lastBeat = idx;
    // flash on each beat while the accompaniment is playing (not during preview)
    if (idx >= 0 && app.transport.playing && !app.transport.previewing) pulseMetroLight(beat === 1);
  }
}

function pulseMetroLight(down) {
  const el = $("metro-light");
  if (!el) return;
  el.classList.remove("on", "down");
  void el.offsetWidth;               // restart the fade
  el.classList.add("on");
  if (down) el.classList.add("down");
  clearTimeout(pulseMetroLight._t);
  pulseMetroLight._t = setTimeout(() => el.classList.remove("on", "down"), 110);
}

function updateBarReadout() {
  if (!app) return;
  const bar = Math.floor(app.transport.time / app.secPerBar) + 1;
  let s = `Bar ${bar}`;
  const lp = app.transport.loop;
  if (lp) {
    const startBar = Math.floor(lp.a / app.secPerBar) + 1;
    const half = Math.round(lp.a / app.halfBar) % 2 === 1;
    s += ` · 🔁 ${app.LOOP_BARS} bars @ bar ${startBar}${half ? "½" : ""}`;
  }
  const el = $("bar-readout");
  if (el) el.textContent = s;
}

function makeNotation(mode, song, colored) {
  const section = document.querySelector(`.chart[data-chart="${mode}"]`);
  return new NotationRenderer(
    $(`${mode}-host`),
    section.querySelector(".score-cursor"),
    section.querySelector(".score-scroll"),
    song,
    { colored }
  );
}

// Size the active canvas, or (re)layout the active notation view, now that it's visible.
function layoutActive() {
  if (state.mode === "clef" || state.mode === "score") {
    notationRef?.[state.mode]?.render();
    return;
  }
  const chart = document.querySelector(`.chart[data-chart="${state.mode}"]`);
  const canvas = chart?.querySelector("canvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();     // the canvas may be inset (edit mode scrubber)
  canvas.width = Math.max(1, Math.floor(rect.width * DPR));
  canvas.height = Math.max(1, Math.floor(rect.height * DPR));
}

function setPlayIcon(playing) { $("btn-play").textContent = playing ? "⏸" : "▶"; }

function updateReadout(transport) {
  $("time-readout").textContent = `${fmt(transport.time)} / ${fmt(transport.duration)}`;
}
function fmt(s) {
  if (!isFinite(s)) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}
