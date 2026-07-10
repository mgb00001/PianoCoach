"""
PianoCoach Generator — lightweight, torch-free first pass.

Analyses a REAL audio file and produces a real Song Map (schema v0.2):
  tempo + beat grid + key + per-bar chords + melody (pyin)
plus:
  - a simplified SYNTHETIC accompaniment rendered from the detected notes
    (what the learner practises to), and
  - the ORIGINAL recording bundled as an aligned AAC reference (🎧 Original preview).

Deferred wrinkles (see PLAN.md §5/§13): Demucs stem separation, Whisper lyrics,
per-level pre-mixing. This pass analyses the full mix.

Run with the librosa venv:
  <venv>/Scripts/python.exe generator/analyze_song.py "path/to/song.mp3" [--title T] [--artist A]
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
# NOTE: librosa (and torch/demucs/basic_pitch/whisper) are imported lazily inside the analysis
# functions, so the module imports with just numpy. This lets the webgen server run the
# edit / save / generate / export / transpose workflows without the heavy analysis stack.

# Windows consoles default to cp1252, which can't encode arrows/etc. in status prints.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

ROOT = Path(__file__).resolve().parents[1]
SR_SYNTH = 44100
NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler key profiles
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def midi_to_name(m):
    return f"{NAMES[m % 12]}{m // 12 - 1}"


def slugify(s):
    return re.sub(r"[^a-z0-9]+", "_", s.lower()).strip("_")[:60] or "song"


# ----------------------------------------------------------------- key & chords
def detect_key(chroma_mean):
    best = None
    for tonic in range(12):
        for profile, mode in ((MAJOR_PROFILE, "major"), (MINOR_PROFILE, "minor")):
            score = np.corrcoef(np.roll(profile, tonic), chroma_mean)[0, 1]
            if best is None or score > best[2]:
                best = (tonic, mode, score)
    tonic, mode, _ = best
    rel = NAMES[(tonic + 9) % 12] + "m" if mode == "major" else None
    return NAMES[tonic], mode, rel


def triad_templates():
    tpls = []
    for root in range(12):
        maj = np.zeros(12); maj[[root, (root + 4) % 12, (root + 7) % 12]] = 1
        minr = np.zeros(12); minr[[root, (root + 3) % 12, (root + 7) % 12]] = 1
        tpls.append((NAMES[root], "maj", root, maj / np.linalg.norm(maj)))
        tpls.append((NAMES[root] + "m", "min", root, minr / np.linalg.norm(minr)))
    return tpls


def best_chord(chroma_seg, tpls):
    v = chroma_seg / (np.linalg.norm(chroma_seg) + 1e-9)
    return max(tpls, key=lambda t: float(np.dot(v, t[3])))


def triad_midi(root, qual):
    third = 4 if qual == "maj" else 3
    base = 48 + root                      # around C3
    return [base, base + third, base + 7]


# diatonic triads (semitone offset from tonic, quality) for key refinement
MAJOR_DEG = [(0, "maj"), (2, "min"), (4, "min"), (5, "maj"), (7, "maj"), (9, "min")]
MINOR_DEG = [(0, "min"), (3, "maj"), (5, "min"), (7, "min"), (8, "maj"), (10, "maj")]


def diatonic_set(root, mode):
    degs = MAJOR_DEG if mode == "major" else MINOR_DEG
    return {((root + d) % 12, q) for d, q in degs}


def refine_key(tonic, mode, chords):
    """Krumhansl on a full mix often slips a fifth or to the relative. Re-pick among the
    candidate + its relative/dominant/subdominant by how well each key's diatonic triads
    match the (duration-weighted) detected chords."""
    if not chords:
        return tonic, mode
    rel = (((tonic + 9) % 12), "minor") if mode == "major" else (((tonic + 3) % 12), "major")
    cands = {(tonic, mode), rel, ((tonic + 7) % 12, mode), ((tonic + 5) % 12, mode)}
    obs = [((NAMES.index(c["root"]), c["quality"]), c["t1"] - c["t0"]) for c in chords]
    best, best_score = (tonic, mode), -1.0
    for (r, m) in cands:
        ds = diatonic_set(r, m)
        score = sum(w for (pcq, w) in obs if pcq in ds)
        # small tonic bonus: the I chord being present is a strong signal
        score += 0.5 * sum(w for (pcq, w) in obs if pcq[0] == r)
        if score > best_score:
            best, best_score = (r, m), score
    return best


def simplify_chords(raw, tonic_idx, mode, beats):
    """Musical common-sense clean-up: lock the key, snap every beat's raw chord to a
    diatonic chord (kills spurious Cm/Gm etc.), merge repeats, and absorb sub-beat
    flickers. Goal is a clean, learnable progression — not a note-perfect transcription."""
    dia = diatonic_set(tonic_idx, mode)
    dia_roots = {pc: q for (pc, q) in dia}          # each diatonic root -> its quality

    snapped = []
    for t0, t1, r, q in raw:
        if (r, q) in dia:
            sr_, sq_ = r, q
        elif r in dia_roots:
            sr_, sq_ = r, dia_roots[r]              # fix quality flips (Cm -> C in C major)
        else:                                        # out-of-key root -> nearest diatonic root
            sr_ = min(dia_roots, key=lambda p: min((p - r) % 12, (r - p) % 12))
            sq_ = dia_roots[sr_]
        snapped.append([t0, t1, sr_, sq_])

    def merge(spans):
        out = []
        for s in spans:
            if out and out[-1][2] == s[2] and out[-1][3] == s[3]:
                out[-1][1] = s[1]
            else:
                out.append(list(s))
        return out

    merged = merge(snapped)
    beat_dt = float(np.median(np.diff([b["t"] for b in beats]))) if len(beats) > 1 else 0.5
    deblipped = []
    for s in merged:                                 # absorb <~1-beat flickers into previous
        if deblipped and (s[1] - s[0]) < 0.9 * beat_dt:
            deblipped[-1][1] = s[1]
        else:
            deblipped.append(list(s))
    final = merge(deblipped)

    def bar_at(t):
        prior = [b["bar"] for b in beats if b["t"] <= t]
        return prior[-1] if prior else 1

    out, order, seen = [], {}, 0
    for t0, t1, r, q in final:
        sym = NAMES[r] + ("m" if q == "min" else "")
        if sym not in order:
            seen += 1; order[sym] = seen
        out.append({"t0": round(float(t0), 4), "t1": round(float(t1), 4), "bar": bar_at(t0),
                    "symbol": sym, "root": NAMES[r], "quality": q,
                    "notes": triad_midi(r, q), "order": order[sym]})
    return out


def separate_stems(path, analysis_sr):
    """Separate stems via the Demucs Python API, kept IN MEMORY (no temp files, so
    nothing syncs to OneDrive). Returns {stem: mono np.array at analysis_sr}."""
    import librosa
    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model

    model = get_model("htdemucs")
    model.eval()
    msr = model.samplerate                          # 44100

    wav = librosa.load(str(path), sr=msr, mono=False)[0]
    wav = np.atleast_2d(wav)
    if wav.shape[0] == 1:                           # mono -> fake stereo for the model
        wav = np.repeat(wav, 2, axis=0)
    mix = torch.tensor(wav, dtype=torch.float32)
    ref = mix.mean(0)
    mix = (mix - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        sources = apply_model(model, mix[None], device="cpu", split=True,
                              overlap=0.25, progress=True)[0]
    sources = sources * ref.std() + ref.mean()

    out = {}
    for name, src in zip(model.sources, sources):   # htdemucs: drums, bass, other, vocals
        mono = src.mean(0).cpu().numpy()            # (samples,) at msr
        out[name] = librosa.resample(mono, orig_sr=msr, target_sr=analysis_sr)
    return out


# --------------------------------------------------------------------- lyrics
def transcribe_lyrics(vocal, sr):
    """Whisper on the isolated vocal stem -> time-aligned lyrics (§13.3, §18.6). Sung vocals
    transcribe imperfectly but are fine as an overlay. Learner's own audio -> personal use."""
    import librosa
    import whisper
    model = whisper.load_model("small")
    audio16 = librosa.resample(np.asarray(vocal, dtype=np.float32), orig_sr=sr, target_sr=16000)
    result = model.transcribe(audio16, word_timestamps=True, fp16=False)
    lines = []
    for seg in result.get("segments", []):
        text = seg["text"].strip()
        if not text:
            continue
        words = [{"t": round(float(w["start"]), 4), "text": w["word"].strip()}
                 for w in seg.get("words", []) if w["word"].strip()]
        lines.append({"t0": round(float(seg["start"]), 4), "t1": round(float(seg["end"]), 4),
                      "text": text, "words": words})
    return {"source": "asr", "lines": lines} if lines else None


