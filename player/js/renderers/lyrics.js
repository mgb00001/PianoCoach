// Lyrics ribbon: shows previous / current / next line, karaoke-highlighting the
// current word on the current line. Driven by update(t) from the shared clock.
// Rebuilds line DOM only when the line changes; toggles word classes each frame.

export class LyricsRenderer {
  constructor(ribbonEl, song) {
    this.el = ribbonEl;
    this.lines = song.lyrics?.lines || [];
    this.prev = ribbonEl.querySelector("#lyric-prev");
    this.cur = ribbonEl.querySelector("#lyric-cur");
    this.next = ribbonEl.querySelector("#lyric-next");
    this.curIdx = -2;
  }

  hasLyrics() { return this.lines.length > 0; }

  lineIndexAt(t) {
    let idx = -1;
    for (let i = 0; i < this.lines.length; i++) {
      if (this.lines[i].t0 <= t) idx = i; else break;
    }
    // fall off the end when past the last line
    if (idx >= 0 && t >= this.lines[idx].t1 && idx === this.lines.length - 1) return idx;
    return idx;
  }

  update(t) {
    if (!this.lines.length) return;
    const i = this.lineIndexAt(t);
    if (i !== this.curIdx) { this.curIdx = i; this._renderLines(i); }
    this._highlightWord(t, i);
  }

  _renderLines(i) {
    this.prev.textContent = i - 1 >= 0 ? this.lines[i - 1].text : "";
    this.next.textContent = i + 1 < this.lines.length ? this.lines[i + 1].text : "";
    this.cur.innerHTML = "";
    const line = i >= 0 ? this.lines[i] : null;
    if (!line) return;
    if (line.words && line.words.length) {
      line.words.forEach((w) => {
        const s = document.createElement("span");
        s.className = "w";
        s.dataset.t = w.t;
        s.textContent = w.text;
        this.cur.appendChild(s);
        this.cur.appendChild(document.createTextNode(" "));
      });
    } else {
      this.cur.textContent = line.text;
    }
  }

  _highlightWord(t, i) {
    if (i < 0) return;
    const line = this.lines[i];
    if (!line.words || !line.words.length) return;
    let active = -1;
    for (let k = 0; k < line.words.length; k++) {
      if (line.words[k].t <= t) active = k; else break;
    }
    const spans = this.cur.querySelectorAll(".w");
    spans.forEach((s, k) => {
      s.classList.toggle("active", k === active);
      s.classList.toggle("sung", k < active);
    });
  }
}
