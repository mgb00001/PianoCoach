# PianoCoach

AI-powered system that teaches a beginner to read a score and play piano, using their own
favourite songs, across 10 progressive levels. See [PLAN.md](PLAN.md) for the full design,
locked decisions, and a detailed build log.

## Repo layout

```
generator/   Generator pipeline (Python) — audio -> Song Map (beats/key/chords/melody/lyrics)
             analyze_song.py : the pipeline (Demucs stems, librosa, basic-pitch, Whisper)
             make_demo_song.py : synthesizes a self-consistent demo (stdlib + ffmpeg, no ML)
webgen/      Generator web app (FastAPI) — upload, analyse, preview, hand-edit, package, share
player/      Player (standalone web app, vanilla JS) — renders 4 chart modes, no AI at runtime
schema/      song_map.schema.json : the central Generator<->Player data contract
samples/     analysed songs land here (git-ignored — regenerate locally; see below)
catalog/     per-build metadata (future)
docs/        design notes
```

## Status

- **Song Map schema v0.2** frozen in `schema/song_map.schema.json` (beats, chords, melody,
  lyrics, reference-audio alignment).
- **Generator pipeline** (`generator/analyze_song.py`): Demucs stem separation, librosa beat/
  key detection, chord + melody transcription (basic-pitch), Whisper lyrics on the vocal stem,
  and a synthesised accompaniment (§17) in a choice of **Grand piano** or **Rhodes** instrument.
- **Generator web app** (`webgen/`, FastAPI): upload → analyse (async job) → **live preview** →
  **hand-edit the melody** → **key transpose** → **export/import metadata** → **package a
  shareable standalone player**. See "Run the Generator" below.
- **Player** (`player/`): lightweight vanilla-JS web app, no AI at runtime, works fully
  standalone (see "Share a song" below). Four chart modes, each honouring the 10-level reveal
  (§17) and the faded-peek preview of upcoming notes (§17b):
  - **Keyboard** — colour-coded, labelled active keys + upcoming-note glow.
  - **Piano roll** — colour-coded, labelled falling bars over a labelled keyboard strip
    (Synthesia-style), with a beat grid.
  - **Clef** — VexFlow grand staff (treble+bass), colour-coded + labelled notes, animated
    cursor that tracks the song and wraps across rows.
  - **Score** — the same grand staff as plain standard notation.
  - **Lyrics** ribbon (toggle) — karaoke: current line + word highlight, prev/next lines,
    works alongside any chart mode.
  - **🎧 Original** (Compare) — plays the bundled original recording, time-aligned to the
    cursor, as a reference (never mixed with the accompaniment); becomes the clock master
    while active so there's no dual-track drift.
  - **2-bar loop** with ± half-bar nudge arrows and an on-roll loop-region band.
  - Controls: play/pause, reset, **tempo slow-down 50–100%** (native pitch-preserving
    `playbackRate`), volume, zoom, metronome, A/B loop, light/dark theme, level selector,
    chart-mode switch. The animation clock is slaved to the `<audio>` element.
- **Edit mode** (§19, Generator preview only, `?edit=1`) — hand-fix melody transcription errors
  before sharing:
  - **Falling piano roll**, paused = static editor, playing = auto-scrolling preview with a
    locked centre now-line (drag/wheel while playing **nudges the song** without pausing).
  - **Click to select** (multi-select), then **←/→** = pitch, **↑/↓** = timing, **+/−** = length
    (all **snap to a beat-subdivision grid**), **Del** = delete. **Double-click** empty space
    adds a note (single-click never does, so stray clicks are safe).
  - **Move** = select + arrow — leaves a **greyed phantom** at the old position. **Copy**
    (⧉ / Ctrl+C) = duplicate in place — the original stays as a **dashed reference outline** so
    you can compare while arrowing the copy away.
  - **Undo** (Ctrl+Z) per edit; **Ctrl-click Undo** reverts everything back to the last save.
  - **Unsaved notes still sound** during playback (a WebAudio voice fills the gap until the
    accompaniment is re-synthesised on Save); the **Save button pulses** while there are
    unsaved changes.
  - **Instrument picker** (Grand piano / Rhodes) — applies on Save.
  - A playable reference keyboard along the bottom (paused only) for noodling.
- **Share a song**: "Generate player" packages a **fully standalone** zip — double-click
  `index.html`, no server needed (the ES modules are bundled into one classic script and the
  Song Map is embedded inline, since `file://` blocks both `fetch` and module scripts).
  "Export metadata" instead makes a small portable backup (Song Map + reference audio only,
  accompaniment re-synthesised on import) for re-creating/tweaking a song later.

## Run the Player (preview only — can't save edits)

Serve the repo root (so `/player` and `/samples` resolve) and open the player:

```
python serve_nocache.py 8123          # dev server; sends no-cache so edits are always fresh
# then open  http://127.0.0.1:8123/    (root redirects to the player)
```

(`python -m http.server 8123` also works, but the browser will cache ES modules — reloads may
serve stale JS. `serve_nocache.py` sends `Cache-Control: no-cache` to avoid that, while still
allowing `<audio>` Range seeking.)

Load a different Song Map with `?song=` (path relative to `/player/`):
`http://127.0.0.1:8123/player/index.html?song=../samples/<name>/song_map.json`

## Run the Generator (analyse songs, save edits, package/share)

The static player server above **cannot save Edit-mode changes or analyse new songs** — both
need the FastAPI backend. Setup is split into two dependency tiers so the app itself stays
lightweight; the heavy ML stack is only needed to analyse a brand-new song.

```
py -3.12 -m venv .venv                            # one-time (3.12: numpy has wheels; 3.14 too new)
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m uvicorn webgen.server:app --port 8770
# then open  http://127.0.0.1:8770/                (Generator UI; also serves the player)
```

**Easiest on Windows:** once the `.venv` exists, just **double-click `Launch PianoCoach.bat`** —
it starts the server and opens the browser for you (keep the console window open while you
work). To shut it down, **double-click `Stop PianoCoach.bat`** (or press Ctrl+C / close the
server window).

Load the player **from the Generator's origin** so Save (`/api/edit`) resolves same-origin:
`http://127.0.0.1:8770/player/index.html?edit=1&song=../samples/<name>/song_map.json`
(needs `ffmpeg` on PATH for the re-synth).

### Analysing a *new* song

Needs the heavy analysis stack (Demucs/torch, librosa, basic-pitch, Whisper) in the same venv
— a one-time, ~2 GB install:

```
.venv\Scripts\python.exe -m pip install -r requirements.txt -r requirements-analysis.txt
.venv\Scripts\python.exe -m pip install --no-deps basic-pitch     # separate: it pins an old numpy
```

`ffmpeg` must be on `PATH` (e.g. `winget install Gyan.FFmpeg` on Windows).

### Note on audio in this repo

`samples/` and `webgen/uploads/` are **git-ignored** — analysed songs (and any source
recordings you upload) stay local only, since they're derived from commercial recordings you
supply, not project code. Run the demo generator to get a self-consistent, copyright-free demo
song to try the Player with:

```
.venv\Scripts\python.exe generator/make_demo_song.py
```

## Not yet built (next)

- 10-level engine polish: per-level pre-mixed audio (currently the reveal is display-only —
  the full accompaniment always plays; see PLAN.md §17).
- Catalog / multi-song browsing UI beyond the Generator's flat list.
- Adaptive coaching (§14) and a packaged desktop wrapper are explored in PLAN.md but not started.