# --------------------------------------------------------------------- melody
MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]


def notes_from_f0(f0, voiced, vprob, times, min_dur=0.11, min_prob=0.5):
    """Confidence-gated note segmentation: only trust frames that are voiced AND above a
    probability threshold (kills spurious pyin notes on noisy vocals)."""
    events, cur = [], None
    for i in range(len(f0)):
        m = None
        if voiced[i] and vprob[i] >= min_prob and not np.isnan(f0[i]):
            m = int(round(69 + 12 * np.log2(f0[i] / 440.0)))   # hz→midi (librosa-free)
        prev = cur["midi"] if cur else None
        if m != prev:
            if cur and times[i] - cur["t0"] >= min_dur:
                cur["t1"] = float(times[i]); events.append(cur)
            cur = {"t0": float(times[i]), "midi": m} if m is not None else None
    if cur is not None:
        cur["t1"] = float(times[-1]); events.append(cur)
    out = []
    for n in events:
        if n.get("midi") is None:
            continue
        out.append({"t0": round(n["t0"], 4), "t1": round(n["t1"], 4), "midi": n["midi"],
                    "name": midi_to_name(n["midi"]), "hand": "R", "clef": "treble"})
    return out


def fix_octaves(notes):
    """Repair pyin octave / subharmonic errors: pull gross outliers toward the melody
    centre, then snap each note to the octave nearest its LOCAL contour so the melody
    sits where a singer actually sings, without flattening its shape."""
    if len(notes) < 3:
        return notes
    center = float(np.median([n["midi"] for n in notes]))
    for n in notes:                                  # coarse: fix 1-2 octave gross errors
        while n["midi"] < center - 10:
            n["midi"] += 12
        while n["midi"] > center + 10:
            n["midi"] -= 12
    for i, n in enumerate(notes):                    # fine: snap to local contour
        lo, hi = max(0, i - 6), min(len(notes), i + 7)
        c = float(np.median([notes[j]["midi"] for j in range(lo, hi)]))
        n["midi"] = min((n["midi"] - 12, n["midi"], n["midi"] + 12), key=lambda x: abs(x - c))
    for n in notes:
        n["name"] = midi_to_name(n["midi"])
    return notes


