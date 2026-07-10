"""
PianoCoach - synthetic demo song generator.

Produces a self-consistent demo for Player development: the audio and the Song Map
are generated from the SAME source data, so the animation is guaranteed to line up
with the sound. Uses only the Python standard library plus ffmpeg (for WAV->MP3).

This is NOT a transcription of the real recording. It renders an
"All Out of Love"-style ballad progression in C major / A minor so the Player can be
built and verified before the real (librosa/Demucs/basic-pitch) Generator exists.

Output: samples/demo_all_out_of_love/
    audio/demo_full.wav   (always)
    audio/demo_full.mp3   (if ffmpeg present)
    song_map.json

Run:  python generator/make_demo_song.py
"""

import json
import math
import random
import struct
import subprocess
import wave
from pathlib import Path

# ----------------------------------------------------------------------------- config
SR = 44100                     # sample rate
BPM = 76                       # ballad tempo
BEATS_PER_BAR = 4
SEC_PER_BEAT = 60.0 / BPM
SEC_PER_BAR = SEC_PER_BEAT * BEATS_PER_BAR

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "samples" / "demo_all_out_of_love"
AUDIO_DIR = OUT_DIR / "audio"

# Note name <-> MIDI helpers (C4 = MIDI 60) ----------------------------------------
_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def midi_to_name(m: int) -> str:
    return f"{_NAMES[m % 12]}{m // 12 - 1}"


def note(name: str) -> int:
    """'C4' -> 60, 'A#3' -> 58."""
    i = 2 if name[1] == "#" else 1
    pitch, octave = name[:i], int(name[i:])
    return _NAMES.index(pitch) + (octave + 1) * 12


def freq(m: int) -> float:
    return 440.0 * 2 ** ((m - 69) / 12.0)


# ----------------------------------------------------------------- musical content
# One chord per bar. "Axis"-style loop that fits an All Out of Love-ish ballad feel.
# (root_octave_triad = LH pad, melody drawn from chord tones one octave up)
CHORD_TABLE = {
    "C":  {"root": "C",  "quality": "maj", "triad": ["C3", "E3", "G3"]},
    "G":  {"root": "G",  "quality": "maj", "triad": ["G2", "B2", "D3"]},
    "Am": {"root": "A",  "quality": "min", "triad": ["A2", "C3", "E3"]},
    "F":  {"root": "F",  "quality": "maj", "triad": ["F2", "A2", "C3"]},
}

PROGRESSION = ["C", "G", "Am", "F", "C", "G", "F", "C"]   # 8 bars ~ 25s

# Original placeholder lyric (NOT a real song) — 8 lines x 4 words, one word per
# melody note, so the karaoke ribbon has something to highlight in the demo.
LYRIC_LINES = [
    ["Learn", "the", "song", "today"],
    ["note", "by", "note", "now"],
    ["chords", "will", "guide", "you"],
    ["melody", "is", "floating", "high"],
    ["steady", "is", "the", "beat"],
    ["let", "the", "music", "breathe"],
    ["soon", "it", "comes", "easy"],
    ["play", "and", "set", "free"],
]


def build_events():
    """Return (chords, melody, accompaniment) as lists of dicts with absolute times."""
    chords, melody, accomp = [], [], []
    unlock_order, seen = {}, 0

    for bar_idx, sym in enumerate(PROGRESSION):
        spec = CHORD_TABLE[sym]
        bar_t0 = bar_idx * SEC_PER_BAR
        bar_t1 = bar_t0 + SEC_PER_BAR
        triad_midi = [note(n) for n in spec["triad"]]

        # chord unlock order (each distinct chord gets the next order number)
        if sym not in unlock_order:
            seen += 1
            unlock_order[sym] = seen

        chords.append({
            "t0": round(bar_t0, 4), "t1": round(bar_t1, 4), "bar": bar_idx + 1,
            "symbol": sym, "root": spec["root"], "quality": spec["quality"],
            "notes": triad_midi, "order": unlock_order[sym],
        })

        # LH accompaniment: sustained triad across the bar
        for m in triad_midi:
            accomp.append(_note_event(m, bar_t0, bar_t1, hand="L", clef="bass"))

        # RH melody: 4 quarter notes cycling root-third-fifth-third, one octave above
        # the triad's root, giving clearly visible movement on the piano roll.
        tones = [triad_midi[0] + 12, triad_midi[1] + 12,
                 triad_midi[2] + 12, triad_midi[1] + 12]
        for beat, m in enumerate(tones):
            t0 = bar_t0 + beat * SEC_PER_BEAT
            t1 = t0 + SEC_PER_BEAT * 0.9          # slight detache
            melody.append(_note_event(m, t0, t1, hand="R", clef="treble"))

    return chords, melody, accomp


