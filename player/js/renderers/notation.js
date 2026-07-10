// Notation renderer (VexFlow). Lays out the song as a grand staff (treble + bass),
// one measure per bar, wrapped into rows. `colored` = pedagogical clef mode
// (pitch-class colours + note labels); otherwise a plain "standard score".
// A DOM cursor overlay is moved by updateCursor(t), slaved to the audio clock.
import { pcColor, midiToName } from "../songmap.js";

const LETTERS = ["c", "c#", "d", "d#", "e", "f", "f#", "g", "g#", "a", "a#", "b"];
const ROW_H = 210;

export class NotationRenderer {
  constructor(hostEl, cursorEl, scrollEl, song, { colored }) {
    this.host = hostEl;
    this.cursor = cursorEl;
    this.scroll = scrollEl;
    this.song = song;
    this.colored = colored;
    this.secPerBeat = 60 / song.tempo.bpm;
    this.beatsPerBar = parseInt((song.time_signature || "4/4").split("/")[0], 10) || 4;
    this.secPerBar = this.secPerBeat * this.beatsPerBar;
    this.nBars = Math.max(1, ...(song.beats || [{ bar: 1 }]).map((b) => b.bar));
    this.layout = [];
    this.notes = [];
    this._melodyMax = Infinity;   // §17 level filter
    this._chordMax = 6;
  }

  setFilter(melodyMax, chordMax) { this._melodyMax = melodyMax; this._chordMax = chordMax; }

  get VF() { return window.Vex.Flow; }

  midiToKey(m) {
    const pc = LETTERS[m % 12];
    const oct = Math.floor(m / 12) - 1;
    return { key: `${pc}/${oct}`, acc: pc.includes("#") ? "#" : null };
  }

  quant(n) {
    const b = (n.t1 - n.t0) / this.secPerBeat;
    if (b >= 3.5) return "w";
    if (b >= 1.5) return "h";
    if (b >= 0.75) return "q";
    if (b >= 0.375) return "8";
    return "16";
  }

  // Note events whose onset lies in bar, grouped into simultaneities (chords).
  measureGroups(bar, clef) {
    const t0 = bar * this.secPerBar, t1 = t0 + this.secPerBar;
    const src = clef === "treble" ? (this.song.melody || []) : (this.song._chordNotes || []);
    const inBar = src.filter((n) => n.t0 >= t0 - 1e-4 && n.t0 < t1 - 1e-4);
    const groups = new Map();
    for (const n of inBar) {
      const k = Math.round(n.t0 * 100);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(n);
    }
    return [...groups.values()].sort((a, b) => a[0].t0 - b[0].t0);
  }

  buildNotes(bar, clef) {
    const VF = this.VF;
    const groups = this.measureGroups(bar, clef);
    if (groups.length === 0) {
      return [new VF.StaveNote({ clef, keys: [clef === "treble" ? "b/4" : "d/3"], duration: "wr" })];
    }
    return groups.map((g) => {
      const sorted = [...g].sort((a, b) => a.midi - b.midi);
      const keys = sorted.map((n) => this.midiToKey(n.midi));
      const note = new VF.StaveNote({ clef, keys: keys.map((k) => k.key), duration: this.quant(g[0]) });
      keys.forEach((k, i) => { if (k.acc) note.addModifier(new VF.Accidental(k.acc), i); });

      // faded peek (§17b): dim notes this level hasn't unlocked yet
      const locked = clef === "treble" ? (g[0].noteRank > this._melodyMax) : (g[0].chordRank > this._chordMax);
      if (locked) {
        note.setStyle({ fillStyle: "rgba(140,142,155,0.30)", strokeStyle: "rgba(140,142,155,0.30)" });
      } else {
        if (this.colored) {
          keys.forEach((k, i) => note.setKeyStyle(i, { fillStyle: pcColor(sorted[i].midi), strokeStyle: pcColor(sorted[i].midi) }));
          if (clef === "treble" && sorted.length === 1) {
            note.addModifier(new VF.Annotation(midiToName(sorted[0].midi))
              .setVerticalJustification(VF.Annotation.VerticalJustify.BOTTOM), 0);
          }
        }
      }
      note._pcTime = { t0: g[0].t0, t1: g[0].t1 };
      return note;
    });
  }