def snap_to_scale(notes, tonic_idx, mode):
    """Snap out-of-key melody notes to the nearest scale tone (like the chord clean-up) — kills
    chromatic garbage while keeping the tune's shape. Learner-first simplification (§17)."""
    scale = {(tonic_idx + d) % 12 for d in (MAJOR_SCALE if mode == "major" else MINOR_SCALE)}
    for n in notes:
        pc = n["midi"] % 12
        if pc in scale:
            continue
        for delta in (-1, 1, -2, 2):                 # nearest in-scale pitch
            if (pc + delta) % 12 in scale:
                n["midi"] += delta
                break
        n["name"] = midi_to_name(n["midi"])
    return notes


def merge_and_clean(notes, min_dur=0.11, max_gap=0.06):
    """Merge consecutive same-pitch notes across tiny gaps, then drop too-short blips."""
    if not notes:
        return notes
    notes = sorted(notes, key=lambda n: n["t0"])
    out = []
    for n in notes:
        if out and out[-1]["midi"] == n["midi"] and n["t0"] - out[-1]["t1"] <= max_gap:
            out[-1]["t1"] = n["t1"]
        else:
            out.append(dict(n))
    out = [n for n in out if n["t1"] - n["t0"] >= min_dur]
    for n in out:
        n["name"] = midi_to_name(n["midi"])
    return out


MEL_LO, MEL_HI = 48, 84                              # melody register band: C3 .. C6


def melody_from_notes(note_events):
    """Top-line (skyline) melody from polyphonic note events: at every moment take the highest
    active pitch WITHIN the melody register (so left-hand notes during melody rests, and
    spurious very-high notes, don't leak in). Works for piano (right hand) and vocals alike."""
    evs = [(float(s), float(e), int(p)) for (s, e, p, *_) in note_events if MEL_LO <= p <= MEL_HI]
    if not evs:
        return []
    bounds = sorted({t for s, e, _ in evs for t in (s, e)})
    segs = []
    for i in range(len(bounds) - 1):
        t0, t1 = bounds[i], bounds[i + 1]
        if t1 - t0 < 1e-4:
            continue
        mid = 0.5 * (t0 + t1)
        top = max((p for s, e, p in evs if s <= mid < e), default=None)
        if top is not None:
            if segs and segs[-1][2] == top and abs(segs[-1][1] - t0) < 1e-4:
                segs[-1][1] = t1                     # extend same pitch
            else:
                segs.append([t0, t1, top])
    return [{"t0": round(t0, 4), "t1": round(t1, 4), "midi": p, "name": midi_to_name(p),
             "hand": "R", "clef": "treble", "part": "melody"} for t0, t1, p in segs]


