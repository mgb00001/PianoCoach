// Editable piano-roll (Generator preview only, §19): a scroll/zoom roll where the melody is
// hand-fixed with KEYBOARD edits. Click a note to toggle its highlight (multi-select supported);
// then: ←/→ = pitch ∓1 semitone, ↓/↑ = timing sooner/later, −/+ = length shorter/longer (all snap to
// a beat-subdivision grid, GRID_SUBDIV), Del = delete, Esc = deselect. Moving a selection leaves
// greyed phantoms at its old spot. Ctrl+C = duplicate in place (copies selected, originals shown
// dashed) → arrow the copies away. Ctrl+Z = undo · Ctrl(+Shift)+Z / Ctrl-click Undo = revert to last
// save. Double-click empty space adds a 1-beat note (snapped to key + grid). Chords dimmed context.
import { isBlack, midiToName, pcColor } from "../songmap.js";

const KB_CSS_H = 92;
const DEFAULT_LEN_BEATS = 1;
const GRID_SUBDIV = 2;            // edit grid = beat / GRID_SUBDIV (2 = 1/8 notes, 4 = 1/16)
// Stable per-note id. A history snapshot copies each note ({...n}), so object identity is lost
// on undo — the id survives the copy and is what lets the selection be restored. Internal only:
// getMelody() emits {t0,t1,midi}, so it never reaches the Song Map.
let _uid = 0;
const DPR = Math.min(window.devicePixelRatio || 1, 2);   // match main.js DPR

export class EditablePianoRollRenderer {
  constructor(canvas, song, onChange) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.song = song;
    this.onChange = onChange || (() => {});     // called after any edit (dirty flag/redraw)
    this.onNudge = () => {};                     // (deltaSeconds) → seek transport (live play-scrub)
    this.lo = Math.floor(song._range.lo / 12) * 12;
    this.hi = Math.ceil((song._range.hi + 1) / 12) * 12 - 1;

    this.whiteIndex = {};
    this.whiteMidis = [];             // white-key index -> midi (for keyboard hit-testing)
    let wi = 0;
    for (let m = this.lo; m <= this.hi; m++) if (!isBlack(m)) { this.whiteIndex[m] = wi++; this.whiteMidis.push(m); }
    this.numWhite = wi;

    // Working copy of the melody we mutate; caller reads it back on Save.
    this.melody = (song.melody || []).map((n) => ({ ...n, _id: ++_uid }));
    this.chords = song._chordNotes || [];

    // Live preview of UNSAVED notes: the accompaniment audio only contains the melody as
    // last saved, so notes added/edited this session are sounded on a WebAudio voice as the
    // playhead crosses them. Baseline = the melody as loaded (== the saved state).
    this._baseline = new Set(this.melody.map(noteKey));
    this._prevPlayT = null;

    // View: the roll FALLS downward (future at top, past at bottom). `topT` is the song time at
    // the top of the view; px/sec zoom (device px). `_viewInit` positions the paused view once.
    this.topT = 0;
    this._viewInit = false;
    this.pxPerSec = 90 * DPR;
    this.dpr = DPR;

    // Key/scale for snapping (pitch classes allowed in the key).
    this.scalePCs = this._scaleFromKey(song.key);
    this._gridCache = null;          // subdivision grid, built lazily from the beat grid

    this.selection = new Set();      // ACTIVE highlight — click toggles; arrows/±/Del act on it
    this._history = [];              // undo stack: melody snapshots before each edit
    this.ghost = new Set();          // COPY reference: real originals, dashed full-colour outline
    this.ghostNotes = [];            // MOVE reference: greyed phantoms {t0,t1,midi} at the pre-move spot
    this.onEditState = () => {};     // UI hook to refresh the Undo/Copy button states
    this._lastState = {};

