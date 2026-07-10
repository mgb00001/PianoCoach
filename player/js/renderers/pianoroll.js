// Piano-roll renderer (Synthesia-style): notes fall top->bottom to a hit-line that
// sits on a labelled keyboard strip, so it's always clear which key a bar targets.
// Pitch maps to x by real keyboard geometry (white keys equal width, black keys between).
import { isBlack, midiToName, pcColor, visibleAtLevel, levelFade } from "../songmap.js";

const KB_CSS_H = 92; // keyboard strip height in CSS px (scaled by dpr at render)

export class PianoRollRenderer {
  constructor(canvas, song) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.song = song;
    this.lo = Math.floor(song._range.lo / 12) * 12;              // start on a C
    this.hi = Math.ceil((song._range.hi + 1) / 12) * 12 - 1;      // end on a B

    // white-key index map (for keyboard-aligned x positions)
    this.whiteIndex = {};
    let wi = 0;
    for (let m = this.lo; m <= this.hi; m++) if (!isBlack(m)) this.whiteIndex[m] = wi++;
    this.numWhite = wi;

    this.notes = [...(song.melody || []), ...(song._chordNotes || [])];
  }

  wkW(W) { return W / this.numWhite; }

  xCenter(m, W) {
    const wkW = this.wkW(W);
    if (!isBlack(m)) return this.whiteIndex[m] * wkW + wkW / 2;
    return this.whiteIndex[m - 1] * wkW + wkW; // black key straddles the white boundary
  }

  render(state, dpr) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const kbH = KB_CSS_H * dpr;
    const hitY = H - kbH;                    // bars fall to here; keyboard sits below
    const pxPerSec = state.zoom * dpr;
    const t = state.time;
    const wkW = this.wkW(W);

    const mMax = state.melodyMax ?? Infinity, cMax = state.chordMax ?? 6;
    const activeSet = new Set(
      this.notes
        .filter((n) => visibleAtLevel(n, mMax, cMax) && t >= n.t0 && t < n.t1)
        .map((n) => n.midi)
    );

    // ---- pitch gridlines at each C (in the roll area only) ----
    ctx.strokeStyle = hexA(getVar("--border"), 0.6);
    ctx.lineWidth = 1;
    for (let m = this.lo; m <= this.hi; m++) {
      if (m % 12 !== 0) continue;
      const x = this.whiteIndex[m] * wkW;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hitY); ctx.stroke();
    }

    // ---- loop region band (scrolls with time) ----
    if (state.loop) {
      const yA = Math.max(0, Math.min(hitY, hitY - (state.loop.a - t) * pxPerSec));
      const yB = Math.max(0, Math.min(hitY, hitY - (state.loop.b - t) * pxPerSec));
      const yTop = Math.min(yA, yB), yBot = Math.max(yA, yB);
      ctx.fillStyle = hexA(getVar("--accent"), 0.1);
      ctx.fillRect(0, yTop, W, yBot - yTop);
      ctx.strokeStyle = hexA(getVar("--accent"), 0.7);
      ctx.setLineDash([6 * dpr, 5 * dpr]);
      ctx.lineWidth = 1.5 * dpr;
      [yA, yB].forEach((y) => { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); });
      ctx.setLineDash([]);
    }

    // ---- beat lines scrolling with time ----
    (this.song.beats || []).forEach((b) => {
      const y = hitY - (b.t - t) * pxPerSec;
      if (y < 0 || y > hitY) return;
      ctx.strokeStyle = hexA(getVar("--border"), b.beat === 1 ? 0.9 : 0.4);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    });

    // ---- falling note bars: unlocked full-strength, locked dimmed (faded peek, §17b) ----
    for (const n of this.notes) {
      const lf = levelFade(n, mMax, cMax);       // 1 = unlocked, LOCKED_ALPHA = locked
      const yTopRaw = hitY - (n.t1 - t) * pxPerSec;
      const yBotRaw = hitY - (n.t0 - t) * pxPerSec;
      if (yBotRaw < 0 || yTopRaw > hitY) continue;
      const yTop = Math.max(0, yTopRaw);
      const yBot = Math.min(hitY, yBotRaw);      // clamp so bars rest on the hit line
      const bw = (isBlack(n.midi) ? wkW * 0.5 : wkW * 0.72);
      const x = this.xCenter(n.midi, W) - bw / 2;
      const h = Math.max(4, yBot - yTop);
      const active = t >= n.t0 && t < n.t1;
      const alpha = (active ? 1 : (n.part === "chord" ? 0.5 : 0.95)) * lf;
      roundRect(ctx, x, yTop, bw, h, 4 * dpr);
      ctx.fillStyle = pcColor(n.midi, alpha);
      ctx.fill();
      if (lf === 1 && h > 20 * dpr) {             // label only unlocked notes (avoid clutter)
        ctx.fillStyle = "#101010";
        ctx.font = `600 ${11 * dpr}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(midiToName(n.midi), x + bw / 2, Math.min(yBot - 5 * dpr, hitY - 5 * dpr));
      }
    }

    // ---- hit line ----
    ctx.strokeStyle = getVar("--accent");
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.moveTo(0, hitY); ctx.lineTo(W, hitY); ctx.stroke();

    // ---- labelled keyboard strip ----
    this._drawKeyboard(ctx, W, hitY, kbH, wkW, dpr, activeSet);
  }

  _drawKeyboard(ctx, W, top, kbH, wkW, dpr, activeSet) {
    const bkW = wkW * 0.62, bkH = kbH * 0.62;

    // white keys
    for (let m = this.lo; m <= this.hi; m++) {
      if (isBlack(m)) continue;
      const x = this.whiteIndex[m] * wkW;
      const on = activeSet.has(m);
      ctx.fillStyle = on ? pcColor(m, 0.92) : getVar("--key-white");
      ctx.fillRect(x + 1, top, wkW - 2, kbH);
      ctx.strokeStyle = getVar("--key-white-edge");
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 1, top, wkW - 2, kbH);
      if (on) label(ctx, midiToName(m), x + wkW / 2, top + kbH - 12 * dpr, "#101010", dpr);
      else if (m % 12 === 0) label(ctx, midiToName(m), x + wkW / 2, top + kbH - 8 * dpr, getVar("--muted"), dpr);
    }
    // black keys on top
    for (let m = this.lo; m <= this.hi; m++) {
      if (!isBlack(m)) continue;
      const cx = this.xCenter(m, W);
      const on = activeSet.has(m);
      ctx.fillStyle = on ? pcColor(m, 0.95) : getVar("--key-black");
      ctx.fillRect(cx - bkW / 2, top, bkW, bkH);
      if (on) label(ctx, midiToName(m), cx, top + bkH - 8 * dpr, "#fff", dpr);
    }
  }
}

function label(ctx, text, cx, cy, color, dpr) {
  ctx.save();
  ctx.font = `600 ${12 * dpr}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = color;
  ctx.fillText(text, cx, cy);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function getVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