def transcribe_melody(audio, sr):
    """Polyphonic transcription (basic-pitch) -> top-line melody. Works on solo piano AND
    isolated vocals (unlike monophonic pyin, which grabs the loudest low note on piano)."""
    import os
    import tempfile
    import soundfile as sf
    from basic_pitch.inference import predict
    from basic_pitch import ICASSP_2022_MODEL_PATH

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    sf.write(tmp.name, np.asarray(audio, dtype=np.float32), sr)
    try:
        _, _, note_events = predict(tmp.name, ICASSP_2022_MODEL_PATH)
    finally:
        try:
            os.remove(tmp.name)
        except OSError:
            pass
    return melody_from_notes(note_events)


# ------------------------------------------------------------ synth (numpy, fast)
# Accompaniment instrument presets (§19): partials are (harmonic multiple, amplitude,
# decay time-constant in s) — upper partials dying faster is what reads as "piano".
INSTRUMENTS = {
    # percussive concert grand: rich harmonic stack, bright attack, natural decay
    "grand": {"attack": 0.004, "release": 0.06,
              "partials": ((1, 1.00, 1.6), (2, 0.45, 1.0), (3, 0.22, 0.7),
                           (4, 0.10, 0.5), (5, 0.05, 0.4))},
    # Rhodes-style electric piano: strong slow fundamental, fast "tine" bell at 4x,
    # softer attack, gentle tremolo (rate Hz, depth)
    "rhodes": {"attack": 0.008, "release": 0.08, "tremolo": (4.5, 0.10),
               "partials": ((1, 1.00, 2.2), (2, 0.10, 1.2), (4, 0.30, 0.35), (6, 0.04, 0.25))},
}


def np_tone(buf, midi, t0, t1, gain, instrument="grand"):
    ins = INSTRUMENTS.get(instrument, INSTRUMENTS["grand"])
    f = 440.0 * 2 ** ((midi - 69) / 12.0)
    start, end = int(t0 * SR_SYNTH), int(t1 * SR_SYNTH)
    end = min(end, len(buf))
    n = end - start
    if n <= 0:
        return
    t = np.arange(n) / SR_SYNTH
    sig = np.zeros(n)
    for h, amp, tau in ins["partials"]:
        if f * h >= SR_SYNTH / 2:                      # keep partials below Nyquist
            continue
        sig += amp * np.sin(2 * np.pi * f * h * t) * np.exp(-t / tau)
    if "tremolo" in ins:
        rate, depth = ins["tremolo"]
        sig *= 1.0 - depth * 0.5 * (1 - np.cos(2 * np.pi * rate * t))
    env = np.ones(n)
    a, r = int(ins["attack"] * SR_SYNTH), int(ins["release"] * SR_SYNTH)
    if a and a < n: env[:a] = np.linspace(0, 1, a)
    if r and r < n: env[-r:] *= np.linspace(1, 0, r)
    buf[start:end] += sig * env * gain


def render_accompaniment(melody, chords, dur, audio_dir, instrument="grand"):
    """One full accompaniment (§17): melody + the first-6-by-appearance root chords (learner
    simplification; the Player reveals up to 6 roots). Full & constant across all levels; the
    learner lowers the volume to wean off. Returns the relative audio path."""
    kept_roots = []
    for c in sorted(chords, key=lambda x: x["t0"]):
        r = c["notes"][0] % 12
        if r not in kept_roots and len(kept_roots) < 6:
            kept_roots.append(r)
    kept = set(kept_roots)

    buf = np.zeros(int((dur + 0.5) * SR_SYNTH), dtype=np.float64)
    for c in chords:
        if c["notes"][0] % 12 in kept:
            for m in c["notes"]:
                np_tone(buf, m, c["t0"], c["t1"], gain=0.06, instrument=instrument)
    for n in melody:
        np_tone(buf, n["midi"], n["t0"], n["t1"], gain=0.16, instrument=instrument)
    peak = max(1e-9, float(np.max(np.abs(buf))))
    buf = (buf * (0.9 / peak) * 32767).astype("<i2")

    wav = audio_dir / "accompaniment.wav"
    with wave.open(str(wav), "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR_SYNTH)
        w.writeframes(buf.tobytes())
    mp3 = encode(wav, audio_dir / "accompaniment.mp3", ["-b:a", "160k"])
    if mp3 and wav.exists():
        wav.unlink()
    return f"audio/{(mp3 or wav).name}"


def encode(src, dst, args):
    try:
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), *args, str(dst)], check=True)
        return dst
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