  render() {
    const VF = this.VF;
    const W = this.scroll.clientWidth || 900;
    this.host.innerHTML = "";
    this.layout = [];
    this.notes = [];

    const perRow = Math.max(1, Math.floor(W / 260));
    const leftPad = 8, rightPad = 8;
    const mW = (W - leftPad - rightPad) / perRow;
    const rows = Math.ceil(this.nBars / perRow);

    const renderer = new VF.Renderer(this.host, VF.Renderer.Backends.SVG);
    renderer.resize(W, rows * ROW_H + 20);
    const ctx = renderer.getContext();

    for (let bar = 0; bar < this.nBars; bar++) {
      const row = Math.floor(bar / perRow), col = bar % perRow;
      const x = leftPad + col * mW;
      const yTop = 15 + row * ROW_H;
      const trebleY = yTop, bassY = yTop + 95;

      const treble = new VF.Stave(x, trebleY, mW);
      const bass = new VF.Stave(x, bassY, mW);
      if (col === 0) { treble.addClef("treble"); bass.addClef("bass"); }
      treble.setContext(ctx).draw();
      bass.setContext(ctx).draw();
      if (col === 0) {
        new VF.StaveConnector(treble, bass).setType("brace").setContext(ctx).draw();
        new VF.StaveConnector(treble, bass).setType("singleLeft").setContext(ctx).draw();
      }

      const tNotes = this.buildNotes(bar, "treble");
      const bNotes = this.buildNotes(bar, "bass");
      const tv = new VF.Voice({ num_beats: this.beatsPerBar, beat_value: 4 }).setStrict(false).addTickables(tNotes);
      const bv = new VF.Voice({ num_beats: this.beatsPerBar, beat_value: 4 }).setStrict(false).addTickables(bNotes);
      const innerX = x + (col === 0 ? 52 : 10);
      const innerW = mW - (col === 0 ? 62 : 20);
      new VF.Formatter().joinVoices([tv]).joinVoices([bv]).format([tv, bv], Math.max(40, innerW));
      tv.draw(ctx, treble);
      bv.draw(ctx, bass);

      // collect note elements for active-highlight
      for (const n of [...tNotes, ...bNotes]) {
        if (!n._pcTime) continue;
        let el = null;
        try { el = n.getSVGElement && n.getSVGElement(); } catch (e) { /* ignore */ }
        if (el) el.classList.add("notation-note");
        this.notes.push({ ...n._pcTime, el });
      }

      this.layout.push({
        bar, t0: bar * this.secPerBar, t1: (bar + 1) * this.secPerBar,
        y: yTop, h: ROW_H - 25, innerX, innerW,
      });
    }
  }

  updateCursor(t) {
    if (!this.layout.length) return;
    let seg = this.layout.find((L) => t >= L.t0 && t < L.t1);
    if (!seg) seg = t < this.layout[0].t0 ? this.layout[0] : this.layout[this.layout.length - 1];
    const frac = Math.max(0, Math.min(1, (t - seg.t0) / (seg.t1 - seg.t0)));
    const x = seg.innerX + frac * seg.innerW;

    this.cursor.style.left = x + "px";
    this.cursor.style.top = seg.y + "px";
    this.cursor.style.height = seg.h + "px";

    // keep the active row visible
    const top = this.scroll.scrollTop, vh = this.scroll.clientHeight;
    if (seg.y < top + 8 || seg.y + seg.h > top + vh - 8) this.scroll.scrollTop = Math.max(0, seg.y - 20);

    // active-note emphasis
    for (const n of this.notes) {
      if (!n.el) continue;
      n.el.classList.toggle("active", t >= n.t0 && t < n.t1);
    }
  }
}