def _note_event(m, t0, t1, hand, clef):
    return {"t0": round(t0, 4), "t1": round(t1, 4), "midi": m,
            "name": midi_to_name(m), "hand": hand, "clef": clef}


# ---------------------------------------------------------------------- synthesis
def synth_tone(buf, m, t0, t1, gain):
    """Additive sine (a few harmonics) + ADSR into the float buffer `buf`."""
    f = freq(m)
    start, end = int(t0 * SR), int(t1 * SR)
    dur = end - start
    if dur <= 0:
        return
    attack, release = int(0.01 * SR), int(0.12 * SR)
    harmonics = [(1, 1.0), (2, 0.35), (3, 0.18), (4, 0.08)]
    for i in range(dur):
        n = start + i
        if n >= len(buf):
            break
        # envelope
        if i < attack:
            env = i / attack
        elif i > dur - release:
            env = max(0.0, (dur - i) / release)
        else:
            env = 1.0
        t = i / SR
        s = sum(a * math.sin(2 * math.pi * f * h * t) for h, a in harmonics)
        buf[n] += s * env * gain


def render_audio(melody, accomp):
    total_s = len(PROGRESSION) * SEC_PER_BAR + 0.5
    buf = [0.0] * int(total_s * SR)

    for ev in accomp:                       # softer pad
        synth_tone(buf, ev["midi"], ev["t0"], ev["t1"], gain=0.06)
    for ev in melody:                       # melody on top
        synth_tone(buf, ev["midi"], ev["t0"], ev["t1"], gain=0.16)

    peak = max(1e-9, max(abs(x) for x in buf))
    scale = 0.9 / peak
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    wav_path = AUDIO_DIR / "demo_full.wav"
    with wave.open(str(wav_path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = b"".join(struct.pack("<h", int(max(-1, min(1, x * scale)) * 32767)) for x in buf)
        w.writeframes(frames)
    return wav_path, total_s


def to_mp3(wav_path):
    mp3_path = wav_path.with_suffix(".mp3")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
             "-b:a", "160k", str(mp3_path)],
            check=True,
        )
        return mp3_path
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def to_aac(wav_path):
    """Encode the reference to AAC .m4a at 96k (the §15 codec decision)."""
    m4a_path = wav_path.with_suffix(".m4a")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav_path),
             "-c:a", "aac", "-b:a", "96k", str(m4a_path)],
            check=True,
        )
        return m4a_path
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def synth_noise(buf, t0, dur, gain):
    """Short filtered-noise burst (hi-hat / snare) with linear decay."""
    start = int(t0 * SR)
    n = max(1, int(dur * SR))
    for i in range(n):
        idx = start + i
        if idx >= len(buf):
            break
        buf[idx] += random.uniform(-1, 1) * (1 - i / n) * gain


def synth_kick(buf, t0, gain):
    """Bass-drum: a low sine with a fast downward pitch sweep and quick decay."""
    start = int(t0 * SR)
    n = int(0.14 * SR)
    for i in range(n):
        idx = start + i
        if idx >= len(buf):
            break
        t = i / SR
        f = 110 * math.exp(-t * 32) + 48
        buf[idx] += math.sin(2 * math.pi * f * t) * math.exp(-t * 16) * gain


