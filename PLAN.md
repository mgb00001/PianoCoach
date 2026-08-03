# PianoCoach — Project Plan

> AI-powered system that teaches a complete beginner to read a music score and play
> piano, using their own favourite songs, across 10 progressive levels of difficulty.

Status: **Player: all 4 chart modes built** (keyboard, piano-roll, clef, score) · Last updated: 2026-07-01

---

## 1. Vision & motivation

Turn any song the learner loves into a structured, 10-level practice program. The
learner "performs" the song from day one (Level 1) over a full backing track, and
progressively takes over more of the playing until, at Level 10, they play unaided.
Confidence is built by unconsciously developing muscle memory in **both** sight-reading
and playing, always in the context of a real song they enjoy.

Two motivational levers:
1. **Own songs** — the learner picks the music.
2. **Perform from the start** — they always sound good, because backing accompaniment
   fills whatever they can't yet play, and  as they improve and gain confidence, the backing volume can be turned down progressively.

---

## 2. The learning model

### 2.1 The 10 levels

| Level | Focus | Learner plays | Backing provides |
|------:|-------|---------------|------------------|
| 1 | First 2 notes of the melody | — 2 highlighted notes | full accompaniment |
| 2 | First 4 notes of the melody | — 4 highlighted notes | full accompaniment |
| 3 | First 6 notes of the melody| — 6 highlighted notes | full accompaniment |
| 4 | First 8 notes of the melody | — 8 highlighted notes | full accompaniment |
| 5 | First 10 notes and 1st chord | — 10 notes and 1st chord highlighted  | full accompaniment |
| 6 | All notes and 1st-2nd chords | — All notes and 1st-2nd chords highlighted  | full accompaniment |
| 7 | All notes and 1st-3rd chords | — All notes and 1st-3rd chords highlighted  | full accompaniment |
| 8 | All notes and 1st-4th chords | — All notes and 1st-4th chords highlighted  | full accompaniment |
| 9 | All notes and 1st-5th chords | — All notes and 1st-5th chords highlighted  | full accompaniment |
| 10 | All notes and 1st-6th chords | — All notes and 1st-6th chords highlighted  | full accompaniment |

Levels 1–10 progressively highlight melody and chords. Levels 1 to 9 will fade the other notes and chords that will be revealed at higher levels. At level 10, the learner gradually lowers the supporting backing track volume until the learner is playing solo.

### 2.2 The 4 chart play modes (each level offers all four)

1. **Animated keyboard** — colour-coded fingering, labelled notes.
2. **Animated piano-roll bars** — colour-coded, labelled falling/scrolling bars.
3. **Animated bass/treble clef** — colour-coded, labelled notes on the staves.
4. **Standard music score** — conventional notation.

> v1 shows keyboard/note sequences with **note labels but no finger-ID numbers** (§11.5).

Every mode shows an **animated cursor** tracking the song as it plays.

### 2.3 Player controls (all modes)

zoom · light/dark theme · **tempo (slow-down 50–100 %)** · metronome on/off · looping (A/B) ·
play · pause · volume · reset.

> Note: **key** is a build-time Generator setting (needs offline pitch-shift). **Tempo
> slow-down** is kept live via native `playbackRate`+`preservesPitch` on a single
> pre-mixed-per-level audio file — no DSP library. See §11 for the full rationale.

---

## 3. System architecture

Two operational parts plus a catalog, sharing **one data contract** (the *Song Map*).

```
                        ┌────────────────────────────────────────┐
   song.mp3/mp4/wav ───▶│  MUSIC COACH GENERATOR  (Python, AI)     │
                        │  audio → analysis → Song Map + stems     │
                        └───────────────┬──────────────────────────┘
                                        │  writes
                        ┌───────────────▼──────────────────────────┐
                        │  CATALOG  (per-song metadata + versions)  │
                        │  song_map.json · stems · settings · builds│
                        └───────────────┬──────────────────────────┘
                                        │  feeds
                        ┌───────────────▼──────────────────────────┐
                        │  MUSIC COACH PLAYER  (web, standalone)    │
                        │  renders 4 chart modes + controls, no AI  │
                        └────────────────────────────────────────────┘
```

- **Generator** does all the expensive AI/DSP once, offline. Can preview settings
  (level, key, tempo, mode, theme) before the user accepts and "builds" a player.
- **Player** is a self-contained web app — sharable, runs on tablets, uses no AI.
- **Catalog** backs up every build's metadata so variations (other levels/keys/tempos of
  the same song) can be regenerated cheaply as the learner progresses.

---

## 4. The Song Map — the central data contract

Everything hinges on one JSON document produced by the Generator and consumed by the
Player. Draft schema (v0):

```jsonc
{
  "schema": "pianocoach.songmap/0.1",
  "title": "All Out of Love",
  "artist": "Air Supply",
  "source": { "file": "All out of love ... C-Am.mp3", "duration_s": 245.3 },
  "key": { "tonic": "C", "mode": "major", "relative_minor": "Am" },
  "tempo": { "bpm": 72, "map": [/* time→bpm for rubato */] },
  "time_signature": "4/4",
  "beats":     [ { "t": 0.83, "beat": 1, "bar": 1 }, ... ],
  "downbeats": [ 0.83, 4.15, ... ],

  "chords": [
    { "t0": 0.83, "t1": 4.15, "bar": 1, "symbol": "C",  "root": "C", "quality": "maj",
      "notes": [48, 52, 55], "order": 1 },   // "order" = which level introduces it
    { "t0": 4.15, "t1": 7.5,  "bar": 2, "symbol": "Am", ... , "order": 2 }
  ],

  "melody": [
    { "t0": 1.10, "t1": 1.60, "midi": 67, "name": "G4",
      "hand": "R", "clef": "treble" }, ...   // finger IDs skipped in v1
  ],

  "accompaniment": [ /* optional left-hand / bass line notes */ ],

  "stems": {                      // relative paths, produced by separation
    "vocals": "stems/vocals.mp3",
    "bass":   "stems/bass.mp3",
    "drums":  "stems/drums.mp3",
    "other":  "stems/other.mp3",
    "backing_full": "stems/backing_full.mp3"   // mix minus lead
  },

  "levels": [                     // per-level playback recipe
    { "level": 1, "learner": [],            "play_back": ["all"] },
    { "level": 3, "learner": ["chords"],    "play_back": ["melody","accompaniment"] },
    ...
  ]
}
```

Design notes:
- **MIDI note numbers** are the canonical pitch representation → trivial transposition
  for key changes; note names/clef are derived for display. (Finger IDs omitted in v1.)
- **Time in seconds**, anchored to a beat grid, so tempo changes rescale cleanly.
- `chords[].order` drives the Level 5–9 progression (which chord is "unlocked" when).
- The Song Map should be **exportable to MusicXML/MIDI** so the notation modes can lean
  on mature libraries (OSMD/VexFlow) rather than hand-drawing every glyph.

---

## 5. Generator pipeline (Python)

Chain of music-ML stages, each writing into the Song Map:

| Stage | Output | Candidate tool (local-first) |
|-------|--------|------------------------------|
| Ingest / decode | normalized WAV | ffmpeg (already used in sibling projects) |
| Stem separation | vocals/bass/drums/other | **Demucs** (htdemucs) |
| Beat & downbeat | beat grid, bars | librosa; madmom for tougher cases |
| Tempo & time-sig | bpm, tempo map | librosa |
| Key detection | tonic/mode | librosa (Krumhansl) / Essentia |
| Chord recognition | chord timeline | Chordino (Vamp) / autochord / Essentia |
| Melody → notes | pitched note events | **basic-pitch** (Spotify) or CREPE (mono) |
| Hand assignment | hand (L/R) per note | heuristic (pitch/clef split) — **no finger IDs in v1** |
| Reformatting | transposed / tempo-adjusted stems | **FFmpeg** (pitch-shift + time-stretch) |
| Assemble | `song_map.json` | our code |