    // Playback preview (§ edit-mode): when the roll is PLAYING it auto-scrolls to follow the
    // song and editing is locked; when PAUSED it is a static editor + a playable keyboard.
    this.playing = false;
    this.PLAYHEAD_FRAC = 0.5;        // "now" sits mid play-field → a before/after view as notes pass
    this.nowT = 0;                   // last known transport time (for the now-line)

    // Playable reference keyboard (paused only): click/drag the bottom strip to sound notes.
    this._ac = null; this._voice = null;   // lazy AudioContext + current monophonic voice
    this._heldKey = null;                  // midi currently sounding from the keyboard
    this._kbPointer = false;               // a keyboard press/gliss is in progress
    this._scrub = null;                    // live play-scrub: {pyPrev} while dragging during playback

    this._bindEvents();
  }

  _secVis() {
    const H = this.canvas.height, kbH = KB_CSS_H * this.dpr;
    return Math.max(0.001, (H - kbH) / this.pxPerSec);
  }

  // Position the view so song-time `t` sits at the now-line (mid play-field). The bottom is
  // clamped to t=0 so the now-line RISES from the bottom up to centre over the song's first
  // half-screen, rather than showing empty pre-song space below it.
  scrollToTime(t) {
    const secVis = this._secVis();
    this.topT = Math.max(secVis, t + this.PLAYHEAD_FRAC * secVis);
  }

  // ---- tiny synth for the playable keyboard (monophonic) ----
  _ensureAudio() {
    if (!this._ac) this._ac = new (window.AudioContext || window.webkitAudioContext)();
    if (this._ac.state === "suspended") this._ac.resume();
  }
  _noteOn(midi) {
    this._ensureAudio();
    this._noteOff();                       // monophonic — release any prior voice
    const ac = this._ac, now = ac.currentTime;
    const osc = ac.createOscillator(); osc.type = "triangle";
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.28, now + 0.01);   // quick attack
    g.gain.exponentialRampToValueAtTime(0.10, now + 0.35);   // decay to a sustain
    osc.connect(g).connect(ac.destination);
    osc.start(now);
    this._voice = { osc, g };
  }
  _noteOff() {
    if (!this._voice) return;
    const { osc, g } = this._voice, now = this._ac.currentTime;
    g.gain.cancelScheduledValues(now);
    g.gain.setValueAtTime(Math.max(0.0001, g.gain.value), now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.stop(now + 0.14);
    this._voice = null;
  }

  // Fire-and-forget polyphonic voice for the unsaved-note preview (independent of the
  // monophonic noodling voice — several edits can overlap during playback).
  _playNote(midi, durSec) {
    this._ensureAudio();
    const ac = this._ac, now = ac.currentTime;
    const end = now + Math.max(0.12, durSec);
    const osc = ac.createOscillator(); osc.type = "triangle";
    osc.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.30, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.12, Math.max(now + 0.05, end - 0.06));
    g.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(g).connect(ac.destination);
    osc.start(now); osc.stop(end + 0.02);
  }

  // While playing, sound any UNSAVED note whose onset the playhead just crossed. Saved notes
  // are skipped — they already sound in the pre-rendered accompaniment. `rate` = the practice
  // slow-down, so held length matches what the learner hears.
  _previewUnsaved(rate) {
    const t = this.nowT, prev = this._prevPlayT;
    this._prevPlayT = t;
    if (prev == null || t <= prev || t - prev > 0.5) return;   // seek/jump/first frame — no backfill
    for (const n of this.melody) {
      if (n.t0 <= prev || n.t0 > t) continue;
      if (this._baseline.has(noteKey(n))) continue;
      this._playNote(n.midi, (n.t1 - n.t0) / (rate || 1));
    }
  }

  // Which key is under a point in the keyboard strip (black keys sit on top of the white row).
  _keyAtXY(px, pyInKbd, W, kbH) {
    const wkW = this.wkW(W), bkW = wkW * 0.62, bkH = kbH * 0.62;
    if (pyInKbd <= bkH) {
      for (let m = this.lo; m <= this.hi; m++) {
        if (!isBlack(m)) continue;
        const cx = this.xCenter(m, W);
        if (px >= cx - bkW / 2 && px <= cx + bkW / 2) return m;
      }
    }
    const idx = Math.max(0, Math.min(this.numWhite - 1, Math.floor(px / wkW)));
    return this.whiteMidis[idx];
  }

  // ---- key → allowed pitch classes ----
  _scaleFromKey(key) {
    const MAJ = [0, 2, 4, 5, 7, 9, 11], MIN = [0, 2, 3, 5, 7, 8, 10];
    const ALL = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    if (!key) return ALL;
    const NAMES = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
                    "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
    // Accept either {tonic, mode} or a "F# minor" string.
    let tonic = key.tonic, mode = key.mode;
    if (typeof key === "string") {
      const parts = key.trim().split(/\s+/);
      tonic = parts[0]; mode = (parts[1] || "major").toLowerCase();
    }
    if (tonic == null) return ALL;
    const t = NAMES[tonic];
    if (t == null) return ALL;
    const steps = (String(mode).toLowerCase() === "minor") ? MIN : MAJ;
    return new Set(steps.map((s) => (t + s) % 12));
  }

  // ---- coordinate transforms (all in device px) ----
  wkW(W) { return W / this.numWhite; }
  xCenter(m, W) {
    const w = this.wkW(W);
    return isBlack(m) ? this.whiteIndex[m - 1] * w + w : this.whiteIndex[m] * w + w / 2;
  }
  midiAtX(x, W) {
    let best = this.lo, bd = 1e9;
    for (let m = this.lo; m <= this.hi; m++) {
      const d = Math.abs(this.xCenter(m, W) - x);
      if (d < bd) { bd = d; best = m; }
    }
    return best;
  }
  // The roll falls DOWNWARD: the top of the view is the latest (future) time, the bottom the
  // earliest. So time DECREASES as y increases; a note's later time sits higher on screen.
  tAtY(y) { return this.topT - y / this.pxPerSec; }
  yAtT(t) { return (this.topT - t) * this.pxPerSec; }

  // Screen rect of a note (direction-independent): top edge = later time (t1), bottom = t0.
  _noteRect(n, W) {
    const bw = (isBlack(n.midi) ? this.wkW(W) * 0.5 : this.wkW(W) * 0.72);
    const x = this.xCenter(n.midi, W) - bw / 2;
    const yA = this.yAtT(n.t0), yB = this.yAtT(n.t1);
    const top = Math.min(yA, yB), bot = Math.max(yA, yB);
    return { x, w: bw, top, bot, h: bot - top };
  }

  // ---- snapping ----
  _snapMidi(m, alt) {
    if (alt) return m;                        // Alt = chromatic / free
    for (let d = 0; d <= 6; d++) {
      if (this.scalePCs.has(((m + d) % 12 + 12) % 12)) return m + d;
      if (this.scalePCs.has(((m - d) % 12 + 12) % 12)) return m - d;
    }
    return m;
  }
  _beatGrid() { return (this.song.beats || []).map((b) => b.t).sort((a, b) => a - b); }
  _beatDur() {
    const g = this._beatGrid();
    if (g.length < 2) return 0.5;
    let sum = 0; for (let i = 1; i < g.length; i++) sum += g[i] - g[i - 1];
    return sum / (g.length - 1);
  }
  _beatLen() { return this._beatDur() * DEFAULT_LEN_BEATS; }   // add-note default (1 beat)

  // ---- subdivision grid (beats split GRID_SUBDIV ways) — the edit quantum for timing & length ----
  _grid() {
    if (this._gridCache) return this._gridCache;
    const beats = this._beatGrid();
    if (beats.length < 2) { return (this._gridCache = beats.slice()); }
    const g = [];
    // extrapolate the beat period BEFORE the first beat down to 0 (intros often have no beats,
    // yet the melody starts there) — keeps early notes editable on a consistent grid.
    const firstCell = (beats[1] - beats[0]) / GRID_SUBDIV;
    for (let t = beats[0] - firstCell; t > -1e-9; t -= firstCell) g.push(t);
    // interior subdivisions (respect per-beat rubato within the tracked region)
    for (let i = 0; i < beats.length - 1; i++) {
      const a = beats[i], b = beats[i + 1];
      for (let k = 0; k < GRID_SUBDIV; k++) g.push(a + (b - a) * (k / GRID_SUBDIV));
    }
    // extend past the final beat
    const last = beats[beats.length - 1], lastCell = (last - beats[beats.length - 2]) / GRID_SUBDIV;
    for (let k = 0; k <= GRID_SUBDIV * 8; k++) g.push(last + lastCell * k);
    g.sort((a, b) => a - b);
    return (this._gridCache = g);
  }
  // nearest grid line strictly in direction dir (+1 = later, -1 = sooner) from t
  _gridStep(t, dir) {
    const g = this._grid(), EPS = 1e-4;
    if (dir > 0) { for (let i = 0; i < g.length; i++) if (g[i] > t + EPS) return g[i]; return t; }
    for (let i = g.length - 1; i >= 0; i--) if (g[i] < t - EPS) return g[i];
    return t;
  }
  _snapGrid(t) {                                // nearest grid line (for add-note placement)
    const g = this._grid();
    let best = g[0], bd = 1e9;
    for (const x of g) { const d = Math.abs(x - t); if (d < bd) { bd = d; best = x; } }
    return best;
  }

  // ---- keyboard edits (act on the whole highlighted group; one undo checkpoint per keystroke) ----
  _editSelection(fn) {
    if (!this.selection.size) return;
    this._pushHistory();
    for (const n of this.selection) fn(n);
  }
  _setPitch(n, midi) {
    midi = Math.max(0, Math.min(127, midi));
    n.midi = midi; n.name = midiToName(midi);
  }
  _shiftTime(n, dir) {                          // snap the onset to the adjacent grid line
    const len = n.t1 - n.t0;
    const t0 = Math.max(0, this._gridStep(n.t0, dir));
    n.t0 = round4(t0); n.t1 = round4(t0 + len);
  }
  _resize(n, dir) {                             // snap the end to the adjacent grid line
    const minEnd = this._gridStep(n.t0, +1);    // a note is at least one grid cell long
    if (dir < 0 && n.t1 <= minEnd + 1e-4) return;            // already minimal — don't grow on shrink
    let t1 = this._gridStep(n.t1, dir);
    if (t1 < minEnd) t1 = minEnd;
    n.t1 = round4(t1);
  }

  // ---- hit testing ----
  _hit(px, py, W) {
    // iterate in reverse so topmost-drawn wins
    for (let i = this.melody.length - 1; i >= 0; i--) {
      const n = this.melody[i];
      const r = this._noteRect(n, W);
      if (px >= r.x && px <= r.x + r.w && py >= r.top && py <= r.bot) {
        return { note: n };
      }
    }
    return null;
  }

  _bindEvents() {
    const c = this.canvas;
    const geo = () => ({ W: c.width, H: c.height, kbH: KB_CSS_H * this.dpr });
    const toCanvas = (ev) => {
      const r = c.getBoundingClientRect();
      // canvas.width is device px; rect is CSS px → scale by the ratio actually in effect
      const sx = c.width / r.width, sy = c.height / r.height;
      return { px: (ev.clientX - r.left) * sx, py: (ev.clientY - r.top) * sy };
    };
    const redraw = () => this.render(this._lastState, this.dpr);

    c.addEventListener("mousedown", (ev) => {
      const { W, H, kbH } = geo();
      const { px, py } = toCanvas(ev);
      if (this.playing) {                            // live play-scrub: drag to nudge the song
        this._scrub = { pyPrev: py };                // now-line stays locked; the roll moves under it
        c.style.cursor = "grabbing";
        ev.preventDefault();
        return;
      }
      if (py > H - kbH) {                             // keyboard strip → sound the note (noodle)
        const midi = this._keyAtXY(px, py - (H - kbH), W, kbH);
        if (midi != null) {
          this._heldKey = midi; this._kbPointer = true; this._noteOn(midi);
          redraw();
        }
        ev.preventDefault();
        return;
      }
      this._clearRefs();                               // a new selection action ends the compare
      const hit = this._hit(px, py, W);
      if (hit) {                                       // toggle the note's highlight
        if (this.selection.has(hit.note)) this.selection.delete(hit.note);
        else this.selection.add(hit.note);
      } else {
        this.selection.clear();                        // click empty = deselect (add = double-click)
      }
      this._notify();
      redraw();
      ev.preventDefault();
    });

    // Double-click empty space = add a note (deliberate, so stray clicks don't create notes).
    c.addEventListener("dblclick", (ev) => {
      if (this.playing) return;
      const { W, H, kbH } = geo();
      const { px, py } = toCanvas(ev);
      if (py > H - kbH || this._hit(px, py, W)) return;   // ignore keyboard strip / clicks on notes
      this._addNoteAt(px, py, W, ev.altKey);
      redraw();
      ev.preventDefault();
    });

    window.addEventListener("mousemove", (ev) => {
      if (this._scrub) {                              // live play-scrub: seek by the drag delta
        const { py } = toCanvas(ev);
        const dy = py - this._scrub.pyPrev;
        this._scrub.pyPrev = py;
        if (dy) this.onNudge(dy / this.pxPerSec);     // down (dy>0) = forward; up = rewind
        return;
      }
      if (this._kbPointer) {                          // glissando: slide across the keys
        const { W, H, kbH } = geo();
        const { px, py } = toCanvas(ev);
        if (py > H - kbH) {
          const midi = this._keyAtXY(px, py - (H - kbH), W, kbH);
          if (midi != null && midi !== this._heldKey) { this._heldKey = midi; this._noteOn(midi); redraw(); }
        }
        return;
      }
    });

    window.addEventListener("mouseup", () => {
      if (this._scrub) { this._scrub = null; c.style.cursor = ""; }
      if (this._kbPointer) { this._kbPointer = false; this._heldKey = null; this._noteOff(); redraw(); }
    });

    window.addEventListener("keydown", (ev) => {
      if (!this._isVisible() || this.playing) return;    // only act in the visible, paused editor
      const tag = ev.target && ev.target.tagName;        // don't hijack the scrubber / selects
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

      const mod = ev.ctrlKey || ev.metaKey;
      if (mod && (ev.key === "z" || ev.key === "Z")) {
        if (ev.shiftKey) this.undoAll(); else this.undo();     // Ctrl+Shift+Z = revert to last save
        ev.preventDefault(); return;
      }
      if (mod && (ev.key === "c" || ev.key === "C")) { this.copy(); ev.preventDefault(); return; }
      if (ev.key === "Escape") {
        if (this.selection.size || this.ghost.size || this.ghostNotes.length) {
          this.selection.clear(); this._clearRefs(); this._notify(); redraw();
        }
        ev.preventDefault(); return;
      }
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;

      const sel = [...this.selection];
      if (!sel.length) return;                           // rule 1: highlight first

      switch (ev.key) {
        case "Delete": case "Backspace":                 // rule 4
          this._pushHistory();
          this.melody = this.melody.filter((n) => !this.selection.has(n));
          this.selection.clear();
          this._notify();
          break;
        case "ArrowLeft":  this._ensureMovePhantoms(); this._editSelection((n) => this._setPitch(n, n.midi - 1)); break;   // pitch −
        case "ArrowRight": this._ensureMovePhantoms(); this._editSelection((n) => this._setPitch(n, n.midi + 1)); break;   // pitch +
        case "ArrowDown":  this._ensureMovePhantoms(); this._editSelection((n) => this._shiftTime(n, -1)); break;   // sooner
        case "ArrowUp":    this._ensureMovePhantoms(); this._editSelection((n) => this._shiftTime(n, +1)); break;   // later
        case "+": case "=": this._editSelection((n) => this._resize(n, +1)); break;    // rule 3: longer (grid)
        case "-": case "_": this._editSelection((n) => this._resize(n, -1)); break;    // rule 3: shorter (grid)
        default: return;                                 // unhandled key — let it through
      }
      this.onChange();
      redraw();
      ev.preventDefault();
    });

    // wheel = vertical scroll; ctrl+wheel = zoom
    c.addEventListener("wheel", (ev) => {
      if (ev.ctrlKey) {
        this.pxPerSec = Math.max(30 * this.dpr, Math.min(300 * this.dpr,
          this.pxPerSec * (ev.deltaY < 0 ? 1.1 : 0.9)));
      } else if (this.playing) {
        // playing: wheel nudges the song (seek) — the now-line stays locked at centre
        this.onNudge(ev.deltaY / this.pxPerSec);
      } else {
        // paused: scroll down = advance to later in the song; clamp t=0 to the bottom
        this.topT = Math.max(this._secVis(), this.topT + ev.deltaY / this.pxPerSec);
      }
      redraw();
      ev.preventDefault();
    }, { passive: false });
  }

  // ---- undo -----------------------------------------------------------------
  _isVisible() { return this.canvas.offsetParent !== null; }   // edit chart is on-screen
  _notify() { this.onEditState && this.onEditState(); }
  // A checkpoint stores the melody AND what was highlighted at the time, so undo puts the
  // selection back too — keep nudging the same note after a Ctrl+Z instead of re-finding it.
  _pushHistory() {
    this._history.push({
      melody: this.melody.map((n) => ({ ...n })),                // deep-ish snapshot
      sel: [...this.selection].map((n) => n._id),
    });
    if (this._history.length > 100) this._history.shift();
    this._notify();
  }
  canUndo() { return this._history.length > 0; }
  // Restore a checkpoint. Notes are fresh objects, so the selection is rebuilt by id — and any
  // note the undo did not bring back (e.g. undoing an add) simply drops out of the selection.
  _restore(snap) {
    this.melody = snap.melody;
    const ids = new Set(snap.sel);
    this.selection = new Set(this.melody.filter((n) => ids.has(n._id)));
    this._clearRefs();               // any reference overlay is stale after undo
    this.onChange();
    this._notify();
    this.render(this._lastState, this.dpr);
  }
  undo() {
    if (!this._history.length) return;
    this._restore(this._history.pop());
  }
  // Revert EVERYTHING back to the last save/load (Ctrl+click Undo). history[0] is the melody as it
  // was before the first edit this session; the page reloads on save, so that IS the saved state.
  undoAll() {
    if (!this._history.length) return;
    const first = this._history[0];
    this._history = [];
    this._restore(first);
  }

  // ---- copy + move references ----------------------------------------------
  canCopy() { return this.selection.size > 0; }
  _clearRefs() { this.ghost.clear(); this.ghostNotes = []; }   // drop both reference overlays

  // Copy = duplicate the selection IN PLACE. The copies become the active selection; the originals
  // stay put and show as a dashed full-colour reference. The user then arrows the copies away.
  copy() {
    if (!this.selection.size) return;
    this._pushHistory();
    const originals = [...this.selection];
    const dupes = originals.map((n) => ({ t0: n.t0, t1: n.t1, midi: n.midi, name: n.name,
                                          hand: "R", clef: "treble", part: "melody", _id: ++_uid }));
    for (const d of dupes) this.melody.push(d);
    this.selection = new Set(dupes);
    this.ghost = new Set(originals);                  // dashed full-colour "the original is here"
    this.ghostNotes = [];
    this.onChange();
    this._notify();
    this.render(this._lastState, this.dpr);
  }

  // On the FIRST move of a fresh selection (and only if no reference is already showing), snapshot
  // the pre-move positions as greyed phantoms — "these moved from here". Copy sets its own reference,
  // so this no-ops during a copy-then-arrow. Cleared on Esc / new click / undo.
  _ensureMovePhantoms() {
    if (this.ghost.size || this.ghostNotes.length) return;
    this.ghostNotes = [...this.selection].map((n) => ({ t0: n.t0, t1: n.t1, midi: n.midi }));
  }

  // Add a 1-beat note (deliberate: double-click empty space). Alt = free placement, else snap.
  _addNoteAt(px, py, W, alt) {
    this._pushHistory();
    const midi = this._snapMidi(this.midiAtX(px, W), alt);
    const raw = this.tAtY(py);
    const t0 = Math.max(0, alt ? raw : this._snapGrid(raw));
    const n = { t0, t1: t0 + this._beatLen(), midi, name: midiToName(midi),
                hand: "R", clef: "treble", part: "melody", _id: ++_uid };
    this.melody.push(n);
    this.selection = new Set([n]);
    this._clearRefs();
    this.onChange();
    this._notify();
  }

  // Read the edited melody back out (for Save → POST /api/edit).
  getMelody() {
    return this.melody
      .filter((n) => n.t1 > n.t0)
      .map((n) => ({ t0: n.t0, t1: n.t1, midi: n.midi }))
      .sort((a, b) => a.t0 - b.t0);
  }

  render(state, dpr) {
    state = state || {};
    this._lastState = state;
    if (dpr) this.dpr = dpr;
    this.playing = !!state.playing;
    if (typeof state.time === "number") this.nowT = state.time;
    // While playing, the roll follows the song (editing locked); paused view is user-driven.
    // On first paint, centre the paused view on "now" so the song start is in view.
    if (this.playing) { this.scrollToTime(this.nowT); this._viewInit = true; }
    else if (!this._viewInit) { this.scrollToTime(this.nowT); this._viewInit = true; }

    // Unsaved notes aren't in the accompaniment audio → sound them live as "now" crosses them.
    if (this.playing) this._previewUnsaved(state.rate);
    else this._prevPlayT = null;

    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const kbH = KB_CSS_H * this.dpr, hitY = H - kbH, wkW = this.wkW(W);
    ctx.clearRect(0, 0, W, H);

    // pitch gridlines at each C
    ctx.strokeStyle = "rgba(120,120,140,0.25)"; ctx.lineWidth = 1;
    for (let m = this.lo; m <= this.hi; m++) {
      if (m % 12 !== 0) continue;
      const x = this.whiteIndex[m] * wkW;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hitY); ctx.stroke();
    }

    // beat lines (visible slice)
    (this.song.beats || []).forEach((b) => {
      const y = this.yAtT(b.t);
      if (y < 0 || y > hitY) return;
      ctx.strokeStyle = `rgba(120,120,140,${b.beat === 1 ? 0.5 : 0.2})`;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    });

    // chords: dimmed, non-editable context
    for (const n of this.chords) {
      const r = this._noteRect(n, W);
      if (r.bot < 0 || r.top > hitY) continue;
      const y = Math.max(0, r.top), h = Math.min(hitY, r.bot) - y;
      rr(ctx, r.x, y, r.w, Math.max(2, h), 3);
      ctx.fillStyle = pcColor(n.midi, 0.18); ctx.fill();
    }

    // cut/paste phantom references: greyed, dashed — where the cut notes used to be
    for (const n of this.ghostNotes) {
      const r = this._noteRect(n, W);
      if (r.bot < 0 || r.top > hitY) continue;
      const y = Math.max(0, r.top), h = Math.min(hitY, r.bot) - y;
      rr(ctx, r.x, y, r.w, Math.max(4, h), 4);
      ctx.fillStyle = "rgba(150,150,165,0.20)"; ctx.fill();
      ctx.save();
      ctx.strokeStyle = "rgba(205,205,215,0.75)"; ctx.lineWidth = 2;
      ctx.setLineDash([5 * this.dpr, 3 * this.dpr]); ctx.stroke();
      ctx.restore();
    }

    // melody: editable, highlighted notes get a white outline (may be several — group edits)
    for (const n of this.melody) {
      const r = this._noteRect(n, W);
      if (r.bot < 0 || r.top > hitY) continue;
      const sel = this.selection.has(n);
      const x = r.x, bw = r.w;
      const y = Math.max(0, r.top), h = Math.min(hitY, r.bot) - y;
      rr(ctx, x, y, bw, Math.max(4, h), 4);
      ctx.fillStyle = pcColor(n.midi, sel ? 1 : 0.9); ctx.fill();
      if (sel) {
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();              // active selection
      } else if (this.ghost.has(n)) {
        ctx.save();                                                            // paste reference
        ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 2;
        ctx.setLineDash([5 * this.dpr, 3 * this.dpr]); ctx.stroke();
        ctx.restore();
      }
      if (h > 18) {
        ctx.fillStyle = "#101010";
        ctx.font = `600 ${11 * this.dpr}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(midiToName(n.midi), x + bw / 2, Math.min(hitY, r.bot) - 5);
      }
    }

    // "now" line — where the song currently is (tracks the transport in either state)
    const nowY = this.yAtT(this.nowT);
    if (nowY >= 0 && nowY <= hitY) {
      ctx.strokeStyle = "rgba(255,90,90,0.9)"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, nowY); ctx.lineTo(W, nowY); ctx.stroke();
    }

    // Which keys to light: notes sounding now while playing, or the held key while noodling.
    const lit = new Map();
    if (this.playing) {
      for (const n of this.melody) if (this.nowT >= n.t0 && this.nowT < n.t1) lit.set(n.midi, 1);
    } else if (this._heldKey != null) {
      lit.set(this._heldKey, 1);
    }

    // keyboard strip (playable reference when paused; labels at each C)
    this._drawKeyboard(ctx, W, hitY, kbH, wkW, lit);
  }

  _drawKeyboard(ctx, W, top, kbH, wkW, lit) {
    const bkW = wkW * 0.62, bkH = kbH * 0.62;
    for (let m = this.lo; m <= this.hi; m++) {
      if (isBlack(m)) continue;
      const x = this.whiteIndex[m] * wkW;
      ctx.fillStyle = lit && lit.has(m) ? pcColor(m, 0.85) : "#f4f4f7";
      ctx.fillRect(x + 1, top, wkW - 2, kbH);
      ctx.strokeStyle = "#cfcfd6"; ctx.lineWidth = 1; ctx.strokeRect(x + 1, top, wkW - 2, kbH);
      if (m % 12 === 0) {
        ctx.fillStyle = "#888"; ctx.font = `600 ${12 * this.dpr}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(midiToName(m), x + wkW / 2, top + kbH - 8 * this.dpr);
      }
    }
    for (let m = this.lo; m <= this.hi; m++) {
      if (!isBlack(m)) continue;
      const cx = this.xCenter(m, W);
      ctx.fillStyle = lit && lit.has(m) ? pcColor(m, 1) : "#222";
      ctx.fillRect(cx - bkW / 2, top, bkW, bkH);
    }
  }
}

const round4 = (x) => Math.round(x * 1e4) / 1e4;   // tame float drift on time edits

// Identity of a note's SOUND (time + pitch) — used to tell unsaved notes from saved ones.
const noteKey = (n) => `${round4(n.t0)}|${round4(n.t1)}|${n.midi}`;

function rr(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
