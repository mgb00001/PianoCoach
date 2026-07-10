// Animated keyboard renderer: draws an 88-ish key range, highlights active notes
// with pitch-class colour + label, and shows a small "upcoming" glow.
import { isBlack, midiToName, pcColor } from "../songmap.js";

export class KeyboardRenderer {
  constructor(canvas, song) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.song = song;
    // Whole-octave keyboard covering the song's range with headroom.
    this.lo = Math.floor(song._range.lo / 12) * 12;      // start on a C
    this.hi = Math.ceil((song._range.hi + 1) / 12) * 12 - 1;
  }

  whiteKeys() {
    const keys = [];
    for (let m = this.lo; m <= this.hi; m++) if (!isBlack(m)) keys.push(m);
    return keys;
  }

  render(state, dpr) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const whites = this.whiteKeys();
    const wk = W / whites.length;                // white-key width
    const wkH = Math.min(H * 0.82, wk * 4.6);     // white-key height
    const top = (H - wkH) / 2;
    const bkW = wk * 0.62, bkH = wkH * 0.62;

    const activeSet = new Set(state.activeMidi);
    const soonSet = new Set(state.soonMidi);
    const fadedSet = new Set(state.fadedMidi || []);   // locked-but-playing: faded peek (§17b)
    const xOf = {}; // midi -> white key left x

    // white keys
    whites.forEach((m, i) => {
      const x = i * wk; xOf[m] = x;
      const on = activeSet.has(m), soon = soonSet.has(m);
      ctx.fillStyle = on ? pcColor(m, 0.92)
        : soon ? pcColor(m, 0.22)
        : fadedSet.has(m) ? pcColor(m, 0.18)
        : getVar("--key-white");
      ctx.fillRect(x + 1, top, wk - 2, wkH);
      ctx.strokeStyle = getVar("--key-white-edge");
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 1, top, wk - 2, wkH);
      // C labels + active labels
      if (on) drawLabel(ctx, midiToName(m), x + wk / 2, top + wkH - 14, "#101010");
      else if (m % 12 === 0) drawLabel(ctx, midiToName(m), x + wk / 2, top + wkH - 10, getVar("--muted"));
    });

    // black keys (drawn after, positioned between whites)
    for (let m = this.lo; m <= this.hi; m++) {
      if (!isBlack(m)) continue;
      const leftWhite = m - 1;
      const bx = (xOf[leftWhite] ?? 0) + wk - bkW / 2;
      const on = activeSet.has(m), soon = soonSet.has(m);
      ctx.fillStyle = on ? pcColor(m, 0.95)
        : soon ? pcColor(m, 0.5)
        : fadedSet.has(m) ? pcColor(m, 0.28)
        : getVar("--key-black");
      ctx.fillRect(bx, top, bkW, bkH);
      if (on) drawLabel(ctx, midiToName(m), bx + bkW / 2, top + bkH - 10, "#fff");
    }
  }
}

function drawLabel(ctx, text, cx, cy, color) {
  ctx.save();
  ctx.font = "600 12px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillStyle = color;
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

function getVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}