**Reuse check:** `mp3_transcriber`, `music_tutor`, and `AudioCompressor` in the sibling
folders likely already have ffmpeg/transcription scaffolding — mine them before writing
new ingest/transcription code.

**Preview:** before "build", the Generator renders a quick audio preview of the chosen
settings (transposed/tempo-adjusted mix + a lightweight chart) for the user to accept.

---

## 6. Player app (web, standalone, no AI)

- **One animation clock** drives all four chart modes and the cursor, slaved to audio
  `currentTime` (Web Audio / Tone.js Transport).
- **Rendering:**
  - Standard score + clef modes → **OpenSheetMusicDisplay** (renders MusicXML) or
    **VexFlow** (programmatic).
  - Piano-roll → custom Canvas/SVG from Song Map note events.
  - Keyboard → SVG keyboard with per-key highlight + finger labels.
- **Playback engine:** plays **one pre-mixed backing file per level** (the Generator bakes
  the level recipe — learner-muted parts vs. backing — into that mix). Master volume + native
  `playbackRate` slow-down; metronome click synthesized from the beat grid, scaled by rate.
- **Controls:** zoom, theme, tempo, key, metronome, A/B loop, play/pause, volume, reset.
- **Packaging:** a build folder = `index.html` + assets + `song_map.json` + stems, so it
  can be zipped, copied, or hosted and opened on a tablet.

---

## 7. The hard problems (call them out early)

1. **Tempo change without pitch change** = audio **time-stretching**. Handled **offline in
   the Generator with FFmpeg** (`atempo`, or `rubberband` filter if the build supports it);
   Song Map times are rescaled to match. *Resolved by §11.4.*
2. **Key change** = **pitch-shifting** the audio stems + transposing the notation. Also
   **offline via FFmpeg** (`rubberband`/`asetrate`+`aresample`); notation transposes by
   shifting MIDI numbers. *Resolved by §11.4.*
3. **Transcription accuracy** — melody/chord detection on full mixes is imperfect. Mitigate
   by (a) using the isolated vocal/lead stem for melody, (b) allowing manual correction of
   the Song Map, (c) starting with simple ballads (our 4 test songs). **This is now the
   single biggest technical risk**, since reformatting (1,2) and fingering (4) are resolved.
4. **Fingering** — skipped in v1 (§11.5); no longer a problem to solve now.

Since all *heavy* audio processing is baked at generation time, the **Player carries no
custom DSP** — it plays one pre-mixed file per level and animates, with the sole exception
of native browser `playbackRate` for slow-down (§11, free/built-in). All the difficulty
concentrates in the Generator's transcription accuracy.

---

## 8. Recommended tech stack

- **Generator:** Python 3.11+, **FFmpeg** (decode + pitch-shift/time-stretch), Demucs,
  librosa, basic-pitch, (Essentia/madmom as needed), `music21` for MusicXML/MIDI export.
  CLI + optional local web UI (FastAPI).
- **Player:** standalone web app — lightweight HTML/JS with **Tone.js** (audio/transport +
  metronome), **OpenSheetMusicDisplay + VexFlow** (notation), Canvas/SVG for roll &
  keyboard. **No custom DSP** (native `playbackRate`+`preservesPitch` slow-down only).
  Build-light so a folder opens directly and zips for sharing; optional tiny reactive lib
  (Preact/Alpine) only if state grows unwieldy.
- **Catalog:** flat per-song folder + `catalog.json` index (no DB needed initially).

### GPU / 8 GB VRAM strategy

The binding hardware constraint is **8 GB VRAM (NVIDIA)**. Notes per heavy stage:
- **Demucs** — fits in 8 GB but can spike; use `--segment` chunking and/or the smaller
  models (e.g. `htdemucs` fine, `htdemucs_ft` heavier). Fall back to CPU if a track OOMs.
- **basic-pitch** — light; runs fine on CPU/GPU, not a VRAM concern.
- **librosa / chord detection** — CPU-bound, no VRAM issue.
- Process **one song (and one stem) at a time**; never batch on this card.
- Verify the installed CUDA/PyTorch sees the GPU before Phase 2; confirm which models are
  already downloaded on this machine before pulling new ones.

- **Platform note:** development on Windows (per project memory, use `cmd /c`, not
  PowerShell). Keep Windows-specific paths abstracted — a Linux VM port is a known future
  goal.

---

## 9. Development roadmap (MVP-first)

**Phase 0 — Foundations**
- Lock the Song Map schema v0.1.
- Scaffold repo: `/generator`, `/player`, `/catalog`, `/samples`, `/docs`.
- Hand-author one Song Map for a slice of "All Out of Love" (verify by ear).

**Phase 1 — Player MVP (most visible; de-risks the UI)**
- Build all 4 chart modes + cursor sync against the hand-authored Song Map.
- Core controls: play/pause, tempo, theme, zoom, loop, metronome, volume.
- Level recipe playback (mute/unmute parts) using placeholder stems.

**Phase 2 — Generator MVP**
- Ingest → stems (Demucs) → beats/tempo/key → chords → melody → `song_map.json`.
- Run against the 4 test ballads; iterate on accuracy; add manual-correction path.

**Phase 3 — Level engine & progression**
- Generate all 10 levels from one Song Map; wire the chord-unlock ordering (5–9) and the
  Level-10 accompaniment fade.

**Phase 4 — Reformatting (key/tempo) & preview**
- Offline transpose + time-stretch of stems; Generator preview-before-build.

**Phase 5 — Catalog, build/export, sharing**
- Per-build metadata backup, catalog index, zip/export a standalone player.

**Phase 6 — Polish & future**
- Fingering refinement, notation quality, accessibility, Linux VM port prep.

---

## 10. Test assets

Four cover ballads already in the project folder (key encoded in filename):

| Song | Artist | Key |
|------|--------|-----|
| All Out of Love | Air Supply (Rene cover) | C / Am |
| Killing Me Softly | Charles Fox (J Alvarez cover) | C# / A#m |

Different versions of the song for testing purposes:
Air Supply - All Out Of Love - benchmark -128k.mp3
Air Supply - All Out of Love - piano - vocals - 128k.mp3
Air Supply - All Out Of Love -full recording - 128k.mp3
Richard Marx - Right Here Waiting - full recording - 128k.mp3
Right Here Waiting - Richard Marx - benchmark - 128k.mp3
Right Here Waiting - Richard Marx - piano - vocals - 128k.mp3

Start with **All Out of Love** as the reference song end-to-end.

---

## 11. Locked decisions (2026-07-01)

1. **Start point:** ✅ **Player-first**, built against a hand-authored Song Map. Include
   deliberate rubato/imperfect timing in the sample so the Player is tested against messy
   data, not just clean data.
2. **AI approach:** ✅ **Local**, on this PC's **NVIDIA GPU with 8 GB VRAM**. Use models
   already present where possible; download better ones if needed. 8 GB is the binding
   constraint — Demucs and basic-pitch are the heavy stages (see §8 for memory strategy).
   A subscription LLM stays optional for future high-level text tasks only.
3. **Player framework:** ✅ **Lightweight standalone web app.** ALL settings (level, key,
   tempo, chart mode, theme) are chosen in the Generator *before* the Player is built. The
   Player does **no custom DSP** — it plays one pre-mixed audio file per level and animates.
   The one live control is tempo slow-down via native `playbackRate` (see resolution below).