# --------------------------------------------------------------- key transpose
def transpose_song(slug, semitones):
    """Create a transposed variant of an analysed song (§18.3): shift the Song Map's MIDI +
    key, re-synthesise the accompaniment at the new pitches. The original reference audio is
    kept in its own key (§15) — copied across. Returns the new variant slug."""
    s = int(semitones)
    src = ROOT / "samples" / slug
    d = json.loads((src / "song_map.json").read_text(encoding="utf-8"))

    for n in d.get("melody", []):
        n["midi"] += s
        n["name"] = midi_to_name(n["midi"])
    for c in d.get("chords", []):
        c["notes"] = [x + s for x in c["notes"]]
        root_pc = c["notes"][0] % 12
        c["root"] = NAMES[root_pc]
        c["symbol"] = NAMES[root_pc] + ("m" if c.get("quality") == "min" else "")

    tonic_pc = (NAMES.index(d["key"]["tonic"]) + s) % 12
    d["key"]["tonic"] = NAMES[tonic_pc]
    d["key"]["relative_minor"] = (NAMES[(tonic_pc + 9) % 12] + "m") if d["key"]["mode"] == "major" else None

    vslug = f"{slug}__key_{NAMES[tonic_pc].replace('#', 's').lower()}"
    vdir = ROOT / "samples" / vslug
    (vdir / "audio").mkdir(parents=True, exist_ok=True)

    dur = (d.get("source") or {}).get("duration_s") or (d["melody"][-1]["t1"] if d.get("melody") else 1)
    d["audio"] = render_accompaniment(d["melody"], d["chords"], dur, vdir / "audio",
                                      instrument=d.get("instrument", "grand"))

    if d.get("reference") and d["reference"].get("audio"):        # keep original recording (its key)
        rn = d["reference"]["audio"].split("/")[-1]
        if (src / "audio" / rn).exists():
            shutil.copy(src / "audio" / rn, vdir / "audio" / rn)
        else:
            d["reference"] = None

    base_title = re.sub(r"\s*\(key .*\)$", "", d.get("title", "") or slug)
    d["title"] = f"{base_title} (key {d['key']['tonic']})"
    d["transposed_from"] = slug
    (vdir / "song_map.json").write_text(json.dumps(d, indent=2), encoding="utf-8")
    return vslug