def render_reference(melody, accomp, chords):
    """A full-BAND render on the SAME timeline as a stand-in 'original' — drums + a
    driving bass make it *obviously* different from the sparse synthetic accompaniment,
    so the Compare (🎧 Original) A/B is unmistakable in the demo. Instrument-only: a
    synthetic demo can't sing; real songs bundle the actual recording with real vocals.
    Identity-aligned to the Song Map for preview.
    """
    total_s = len(PROGRESSION) * SEC_PER_BAR + 0.5
    buf = [0.0] * int(total_s * SR)
    eighth = SEC_PER_BEAT / 2

    # DRUM KIT — the clearest "this is the full track" signal vs the piano-only backing
    for bar in range(len(PROGRESSION)):
        for beat in range(BEATS_PER_BAR):
            bt = bar * SEC_PER_BAR + beat * SEC_PER_BEAT
            synth_noise(buf, bt, 0.05, gain=0.10)                 # hat on every beat
            synth_noise(buf, bt + eighth, 0.035, gain=0.06)       # off-beat hat
            if beat in (0, 2):
                synth_kick(buf, bt, gain=0.9)                     # kick on 1 & 3
            if beat == 2:
                synth_noise(buf, bt, 0.09, gain=0.20)             # snare on 3

    # driving bass — root on every beat
    for c in chords:
        root = c["notes"][0] - 12
        t = c["t0"]
        while t < c["t1"] - 1e-6:
            synth_tone(buf, root, t, t + SEC_PER_BEAT * 0.55, gain=0.22)
            t += SEC_PER_BEAT
    # busy arpeggios (eighths, an octave up)
    for c in chords:
        tones = c["notes"]
        t, i = c["t0"], 0
        while t < c["t1"] - 1e-6:
            synth_tone(buf, tones[i % len(tones)] + 12, t, t + eighth * 0.9, gain=0.08)
            t += eighth
            i += 1
    for ev in melody:                       # lead (not dominant — the band carries it)
        synth_tone(buf, ev["midi"], ev["t0"], ev["t1"], gain=0.15)

    peak = max(1e-9, max(abs(x) for x in buf))
    scale = 0.92 / peak
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    wav_path = AUDIO_DIR / "reference.wav"
    with wave.open(str(wav_path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        frames = b"".join(struct.pack("<h", int(max(-1, min(1, x * scale)) * 32767)) for x in buf)
        w.writeframes(frames)
    return wav_path


def build_beats():
    beats, downbeats = [], []
    for bar in range(len(PROGRESSION)):
        for beat in range(BEATS_PER_BAR):
            t = round(bar * SEC_PER_BAR + beat * SEC_PER_BEAT, 4)
            beats.append({"t": t, "beat": beat + 1, "bar": bar + 1})
            if beat == 0:
                downbeats.append(t)
    return beats, downbeats


def build_levels():
    return [
        {"level": 1, "learner": [], "play_back": ["all"]},
        {"level": 2, "learner": [], "play_back": ["all"]},
        {"level": 3, "learner": ["chords"], "play_back": ["melody", "accompaniment"]},
        {"level": 4, "learner": ["melody"], "play_back": ["chords", "accompaniment"]},
        {"level": 5, "learner": ["melody", "chord:1"], "play_back": ["chords>1", "accompaniment"]},
        {"level": 9, "learner": ["melody", "chords"], "play_back": ["accompaniment"]},
        {"level": 10, "learner": ["melody", "chords", "accompaniment"], "play_back": ["fade"]},
    ]


def build_lyrics(melody):
    """One line per bar; each word timed to a melody-note onset (4 notes/bar)."""
    lines = []
    for bar, words in enumerate(LYRIC_LINES):
        bar_notes = melody[bar * 4:(bar + 1) * 4]
        wlist = [{"t": n["t0"], "text": w} for n, w in zip(bar_notes, words)]
        lines.append({
            "t0": round(bar * SEC_PER_BAR, 4),
            "t1": round((bar + 1) * SEC_PER_BAR, 4),
            "text": " ".join(words),
            "words": wlist,
        })
    return {"source": "manual", "lines": lines}


def main():
    chords, melody, accomp = build_events()
    wav_path, total_s = render_audio(melody, accomp)
    mp3_path = to_mp3(wav_path)
    audio_rel = f"audio/{(mp3_path or wav_path).name}"

    ref_wav = render_reference(melody, accomp, chords)
    ref_m4a = to_aac(ref_wav)
    ref_rel = f"audio/{(ref_m4a or ref_wav).name}"

    beats, downbeats = build_beats()

    song_map = {
        "schema": "pianocoach.songmap/0.2",
        "title": "All Out of Love (synthetic demo)",
        "artist": "PianoCoach demo generator",
        "synthetic": True,
        "source": {"file": None, "duration_s": round(total_s, 3)},
        "audio": audio_rel,
        "key": {"tonic": "C", "mode": "major", "relative_minor": "Am"},
        "tempo": {"bpm": BPM},
        "time_signature": "4/4",
        "beats": beats,
        "downbeats": downbeats,
        "chords": chords,
        "melody": melody,
        "accompaniment": accomp,
        "lyrics": build_lyrics(melody),
        "reference": {
            "audio": ref_rel,
            "key": {"tonic": "C", "mode": "major"},
            "tempo_bpm": BPM,
            "align": {"mode": "identity"},
            "note": "synthetic instrument-only stand-in (no vocals); identity-aligned for preview testing",
        },
        "levels": build_levels(),
    }

    out = OUT_DIR / "song_map.json"
    out.write_text(json.dumps(song_map, indent=2), encoding="utf-8")

    # drop intermediate WAVs once a compressed sibling exists (keep the folder light)
    if mp3_path and wav_path.exists():
        wav_path.unlink()
    if ref_m4a and ref_wav.exists():
        ref_wav.unlink()

    print(f"WAV : {wav_path}")
    print(f"MP3 : {mp3_path if mp3_path else '(ffmpeg not available - WAV only)'}")
    print(f"MAP : {out}")
    print(f"     {len(chords)} chords, {len(melody)} melody notes, "
          f"{len(beats)} beats, {total_s:.1f}s")


if __name__ == "__main__":
    main()