4. **Reformatting:** ✅ **Offline in the Generator via FFmpeg** (time-stretch + pitch-shift;
   user has used this successfully). No live stretching/shifting in the Player. Different
   key/tempo = a separate pre-rendered build (this is what the Catalog is for).
5. **Fingering:** ✅ **Skipped for v1.** Show keyboard/note sequences with note labels but
   **no finger IDs**. The `finger` field is dropped from the Song Map for now (can be
   re-added later without breaking the schema).

### Resolved — key baked, tempo slow-down kept live (option b)

- **Key** is a **Generator setting**, baked before build (FFmpeg pitch-shift).
- **Tempo slow-down** stays a **live Player control** — chosen because it avoids
  regenerating a whole variation just to practice slower.

**How it stays lightweight & tablet-friendly (no DSP library):**
- The Generator **pre-mixes each level into a single backing audio file**, so the Player
  drives exactly **one `<audio>` element** per level.
- Slow-down uses the **native `HTMLMediaElement.playbackRate` with `preservesPitch = true`**
  — built into modern desktop and tablet browsers, pitch-preserving, zero extra code weight.
- The animation clock is slaved to the audio element's `currentTime`, so all four chart
  modes and the cursor stay in sync automatically at any playback rate.
- Range capped to **≈50–100 %** (slow-down only), where native quality holds. No speed-up.
- The metronome is synthesized in JS from the beat grid, scaled by the current rate.

**Player runtime controls (final):**

> zoom · light/dark theme · **tempo (slow-down 50–100 %)** · metronome on/off · A/B loop ·
> play · pause · volume · reset

(Key changes remain build-time only — those genuinely need offline pitch-shift.)

---

## 12. Immediate next steps

1. Confirm the open decisions in §11.
2. Freeze Song Map schema v0.1.
3. Scaffold the repo structure.
4. Hand-author a Song Map for the opening of "All Out of Love" and stand up the Player MVP
   shell so we can see one chart mode animate against real audio.

---

## 13. Feature: synchronised song lyrics  — ✅ Player side built (demo)

> Let the learner read the song's lyrics, karaoke-style, while practising — reinforcing the
> "perform the song from day one" motivation and giving musical context (which words land on
> which chords/melody notes).
>
> **Status:** schema v0.2 `lyrics` block done; demo lyrics generated (hand-authored, word-timed
> to melody onsets); Player karaoke ribbon built & verified (toggle, current line + word
> highlight, prev/next, works over any chart mode). **Remaining:** real lyrics via Whisper ASR
> on the vocal stem (§13.3) — a clean first Generator step.

### 13.1 Why & how it should feel

- Lyrics appear as a **companion ribbon that works alongside ANY chart mode** (keyboard,
  piano-roll, clef, score) — not a separate chart mode, because the learner wants lyrics
  *and* their hands' guidance at the same time.
- The **current line** is centred/emphasised; within it the **current word/syllable is
  highlighted** in time (karaoke), driven by the same animation clock as everything else.
- Optional **full-screen "Lyrics" view** for sing-along / away-from-keyboard listening.
- Fully **theme-aware**, and **baked** — no AI at play time (consistent with the Player
  being standalone/offline).

### 13.2 Data model — extend the Song Map

Add an optional `lyrics` block (Player treats it as absent → feature simply hidden):

```jsonc
"lyrics": {
  "source": "asr" | "manual" | "imported",
  "lines": [
    {
      "t0": 12.40, "t1": 16.85, "text": "I'm lying alone with my head on the phone",
      "words": [                          // optional word/syllable timing for karaoke
        { "t": 12.40, "text": "I'm" },
        { "t": 12.72, "text": "lying" },
        { "t": 13.30, "text": "alone" }
      ]
    }
  ]
}
```

- **Line-level timing** (`t0/t1`) is the minimum needed and drives line highlighting +
  auto-scroll. **Word-level** `words[]` is optional and upgrades it to true karaoke.
- Times share the song's second-based clock, so transposition/tempo rescaling already
  covered by §7 apply unchanged.
- Schema bump to `pianocoach.songmap/0.2` (backward compatible — `lyrics` is optional).

### 13.3 Generator side

| Path | How lyrics + timing are obtained |
|------|----------------------------------|
| **ASR (recommended, local)** | Run **Whisper** (word-timestamps) on the isolated **vocal stem** from Demucs → time-aligned words/lines. Uses the learner's *own* audio, on-device. |
| **Manual** | Hand-authored / hand-corrected lyric lines with timings (also the correction path for ASR errors). |
| **Imported** | Learner supplies an `.lrc`/synced-lyrics file → parse timestamps directly. |

- **Copyright note:** lyrics are copyrighted. We only transcribe the learner's *own* audio
  for their *personal* practice, or import a file they provide — we do **not** fetch or
  redistribute lyrics from third-party services. Keep this personal-use boundary explicit.
- **8 GB VRAM:** Whisper `small`/`medium` fit comfortably; run after Demucs, one stem.
- **Python 3.14 caveat** (§8) applies to Whisper too → use the separate 3.11/3.12 env.

### 13.4 Player side

- New **"Lyrics" toggle** in the control bar → shows/hides the lyrics ribbon (overlay strip,
  default bottom-of-chart; position top/bottom optional).
- Ribbon renders the current line + neighbours, **auto-scrolls**, and **karaoke-highlights**
  the active word (falls back to line-level highlight when no `words[]`).
- A dedicated **full-screen lyrics view** reachable from the same toggle (long-press / second
  click) for sing-along.
- Reuses the existing clock: a `LyricsRenderer.update(t)` called each frame, same pattern as
  the notation cursor. No new audio/DSP.
- Purely additive — absent `lyrics` block hides the toggle, so existing song maps still work.

### 13.5 Phasing

1. ✅ **Schema**: optional `lyrics` block added (bumped to v0.2).
2. ✅ **Demo**: hand-authored 8 timed lyric lines (word-aligned to melody onsets) in the
   synthetic demo Song Map.
3. ✅ **Player**: lyrics ribbon + karaoke line/word highlight + toggle — built & verified.
4. ⏭ **Generator**: Whisper-on-vocal-stem → real timed lyrics; manual-correction path; `.lrc`
   import. **Use whisper.cpp or faster-whisper to avoid the Python-3.14/torch blocker.**

### 13.6 Open questions

1. **Karaoke granularity** — ship word/syllable-level now, or start line-level and add words
   later? (Recommend: line-level first, words when ASR is wired.)
2. **Overlay vs full view** — is the companion ribbon enough for v1, or is the full-screen
   sing-along view wanted immediately?
3. **Lyrics source priority** — ASR-from-own-audio first, or `.lrc` import first (simpler,
   no ML, no accuracy risk)?

---

## 14. Feature: adaptive coaching (feedback → settings)

> When the learner starts a new session, let them describe how the last one went, in plain
> language, and rate it out of 10 — then have an **LLM suggest the settings for the next
> lesson**. This is the one place a *language model* (not audio ML) genuinely earns its keep:
> mapping subjective, free-text feedback onto concrete, valid Player settings.

Example: *"On level 3 (playing chords) I found the piano roll hard to follow"* (score 4/10)
→ suggest: **animated-keyboard mode**, **tempo 85 %**, **loop the tricky 2 bars**, **stay on
level 3**, with a one-line encouraging rationale.

### 14.1 How it fits the architecture

