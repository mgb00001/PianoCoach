// Transport: wraps an <audio> element as the master clock, plus a Web Audio
// metronome scheduled off the Song Map's beat grid. No custom audio DSP —
// tempo slow-down uses the browser's native pitch-preserving playbackRate.
//
// Optional REFERENCE track (§15): the original recording, bundled preview-only.
// During "compare" the reference becomes the master; the cursor stays in the
// SESSION timeline via an align map (identity / ratio / anchors). Only one source
// plays at a time, so there is no dual-track drift.

export class Transport {
  constructor(audioUrl, song) {
    this.song = song;
    // NO crossOrigin: it forces a CORS media request, which file:// can never satisfy —
    // the standalone (zip) player's audio silently failed to load. We never route these
    // elements through WebAudio, so CORS clearance isn't needed.
    this.audio = new Audio();
    this.audio.src = audioUrl;
    this.audio.preload = "auto";

    // optional reference (original) audio
    this.reference = null;
    if (song.reference?._audioUrl) {
      this.reference = new Audio();
      this.reference.src = song.reference._audioUrl;
      this.reference.preload = "auto";
    }
    this._buildAlign(song.reference);
    this.previewing = false;

    this.metroOn = false;
    this.loop = null;            // { a, b } in session seconds
    this._lastBeatIdx = -1;
    this._ac = null;             // lazily created AudioContext for the metronome
    this._rate = 1;
    this._userVol = 0.85;        // volume set by the user; fade multiplies on top
    this._fade = false;          // Level 10: taper the backing out over the song
  }

  hasReference() { return !!this.reference; }

  // ---- align: session-time <-> original-audio-time -------------------------
  _buildAlign(ref) {
    const a = ref?.align || { mode: "identity" };
    if (a.mode === "anchors" && a.anchors?.length > 1) {
      const s = a.anchors.map((p) => p.s), o = a.anchors.map((p) => p.o);
      this._align = (x) => interp(s, o, x);
      this._invAlign = (x) => interp(o, s, x);
    } else {
      const r = a.ratio ?? 1;                 // identity => 1
      this._align = (x) => x * r;
      this._invAlign = (x) => x / r;
    }
  }

  get _master() { return this.previewing ? this.reference : this.audio; }

  get time() {
    return this.previewing ? this._invAlign(this.reference.currentTime || 0)
                           : (this.audio.currentTime || 0);
  }
  get duration() { return this.audio.duration || this.song.source?.duration_s || 0; }
  get playing() { return !this._master.paused; }

  _preserve(el) {
    el.preservesPitch = true;
    el.mozPreservesPitch = true;
    el.webkitPreservesPitch = true;
  }

  async play() {
    const m = this._master;
    this._preserve(m);
    try { await m.play(); } catch (e) { console.warn("play() blocked:", e); }
  }
  pause() { this._master.pause(); }
  toggle() { return this.playing ? this.pause() : this.play(); }

  // Seek to a SESSION time, regardless of which master is active.
  seek(sessionT) {
    if (this.previewing) this.reference.currentTime = this._align(sessionT);
    else this.audio.currentTime = sessionT;
    this._lastBeatIdx = -1;
  }

  reset() { this.seek(this.loop ? this.loop.a : 0); }

  setRate(pct) {
    const r = Math.max(0.5, Math.min(1, pct / 100));
    this._rate = r;                          // the practice slow-down (accompaniment)
    this._preserve(this.audio);
    this.audio.playbackRate = r;
    if (this.reference) {
      this._preserve(this.reference);
      // the reference is the performance target: always heard at its ORIGINAL tempo
      // (and original key). The practice slow-down never applies to it.
      this.reference.playbackRate = this.previewing ? 1 : r;
    }
  }
  setVolume(pct) {
    this._userVol = Math.max(0, Math.min(1, pct / 100));
    this._applyVolume();
  }
  _applyVolume() {
    this.audio.volume = this._userVol;
    if (this.reference) this.reference.volume = this._userVol;
  }

  // ---- levels: swap the backing track + Level-10 fade -----------------------
  setFade(on) {
    this._fade = on;
    if (!on) this._applyVolume();
  }

  // Swap the accompaniment/backing to a level's pre-rendered track, keeping position + play state.
  setBacking(url) {
    if (!url) return;
    if (this.audio.src === url) return;
    const t = this.time;
    const wasPlaying = !this.audio.paused && !this.previewing;
    const resume = () => {
      this.audio.removeEventListener("canplay", resume);
      try { this.audio.currentTime = Math.min(t, (this.audio.duration || t)); } catch (e) { /* not seekable yet */ }
      if (wasPlaying) this.play();
    };
    this.audio.addEventListener("canplay", resume);
    this.audio.pause();
    this.audio.src = url;
    this.audio.load();
    this._lastBeatIdx = -1;
  }

  // ---- preview (compare with the original) ---------------------------------
  setPreview(on) {
    if (!this.reference || on === this.previewing) return;
    const sessionT = this.time;          // capture current session position
    const wasPlaying = this.playing;
    this._master.pause();
    this.previewing = on;
    this._preserve(this._master);
    // reference previews at original tempo (1x); accompaniment keeps the practice rate
    this._master.playbackRate = on ? 1 : this._rate;
    this.seek(sessionT);                 // place new master at the same session time
    if (wasPlaying) this.play();
    this._lastBeatIdx = -1;
  }

  setLoop(loop) { this.loop = loop; }
  setMetronome(on) {
    this.metroOn = on;
    if (on && !this._ac) this._ac = new (window.AudioContext || window.webkitAudioContext)();
    if (on && this._ac?.state === "suspended") this._ac.resume();
  }

  // Called every animation frame from the main loop.
  tick() {
    const t = this.time;

    // Level-10 fade: taper the backing out over the song ("progressively less support")
    if (this._fade) {
      this.audio.volume = this._userVol * Math.max(0, 1 - t / (this.duration || 1));
    }

    // A/B loop wrap (session timeline; seek routes to the active master)
    if (this.loop && t >= this.loop.b) {
      this.seek(this.loop.a);
      return;
    }

    // Metronome: click when we cross a new beat boundary.
    if (this.metroOn && this._ac) {
      const beats = this.song.beats || [];
      let idx = -1;
      for (let i = 0; i < beats.length; i++) { if (beats[i].t <= t) idx = i; else break; }
      if (idx !== this._lastBeatIdx && idx >= 0) {
        this._lastBeatIdx = idx;
        this._click(beats[idx].beat === 1);
      }
    }
  }

  _click(accent) {
    const ac = this._ac;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.frequency.value = accent ? 1500 : 900;
    g.gain.setValueAtTime(0.0001, ac.currentTime);
    g.gain.exponentialRampToValueAtTime(accent ? 0.4 : 0.25, ac.currentTime + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.06);
    osc.connect(g).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.07);
  }
}

// piecewise-linear interpolation with flat clamping outside the anchor range
function interp(xs, ys, x) {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let i = 1;
  while (i < xs.length && xs[i] < x) i++;
  const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  return ys[i - 1] + f * (ys[i] - ys[i - 1]);
}