# ------------------------------------------------------------------------ main
def analyze(path, title, artist, use_stems=False):
    import librosa
    path = Path(path)
    title = title or path.stem
    slug = slugify(title)
    out_dir = ROOT / "samples" / slug
    audio_dir = out_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading {path.name} …")
    y, sr = librosa.load(str(path), sr=22050, mono=True)
    dur = len(y) / sr

    # By default analyse the full mix. With --stems, separate and use the VOCAL stem for
    # melody and the BASS+OTHER (drums removed) for key/chords — much cleaner.
    y_mel = y_harm = y_beat = y
    if use_stems:
        print("Separating stems with Demucs (CPU) …")
        stems = separate_stems(path, sr)
        y_mel = stems["vocals"]
        y_beat = stems["drums"]                 # beats off the isolated drum stem…
        if float(np.sqrt(np.mean(stems["drums"] ** 2))) < 0.005:
            y_beat = y                          # …unless it's ~silent (drumless: piano+vocals) -> full mix
        n = min(len(stems["bass"]), len(stems["other"]))
        y_harm = stems["bass"][:n] + stems["other"][:n]

    print("Beat tracking …")
    tempo, beat_frames = librosa.beat.beat_track(y=y_beat, sr=sr, units="frames")
    bpm = float(np.atleast_1d(tempo)[0])
    # Collapse double-time locks to the FELT pulse. Drum stems (busy hats) often lock the
    # tracker an octave high; a learner wants the quarter-note pulse, not eighths. Tuned for
    # the ballad/learner case (a genuinely fast >140 BPM song would be halved — revisit later).
    while bpm > 140 and len(beat_frames) > 8:
        beat_frames = beat_frames[::2]
        bpm /= 2
    beat_times = librosa.frames_to_time(beat_frames, sr=sr)
    bpm = round(bpm, 1)

    print("Key + chords …")
    chroma = librosa.feature.chroma_cqt(y=y_harm, sr=sr)
    tonic0, mode, _ = detect_key(chroma.mean(axis=1))
    tonic_idx = NAMES.index(tonic0)

    # beat grid (drives the counter / metronome / notation)
    bpb = 4
    beats, downbeats = [], []
    for i, t in enumerate(beat_times):
        bib = (i % bpb) + 1
        beats.append({"t": round(float(t), 4), "beat": bib, "bar": i // bpb + 1})
        if bib == 1:
            downbeats.append(round(float(t), 4))

    # beat-SYNCHRONOUS raw chord per beat (median chroma between beats)
    tpls = triad_templates()
    beat_fr = librosa.time_to_frames(beat_times, sr=sr)
    sync = librosa.util.sync(chroma, beat_fr, aggregate=np.median, pad=False)
    raw = []
    for i in range(sync.shape[1]):
        _, qual, root, _ = best_chord(sync[:, i], tpls)
        t0 = float(beat_times[i])
        t1 = float(beat_times[i + 1]) if i + 1 < len(beat_times) else dur
        raw.append([t0, t1, root, qual])

    # refine + LOCK the key, then clean the chords to a simple diatonic progression
    tonic_idx, mode = refine_key(tonic_idx, mode,
                                 [{"root": NAMES[r], "quality": q, "t0": a, "t1": b} for a, b, r, q in raw])
    tonic = NAMES[tonic_idx]
    rel = (NAMES[(tonic_idx + 9) % 12] + "m") if mode == "major" else None
    chords = simplify_chords(raw, tonic_idx, mode, beats)

    print("Melody (basic-pitch, polyphonic → top line) …")
    melody = transcribe_melody(y_mel, sr)              # skyline melody from polyphonic notes
    melody = snap_to_scale(melody, tonic_idx, mode)    # learner-first: snap to key
    melody = merge_and_clean(melody)                   # merge + drop blips

    lyrics = None
    if use_stems:
        print("Transcribing lyrics (Whisper on the vocal stem) …")
        try:
            lyrics = transcribe_lyrics(y_mel, sr)
        except Exception as e:
            print(f"  lyrics skipped: {e}")

    print("Rendering accompaniment …")
    full_audio = render_accompaniment(melody, chords, dur, audio_dir)

    print("Encoding original as AAC reference …")
    ref_m4a = encode(path, audio_dir / "original.m4a", ["-c:a", "aac", "-b:a", "96k"])

    song_map = {
        "schema": "pianocoach.songmap/0.2",
        "title": title,
        "artist": artist,
        "synthetic": False,
        "source": {"file": path.name, "duration_s": round(dur, 3)},
        "audio": full_audio,
        "key": {"tonic": tonic, "mode": mode, "relative_minor": rel},
        "tempo": {"bpm": bpm},
        "time_signature": "4/4",
        "beats": beats,
        "downbeats": downbeats,
        "chords": chords,
        "melody": melody,
        "lyrics": lyrics,
        "reference": {
            "audio": f"audio/{ref_m4a.name}" if ref_m4a else None,
            "key": {"tonic": tonic, "mode": mode},
            "tempo_bpm": bpm,
            "align": {"mode": "identity"},
            "note": "original recording — real key & tempo; identity-aligned (session not reformatted)",
        } if ref_m4a else None,
    }
    out = out_dir / "song_map.json"
    out.write_text(json.dumps(song_map, indent=2), encoding="utf-8")

    print(f"\nDONE → {out}")
    print(f"  key {tonic} {mode} | {bpm} BPM | {len(beats)} beats | "
          f"{len(chords)} bars/chords | {len(melody)} melody notes | {dur:.1f}s")
    print(f"  open: http://127.0.0.1:8123/player/index.html?song=../samples/{slug}/song_map.json")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--title")
    ap.add_argument("--artist")
    ap.add_argument("--stems", action="store_true",
                    help="separate stems with Demucs (vocal->melody, bass+other->key/chords)")
    a = ap.parse_args()
    analyze(a.audio, a.title, a.artist, use_stems=a.stems)