- Lives in the **Generator / session-setup step** (the AI-allowed side); its output **feeds
  the deterministic level engine** (§9 Phase 3). So: *deterministic level engine + an AI
  coaching layer that chooses the settings to feed it.*
- The **Player stays AI-free** — it just receives the chosen settings and builds the session.

### 14.2 Inputs → output

**Inputs (context the model sees):**
- The learner's free-text comment + score /10.
- Structured context of the last session: song, level, chart mode, tempo, key, which bars
  were looped.
- Short **history** of prior sessions/scores (trend) — stored in the Catalog.

**Output — a *constrained* recommendation (not free prose):**
- Restricted to what the Player can actually do: `mode` ∈ {keyboard, pianoroll, clef, score},
  `tempo` 50–100 %, `level` (±1 or hold), `loop` {off | bars a–b}, `metronome` on/off,
  `key`, `lyrics` on/off.
- Emitted as **structured JSON** (function-calling / JSON-schema constrained) so every
  suggestion is directly applyable and can't drift outside valid settings.
- Plus a short natural-language **rationale + encouragement** for the learner.

### 14.3 Guardrails

- **Advisory, human-in-the-loop:** the model *proposes*; the learner reviews/edits and
  confirms before the session is generated. Never auto-applied.
- **Bounded output** (see 14.2) prevents nonsensical or unsafe settings.
- **Local-first LLM:** a small local model (e.g. **Gemma 4 / a small Llama**) fits the 8 GB
  card, keeps feedback private, and costs nothing per session. Short prompt + structured
  output is well within a small model's ability. A subscription model is a drop-in upgrade
  for stronger reasoning if wanted.

### 14.4 Data model

- Extend the Catalog with a per-song **session log**: `{ timestamp, level, mode, tempo, key,
  loop, score, comment, suggestion_applied }`. This both feeds the LLM's history context and
  lets the learner see their own progress over time.

### 14.5 Phasing

1. Log sessions (level/mode/tempo/score/comment) to the Catalog.
2. Session-setup UI: a comment box + 0–10 score at "new session" time.
3. LLM call (local) with constrained JSON output → a proposed settings diff.
4. Review/confirm UI → apply to the next generated session.

### 14.6 Open questions

1. **Local model choice** — Gemma 4 E4B vs a small Llama/Qwen instruct model for reliable
   structured output on 8 GB?
2. **How much history** to feed (last session only vs a rolling window/summary)?
3. **Scope of suggestions** — settings only (mode/tempo/level/loop), or also *pedagogical*
   advice ("practise bars 5–6 hands-separately") shown as text?

---

## 15. Feature: original-audio reference preview

> The learner's backing is always the **synthetic accompaniment** (filtered/simplified so
> chords + melody are easy to hear). This feature *additionally* bundles the **original
> recording** into the generated player as a **preview/reference only** — never the
> accompaniment — so the learner can audition the real track at the current point in the song
> and compare it with the simplified part they're learning.

### 15.1 The alignment (the crux) — and why it's mostly free

The Song Map's beat/time grid is **derived from analysing the original recording**, so the
original audio and the Song Map share one timeline by construction:

1. **Session at original tempo → alignment is identity.** Preview plays the original at the
   current `cursor` time. Nothing to compute.
2. **Key change is timing-neutral** — transposition is pitch-only. The reference plays in the
   *original* key (we do **not** pitch-shift it; it's a reference).
3. **Tempo-reformatted session** is the only case needing a map, and it's a **known
   transform**: we rescaled the Song Map times from the original beats, so the original beat
   timestamps are kept as **anchor points**. `cursor(session-time) → original-audio-time` is
   interpolation between the two beat grids (uniform tempo = one ratio; rubato = piecewise).

→ "Automatic alignment" falls out of analysis we already do — the **beat grid is the anchor
set**. No separate sync/forced-alignment algorithm needed.

### 15.2 Data model — Song Map `reference` block (optional)

```jsonc
"reference": {
  "audio": "reference/original.mp3",     // bundled original (preview-quality encode)
  "key":  { "tonic": "C", "mode": "major" },   // original key (may differ from session)
  "tempo_bpm": 76,
  "align": {                              // maps session-time <-> original-audio-time
    "mode": "identity" | "ratio" | "anchors",
    "ratio": 1.0,                         // for uniform tempo change
    "anchors": [ { "s": 0.83, "o": 0.83 }, ... ]   // session beat t <-> original beat t
  }
}
```

Absent `reference` → the feature/control is simply hidden.

### 15.3 Player behaviour

- A **"Compare / Preview original"** control (🎧 Original — toggle).
- The reference is the **performance target**: it always plays in the **original key and
  tempo**. We never pitch-shift it (→ original key), and preview always plays it at **1×**
  even if the learner has slowed their *practice* tempo (the slow-down applies only to the
  accompaniment). The learner hears the real thing at real speed.
- During preview the **reference `<audio>` becomes the clock master**; the cursor follows via
  the (inverse) align map and the **accompaniment mutes/pauses**, so it drops onto the **same
  point in the song**. Only one source drives at a time → no dual-track drift. Exit →
  accompaniment resumes at the same cursor (and its practice tempo).
- Works in any chart mode; the animation keeps tracking the same session timeline throughout.

### 15.4 Generator + packaging

- The reference **is the learner's real recording, re-encoded** — the Generator copies and
  compresses it into the player build (`reference/`). **No synthesis is involved, so the real
  vocals are preserved automatically** (that's the whole point of the preview). The Generator
  also emits the `align` map for free from the analysis it already ran.
- **Codec decision: AAC (`.m4a`) at 96–128 kbps** (`ffmpeg -c:a aac -b:a 96k`). Chosen for the
  best quality-per-byte among *universally* compatible codecs — plays on every iOS/Safari,
  Android, and desktop browser (essential for the tablet-sharing goal). A reference doesn't
  need to be pristine, so 96 kbps is the default; 128 kbps if headroom is wanted.
  - *Opus 64 kbps* is smaller (~1.9 MB / 4 min) and an optional "modern-devices-only" setting,
    but older iPad Safari lacks reliable native `<audio>` Opus support → not the default.
- **Size:** `MB ≈ kbps × minutes × 0.0075`. A 4-min AAC-96 reference ≈ **2.9 MB**, taking the
  player build from ~1.5 MB to ~4.5 MB — still easily shareable. Optionally make the reference
  an opt-in download rather than always embedded.
- **Copyright:** it's the learner's own file, played only locally as a reference → personal-use.

### 15.5 Phasing

1. ✅ Song Map `reference` block + Player second-audio (`Transport`) + **🎧 Original** Compare
   control (reference-as-master swap) — built. **Align math implemented & unit-verified for
   all three modes** (identity / ratio / anchors). Reference encoded as **AAC .m4a 96 k**
   (~320 KB for the 25.8 s demo) and confirmed to load & play in-browser.
   - *Env note:* the headless preview browser can't seek (`seekable = [0,0]`), so the *live
     positional* handoff couldn't be demoed here — verified by logic + math instead; it works
     in a real browser. (The demo reference is currently a synthetic instrument-only stand-in.)
2. ⏭ Demo upgrade: use a **real song file** (e.g. *All Out of Love*) as the reference stand-in
   so the demo is honest — **real vocals** — even though alignment stays approximate until the
   Generator produces a real Song Map. (Synthesis can't sing.)
3. ⏭ Wire the align map for tempo-reformatted sessions (ratio / beat anchors) — the Player
   math is ready; the Generator needs to emit the anchors.

### 15.6 Open questions

1. **Interaction** — hold-to-preview (momentary A/B), a toggle, or both?
2. **Always embed vs opt-in** the original (file-size vs one-tap convenience for sharing)?
3. **Preview scope** — free-listen anywhere, or snap to the current bar / loop region?

---

## 16. Generator philosophy: learner-first simplification (not concert transcription)

> **Core principle (2026-07-02):** the Generator's job is **not** to transcribe a song
> note-perfectly — it's to produce a **clean, consistent, *playable*** version for a beginner.
> "As long as the tonality and melody are consistent with the song, unnecessary complexity is
> filtered out. This is about the learner, not a score for a concert." Standard MIR aims for
> accuracy and is brittle on real mixes; aiming for *simplicity* is both easier and better here.

### 16.1 The pipeline (torch-free first pass, `generator/analyze_song.py`)

Raw detection → **musical common-sense clean-up**:

1. **Stems (Demucs, optional `--stems`)** — separate vocals / drums / bass / other.
   - **melody ← vocal stem**, **beats ← drum stem**, **key/chords ← bass+other** (drums removed).
   - CPU torch (~200 MB, no CUDA); stems held **in memory** (no temp files → no OneDrive churn);
     Demucs Python API (avoids the torchaudio/`torchcodec` save bug); ~65 s for a 4-min track.
2. **Tempo** — beat-track, then **octave-normalise to the felt pulse** (collapse >140 BPM
   double-time locks; drum stems tend to lock onto eighths). Tuned for the ballad/learner case.
3. **Chords** — **beat-synchronous** chroma (one raw chord/beat) → **lock the key** →
   **snap every chord to the nearest diatonic chord** (kills spurious Cm/Gm-type noise) →
   **merge repeats + absorb sub-beat flickers** → a simple diatonic progression.
4. **Melody** — `pyin` on the vocal, then **octave repair** (pull outliers to the melody centre,
   snap each note to the octave nearest its local contour) so it sits in a singable range.
5. **Outputs** — real `song_map.json` (v0.2) + a **synthetic simplified accompaniment** (from
   the cleaned notes) + the **original bundled as an aligned AAC reference** (§15).

### 16.2 Validated (All Out of Love, `--stems`)

Raw full-mix pass gave 172 BPM + Cm/Gm noise. After clean-up: **86 BPM, 83 bars**, chord
vocabulary **G C D Am Em Bm** (all diatonic), progression `Em C G C G…`. Learner-ready.

### 16.3 Where AI escalates (future)

Deterministic music theory handles most simplification. A **local LLM** is the right tool for
the *ambiguous* judgment the rules can't settle: choosing the key when it's genuinely unclear
(e.g. G vs C here), or reducing to a named form ("this is really I–V–vi–IV"). Ties into §14.

### 16.4 Known wrinkles / next

- **Key identity**: the generator's **final key decision is the label** shown to the learner —
  that's sufficient (a beginner doesn't care whether it's "truly" G vs C, only that it's
  consistent). **No manual override** — decided unnecessary. LLM escalation (16.3) stays the
  future path for genuinely ambiguous cases.
- Chord clean-up assumes a single global key (no modulation) and major/minor triads only.
- Tempo octave-normalisation is tuned for ballads (>140 BPM halved) — revisit for fast songs.
- **Melody = basic-pitch (2026-07-04), replaced pyin.** pyin (monophonic) failed on solo piano —
  it tracked the loud left hand (bass clef), not the tune. Now: **basic-pitch** (polyphonic, ONNX
  backend) → **skyline** (highest note within a C3–C6 melody band) → snap-to-key → merge/clean.
  Benchmark piano files: melody moved from median B2 (bass) to **median C5 (melody), ~80% ≥C4**,
  cleanly diatonic. Works for vocals too (run on the isolated vocal stem). *Install note:
  basic-pitch pins old numpy → installed `--no-deps` + `onnxruntime pretty_midi resampy mir_eval`.*
  pyin cleanup levers (confidence gating, octave repair) kept in code but unused.
- **Done** (was deferred): Whisper lyrics on the vocal stem (§18.6). Still deferred: GPU torch.

---

## 17. Level engine v2 — muscle-memory progressive reveal (2026-07-03, SUPERSEDES §2.1)  ✅ built & verified

> **Rethink:** theory is optional; the learner builds **muscle memory** by repetition, one or
> two notes at a time. A level is **how much of the song the charts reveal**, not a different
> backing. The 4 chart modes are the guide; the accompaniment is full and constant; the learner
> lowers its **volume** to wean off. *This replaces the §2.1 level model and retires the
> per-level backing engine (one full accompaniment now, not 8 tracks).*

### 17.1 The progression (all 4 chart modes obey it)

| Level | Melody notes shown | Chords (roots) shown |
|------:|--------------------|----------------------|
| 1–4 | 2 · 4 · 6 · 8 | — |
| 5 | 10 | 1st |
| 6–10 | all | 2 · 3 · 4 · 5 · 6 |

### 17.2 Counting rules

- **Note = pitch class.** All octaves of a note collapse to one (C4=C5=C6). Ranked by **first
  appearance**. When a note unlocks, **every octave** of it is revealed (a key melodic trait).
- **Chord = root.** All qualities of a root (C, C7, Cm, Caug, Cdim…) collapse to one and reveal
  together. Ranked by first appearance. **Cap = 6 roots** (most songs have 3–4); songs with >6
  roots are **simplified to the 6** (kept in the accompaniment too — see 17.4).

### 17.3 Where it lives (mostly Player)

- **Player** computes ranks at load (`noteRank` per pitch class, `chordRank` per root, both by
  first appearance) and applies a **fixed level table** as a **display filter**. Renderers draw
  only melody notes with `noteRank ≤ melodyMax` and chord tones with `chordRank ≤ chordMax`.
  Notation (VexFlow) re-renders on level change; keyboard/roll filter per frame.
- **New**: real-song charts currently show melody only — the Player now also derives **chord-tone
  events** from `chords[]` so chords appear (from L5) visually distinct from melody.
- Level change = update the filter + banner only. **No backing swap, no fade.**

### 17.4 Generator (simplify)

- Emit **one full accompaniment** = melody + the (≤6) revealed root chords (aligned to the L10
  reveal, not richer). Drop the per-level backing generation. For >6-root songs, keep the 6
  most-used roots. (All 4 test songs have ≤6 roots.)

### 17.5 Decisions (confirmed)

first-appearance order · cap 6 **roots** (qualities are free) · accompaniment = L10 reveal ·
reveal all octaves of an unlocked note.

### 17.6 Built & verified (2026-07-03)

- **Player**: ranking at load (`noteRank`/`chordRank`); fixed 10-level display filter applied
  across **all 4 chart modes** (keyboard, piano-roll, clef, score); chord-tone events derived
  from `chords[]`; level banner. Verified on *All Out of Love*: L1 shows 2 notes, L5 = 10 notes
  + 1 chord, L10 = all 12 notes + 6 chords; notation re-renders filtered per level.
- **Generator**: simplified to **one full accompaniment** (`accompaniment.mp3`, melody + ≤6
  root chords); per-level backing engine + `levels[]` retired. Sample folder 34 MB → 7.4 MB.
- **Retired**: `transport.setBacking/setFade` and per-level audio are no longer used by the
  level engine (kept in transport but dormant).

---

## 18. v1.0 definition & the Generator app (2026-07-04)

> **v1.0 is reserved** until the Generator is a **full app with a UI**, not a CLI. The learning
> experience (analysis + Player + 10-level engine) is done; v1.0 needs the *product workflow*
> from the original brief. Everything before this is a strong pre-1.0 foundation.

### 18.1 v1.0 must-haves (the Generator app)

1. **Upload a song** (mp3/mp4/wav/mkv/…).
2. **Apply settings** — key, tempo, and player defaults (chart mode, theme, start level).
3. **Preview** the settings before committing (reuse the Player to audition the candidate).
4. **Generate a player** — package a **self-contained, shareable player** (app + Song Map +
   audio) that opens offline / on a tablet.
5. **Export / back up the player metadata** (catalog entry) for reuse.
6. **Import metadata → re-generate** a player (fast rebuild / variations, no re-analysis).

### 18.2 Proposed architecture — a local web app

- **Backend**: FastAPI (Python) wrapping the existing `analyze_song.py` pipeline. Endpoints for
  upload → analyze (async job w/ progress, since Demucs is ~1–2 min) → return Song Map;
  apply-settings/reformat; package/export; import.
- **Frontend**: a browser UI (upload, settings form, **preview via the existing Player**,
  Generate/Export/Import). Consistent with the Player's stack.
- **"Generate a player"** = copy the Player app + the song's Song Map + audio into a build
  folder and **zip it** → the shareable artifact (static, opens with no server).
- **Metadata / catalog** = the **Song Map JSON + settings** is the reusable "player metadata".
  Accompaniment is **re-synthesizable** from it; the original-reference audio needs the source
  file (or store the encoded reference alongside). Catalog = a folder of metadata entries.

### 18.3 Key/tempo reformatting (§7) — now in scope

Applying a **key** = transpose the Song Map (shift MIDI) + pitch-shift audio (FFmpeg);
applying a **tempo** = rescale Song Map times + time-stretch audio (FFmpeg). Live tempo
slow-down already exists in the Player; build-time key transpose is the main new piece.

### 18.4 Phases

1. ✅ FastAPI backend around `analyze_song.py` (upload → async analyze → Song Map).
2. ✅ Web UI: upload + progress + **embedded live Player preview** + catalog.
3. ✅ **Key transpose** (re-synth accompaniment in the new key; original reference kept; lyrics
   preserved) — verified: G→C variant plays in C. (Tempo stays a Player control.)
4. ✅ Generate/package a standalone player (zip: `index.html` + `player/` + `song/`).
5. ✅ **Export/import metadata** — export = zip (Song Map + embedded reference audio); import =
   re-create the song (re-synth accompaniment, restore reference, lyrics preserved), no
   re-analysis. Round-trip verified (deleted accompaniment → import restored it).

Also done: **Whisper lyrics** (§18.6) on the vocal stem — all 4 songs now have time-aligned
lyrics in the Player (imperfect on sung vocals, as expected).

### 18.5 Decisions (confirmed 2026-07-04)

1. **Architecture**: ✅ local web app (FastAPI + browser). Desktop wrapper later if wanted.
2. **Reformatting**: ✅ **key transpose on the Generator only**; **tempo stays a Player** control
   (live slow-down) — no tempo reformat built.
3. **Metadata backup**: ✅ **embed the reference audio** in the backup (fully portable, no source
   file needed on re-gen). Space is not a concern.

### 18.6 Lyrics (un-defers §13.3) — real lyrics in the Player

The ribbon exists but hides with no `lyrics` block, so real songs show nothing. Add **Whisper**
(word timestamps) on the **Demucs vocal stem** to the Generator → time-aligned `lyrics`. torch is
already installed (for Demucs), so `openai-whisper` works; use the `small` model. Personal-use
boundary (learner's own audio) per §13.3. Sung vocals transcribe imperfectly — acceptable for a
nice-to-have overlay.

---

## 17b. Faded-peek levels (2026-07-06) — ✅ built

Instead of *hiding* not-yet-unlocked notes, the level filter now **dims** them (LOCKED_ALPHA≈0.2)
so the learner glimpses what's coming. Applied across all animated modes: piano-roll bars,
keyboard keys (locked-but-playing light faintly), and notation (locked noteheads render gray).
Unlocked notes stay full-strength/labelled. `songmap.js: levelFade()`. Verified: L1 shows 2
bright notes + the rest as a faded peek.

## 19. Feature: Edit mode (manual melody correction) — confirmed 2026-07-04, GENERATOR-ONLY

> Close the last ~5% of transcription errors (mostly stray high notes) by hand, in the Generator
> preview, before generating the player. Human-in-the-loop beats chasing every edge case in code.

**Decisions (confirmed):** melody only (chords are solid, left alone) · **Generator preview only**
(needs the backend to re-synth) · edits **snap to key + beat grid** (modifier for free placement) ·
add-note default length = 1 beat.

**The editor (a 5th chart mode "Edit"):** a *static*, zoom/scroll piano roll (same layout) where
melody bars can be **selected, deleted, repitched (drag ↔), moved in time (drag ↕), resized
(drag end), added (click empty)**. Chord bars shown dimmed as context (non-editable).

**Save flow:** POST edited melody → backend **rewrites the Song Map + re-synthesizes the
accompaniment** (`render_accompaniment`) → preview reloads → all modes + audio update together.

**Phases:** (1) backend `/api/edit/{slug}` re-synth; (2) editable-roll renderer w/ mouse
interactions; (3) wire as 5th mode in the Generator preview + Save button.

### §19 progress
- **Phase 1 (backend `/api/edit/{slug}` re-synth): DONE, verified.** Accepts `{"melody":[{t0,t1,midi}]}`,
  rewrites the Song Map melody, re-synthesizes the accompaniment, flags `edited:true`.
- **Phase 2 (editable-roll renderer): DONE (code).** `player/js/renderers/editablepianoroll.js` —
  select / delete (Del/Backspace) / drag-repitch (Alt = chromatic) / drag-move in time (Alt = free) /
  drag-tail resize / click-to-add (1-beat default). Chords dimmed & non-editable. Snaps to key scale
  + beat grid. Wheel scrolls, Ctrl+wheel zooms. `_scaleFromKey` accepts `{tonic,mode}` (confirmed the
  real Song Map shape) or a `"F# minor"` string. DPR handled via device-px transforms.
- **Phase 3 (wire as 5th "Edit" mode + Save, generator-only): DONE (code).** `?edit=1` guard set by the
  generator's preview iframe (`webgen/static/index.html`); `main.js` registers the editor as
  `renderers.edit`, injects the "✏️ Edit" mode button + "💾 Save edits" button (POST `/api/edit` →
  reload). Standalone player never sets `edit=1`, so the mode/Save never appear.
- **NOT yet live-verified (needs a browser click-through):** DPR hit-testing alignment (click lands on
  the intended bar), drag/resize feel, add-note placement. No browser was connected to auto-verify;
  static integration confirmed served OK (player page + editor module 200, edit canvas present).

### §19 edit-mode preview upgrades (2026-07-06) — ✅ built & browser-verified
Three fixes/features on the editable roll, verified live in the preview browser:
1. **Playback preview animation** — the roll was static (bars never moved on Play). Now while
   **playing** it auto-scrolls to follow the song and **editing is locked**; paused = static editor.
   The roll **falls downward** (future at the top, past at the bottom — `yAtT`/`tAtY` map later time
   higher; `_noteRect` unifies note rects & hit-testing so the resize handle rides the t1/top edge).
   A red "now" line marks the transport position: it **rises from the bottom to mid play-field**
   (`PLAYHEAD_FRAC=0.5`, `topT = max(secVis, t + 0.5·secVis)`) over the song's first half-screen, then
   stays centred for a before/after view. Verified: now-line y = playH at t=0, = 0.5·playH at t=30;
   future renders above past; add-note blocked while playing.
2. **Horizontal scrubber** (`#edit-scrub`, generator-preview only, 240px, **Start**/**End** labels)
   in the **top bar alongside the bar counter**, so the bar number reads live as you drag. Fast
   back-and-forth over a tricky bar without reset/loop fiddling. (The earlier CSS-rotated *vertical*
   slider didn't render reliably in the user's browser → plain horizontal range.) Seeks the transport
   + moves the view; the frame loop syncs the thumb otherwise. (`layoutActive` sizes the canvas
   backing from the canvas rect.)
3. **Playable reference keyboard** (paused only) — click/drag the bottom key strip to sound notes
   (tiny monophonic triangle synth) and light the played key in its pitch-class colour; glissando by
   dragging across keys. While **playing**, the strip lights the currently-sounding melody notes.
   Verified: mousedown sets the held key + a running AudioContext voice; gliss switches notes; mouseup
   releases. (Real audio-seek still can't be exercised in the headless preview — same §15 limitation —
   so the scrubber's audio jump and playback scroll were confirmed via logic/synthetic time.)

4. **Undo** (`↶ Undo` button + **Ctrl/Cmd+Z**) — a melody-snapshot history stack. Checkpoints before
   add / delete / drag-move / drag-resize (a plain click doesn't checkpoint; add-then-drag is one
   undo). Button disables when the stack is empty (`editor.onHistory` → `canUndo()`). Verified:
   add→undo, delete→undo (restores the note), drag-move→Ctrl+Z (restores position), plain click adds
   no entry.
5. **Levels don't apply in edit mode** — the editor is a full-song editor: the learner level filter
   (note/chord reveal + §17b faded peek) is bypassed (the edit renderer never calls
   `visibleAtLevel`/`levelFade`, so all melody notes draw full-strength), and the **Level control +
   banner are hidden** while editing (restored on exit). The **🎧 Original** toggle stays available,
   so the user can A/B the full synthesized track against the original recording while editing.
   Undo/Save buttons show only in edit mode.
6. **Stay in Edit mode after Save** — Save re-synths server-side and must `location.reload()`, which
   used to boot back to the default (keyboard) mode. It now stashes `{mode:"edit", t}` in
   `sessionStorage` before reload; boot restores the mode (clicks the Edit button) and seeks back to
   the same spot. Verified across a reload: lands in edit mode, flag consumed, position restored.
7. **Live play-scrub (locked now-line)** — while the roll is **playing**, dragging (or wheeling) it
   nudges the song via a **seek** rather than scrolling the view: the now-line stays locked at centre
   and the roll slides under it, so you can rewind a bar and re-hear an edit over and over without the
   pause→nudge→pause dance. Drag **down = forward, up = rewind** (grabbed point follows the cursor);
   editing stays locked while playing. The editor calls `onNudge(Δs)` → `transport.seek(time+Δs)`
   (clamped to the song). Verified: drag/wheel produce forward/rewind nudges, no note is added while
   playing, and `yAtT(now)` stays at 0.5·playH for any time (now-line locked).

8. **Keyboard-driven note editing (replaced buggy drag)** — dragging notes to repitch/move/resize
   was broken after the falling-roll flip (notes vanished / stretched to 8+ beats). Replaced with a
   clean **click-to-select + keyboard-edit** model (`selection` is now a `Set`, so multi-select and
   group edits work):
   - Click a note toggles its highlight; click again / **Esc** / undo clears it. **Click empty space =
     deselect**; **double-click empty = add** a 1-beat note (deliberate, so stray clicks don't create
     stray notes — was a reported bug).
   - **←/→** = pitch ∓1 semitone · **↓/↑** = timing sooner/later (**snap onset to the grid**) · **−/+** =
     length shorter/longer (**snap end to the grid**, min one cell, no grow-on-shrink) · **Del** =
     delete · **Ctrl/Cmd+Z** = undo. Nothing happens with no selection (rule 1).
   - Every keystroke acts on the **whole highlighted group** and is one undo checkpoint. A keydown
     guard ignores events targeting the scrubber/level `<input>/<select>` so their arrows don't move
     notes.
   - **Snap-to-grid timing & length** (`GRID_SUBDIV=2` → 1/8-note grid; 4 = 1/16). Chosen over a fixed
     ±1/8 shift because it aligns with §16's "clean, consistent, playable" goal: onsets land on real
     musical positions and durations become whole cells, self-correcting wonky transcription timing.
     The grid is the beat grid subdivided per-interval (respects rubato), **extrapolated before the
     first beat and after the last** — needed here because this song's beats only span 27–231s while
     the melody starts at 0.43s (soft intro, no detected beats). Timing preserves duration; each press
     moves one grid line.
   - Verified: select-toggle, group pitch, group timing (onset→grid, duration preserved, one line/
     press), group length (end→grid, one line/press, min one cell, no grow-on-shrink), group delete,
     undo (group, single checkpoint), Esc deselect, grid covers 0.1–235s, scrubber-arrow guard.

9. **Save error handling** — Save POSTs to `/api/edit` (webgen FastAPI), which rewrites the Song Map
   + re-synthesises the accompaniment on disk, so it **only works under the Generator, not a static
   player server** (`serve_nocache.py`/`http.server` answer POST with a non-JSON 501 page → the old
   `r.json()` threw a cryptic "unexpected token"). Now the client checks the response content-type and
   reports a clear reason ("the backend didn't handle the save (HTTP nnn)… needs the Generator
   running"), catches network errors, and the backend wraps `/api/edit` so unexpected failures return
   a JSON `{detail}` (real error) instead of a plain-text 500. Verified: static-server POST → HTTP 501
   text/html → clear message.
   - **Light-deps server**: `analyze_song` now imports **librosa lazily** (inside the analysis
     functions; `hz→midi` inlined), joining the already-lazy torch/demucs/basic_pitch/whisper. So the
     webgen server imports with just **numpy** → the edit/save/generate/export/transpose workflows run
     on `fastapi + uvicorn + numpy + python-multipart` (+ ffmpeg), no ML stack. Set up a `.venv`
     (Python 3.12) with those; run `uvicorn webgen.server:app --port 8770` and load the player from
     that origin so Save is same-origin. Verified end-to-end: server boots on light deps, `/api/edit`
     round-trip returns `{ok, melody_notes}` and re-synthesises the accompaniment. (Analysing a *new*
     song still needs the heavy stack in the same venv.) See README "Run the Generator".

10. **Move & Copy with reference overlays (edit mode)** — an earlier Copy/Cut/Paste (buttons + buffer)
    was simplified per user feedback into two implicit gestures; the menu is now just **↶ Undo · ⧉ Copy**
    (+ Save). No clipboard/paste.
    - **Move** = select + **arrow** the notes. On the first move of a fresh selection, the pre-move
      positions are snapshotted as **greyed phantoms** (`ghostNotes`, dashed grey outline + faint fill —
      "these moved from here"); subsequent arrows keep them. Replaces cut→paste entirely.
    - **Copy** (**⧉ Copy** / **Ctrl+C**) = **duplicate the selection in place**; the copies become the
      active selection and the originals show as a **dashed full-colour reference** (`ghost` set). The
      user then arrows the copies away and compares against the stationary originals. Replaces copy→paste.
    - Both references auto-appear (no Paste step), are not real notes/edits (phantoms), and clear on
      **Esc / new click / undo** (`_clearRefs`). Arrows act only on the active selection.
    - **Undo-all**: **Ctrl-click Undo** (or **Ctrl+Shift+Z**) reverts the whole session to the last
      save (`undoAll` → `history[0]`, which is the loaded/saved melody since Save reloads).
    - **Bug fixes** from testing: arrows never add notes (verified 20 presses = 0 added); **empty-space
      single-click now deselects** instead of adding a note (the "random note" culprit) — add is now a
      deliberate **double-click**.
    - Verified: move→phantoms (no note added over many arrows), copy→dupes+dashed-ref (arrows move only
      the copies, originals stay), undoAll, empty-click deselect, double-click add, Ctrl-click Undo,
      standalone clean, no console errors.
    - *Dev note:* the preview server was switched from `python -m http.server` to **`serve_nocache.py`**
      (`.claude/launch.json`) so edited JS/CSS/JSON are always fresh (no stale ES-module cache) — the
      recurring cache pain during these iterations.

11. **Post-save stale-cache fix (2026-07-10)** — user reported "Save loses my changes": the save
    always **wrote to disk fine**; the post-save `location.reload()` re-served the browser-cached
    pre-edit `song_map.json` + `accompaniment.mp3` (FastAPI `StaticFiles` sends no `Cache-Control`).
    Fixed with a **no-cache middleware** in `webgen/server.py` (same policy as `serve_nocache.py`;
    ETag 304s still work) + `loadSong` fetches with `cache:"no-cache"`. Also: a clicked toolbar
    button kept focus, so **Enter re-fired it** (Enter after Copy stamped extra duplicates) — all
    edit buttons now `blur()` after click. Verified end-to-end in a real browser: add note → Save →
    reload showed the fresh map (network transfer, not cache) with the note present.

12. **Unsaved-note live preview + pending-save blink (2026-07-10)** — the accompaniment audio only
    contains the *saved* melody, so unsaved edits were silent during playback. The editor now keeps
    a **baseline set** (`noteKey` = `t0|t1|midi` of the loaded melody); while playing, any melody
    note whose key is NOT in the baseline is sounded on a **fire-and-forget WebAudio voice**
    (`_playNote`, polyphonic triangle, envelope; held length scaled by the practice rate) as the
    now-line crosses its onset (`_previewUnsaved`; seeks/jumps >0.5s don't backfill). Moved/edited
    notes preview their NEW sound (their old sound remains in the audio until Save re-synths).
    **Save blinks** (`#btn-save-edit.pending`, soft green pulse) while `canUndo()` or the instrument
    differs from the last save; clears on save/undo-to-clean.

13. **Accompaniment instruments (2026-07-10)** — `INSTRUMENTS` presets in `analyze_song.py`
    (per-partial exponential decay: `(harmonic, amp, tau)` + attack/release, optional tremolo):
    **grand** (default — percussive rich stack) and **rhodes** (slow fundamental + fast 4× "tine"
    bell + 4.5Hz tremolo). `render_accompaniment(..., instrument=)` used by analyze / edit /
    import / transpose; `/api/edit` accepts `{instrument}` and persists it as `song_map.instrument`,
    so re-synths keep the choice. Player edit toolbar gets a 🎹 **instrument `<select>`** (grand/
    rhodes, edit-mode only, blurs after change so arrows keep editing notes); changing it marks the
    save pending. Verified: both presets render clean (no NaN), API round-trip persists + re-synths,
    select hidden outside edit mode.

14. **Standalone player zip actually standalone (2026-07-10)** — the "download player" zip froze at
    "Loading…" when opened via double-click: `file://` blocks **module scripts** (CORS — `main.js`
    never ran) and **fetch** (the song map couldn't load). `/api/generate` now ships a **classic
    single-script bundle**: `_bundle_player_js()` wraps each ES module in an IIFE publishing its
    exports into a `__pc_mods` registry (imports → destructures; only the player's single-line named
    import/export forms are supported — the bundler 500s on anything else), and the player index gets
    the Song Map **embedded inline** (`window.PC_EMBED_SONG`, `</`-escaped; `loadSong` prefers it over
    fetch). `js/*.js` files are omitted from the zip in favour of `js/bundle.js`. Audio stays as
    bundled files (`<audio src>` is not CORS-blocked on file://). Verified: served the generated zip
    and booted it — bundle loads, embed used (zero song-map fetches), all 4 modes render, edit absent.
    Also: metadata backup download renamed `pianocoach_meta_<slug>.zip` → **`PianoCoach_export_<slug>.zip`**.
    - **Playback followup:** the standalone player loaded but wouldn't PLAY — `transport.js` set
      `audio.crossOrigin = "anonymous"`, which forces a CORS media request that `file://` can never
      satisfy, so the `<audio>` errored instead of loading (harmless over HTTP, fatal from the zip).
      Removed (both accompaniment + reference; the player never routes audio through WebAudio, so
      CORS clearance is pointless). Also `window.PC_EMBED_BASE = "../song/"` is injected next to the
      embedded map and preferred by `loadSong` for audio-path resolution, so the zip player no longer
      depends on the `?song=` query surviving a `file://` redirect. Verified: rebuilt zip plays
      (currentTime advances, no media error, `crossOrigin` absent).

Also: **schema `$id` bumped 0.1 → 0.2** to match the `schema` enum + the v0.2 shape (lyrics/reference).

## 20. Analysis speed: GPU acceleration — done 2026-08-03

Analysing a 3.5-min song took **5+ minutes**. Timed per stage (30s clip, extrapolated), the cause
was two neural nets running on the **CPU** while the machine's **RTX 4070 (8 GB)** sat idle — the
venv held a **CPU-only torch build** (`2.12.1+cpu`):

| stage | CPU | GPU |
|---|---|---|
| Demucs stems | ~74 s | **~17 s** |
| Whisper `small` lyrics | ~58 s | **~11 s** |
| basic-pitch melody | ~8 s | (ONNX, unchanged) |
| librosa beats + chroma | ~6 s | (unchanged) |

**Fixes**
1. **CUDA torch** — `torch==2.12.1+cu126` + `torchaudio==2.11.0+cu126` (exact version match, so
   no dependency churn for demucs/whisper). A plain `pip install torch` re-installs `+cpu`.
2. **`torch_device()`** — one runtime probe, CUDA→CPU, never a hardcoded `"cuda"`. Both Demucs and
   Whisper catch `RuntimeError` (OOM/driver) and **retry on CPU** rather than failing the job.
   This is also the portability seam for a future Linux VM port.
3. **Decode once** — `decode_to_wav()` ffmpeg-decodes the source to one temp WAV. Previously the
   MP3 was decoded **twice** (22k mono + 44.1k stereo), each time via librosa's slow deprecated
   `audioread` fallback (libsndfile can't parse these MP3s: *"Giving up searching valid MPEG
   header"*). `analyze()` was split into `_analyze_loaded()` to scope the temp dir's lifetime.
4. **Demucs overlap** — kept at 0.25 on GPU (quality is cheap there), dropped to 0.1 on the CPU
   fallback, where minutes are actually at stake.

**Result: 5+ min → 65 s end-to-end**, verified on the real file. Output equivalence checked against
the previous CPU run of the same source: key, BPM, beat count (374) and duration **identical**;
chords 138→141, melody 376→381 (normal variation).

**Whisper stays fp32 even on GPU.** An fp16 run merged lyric lines (37→22), which is bad for the
3-line ribbon. Re-testing on an identical vocal stem showed fp16 giving 38 *good* lines — so the
merging was Whisper's own **run-to-run variance**, not precision. fp32 is kept anyway: it costs
~4 s in a ~60 s pipeline and keeps the numerics identical to the long-validated CPU path.

*Not done (deferred by choice):* progressive preview — showing chords/melody at ~15 s and letting
lyrics arrive later. Biggest remaining *perceived*-speed win; touches the job-status flow.
