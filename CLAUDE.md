# PianoCoach — project notes for Claude

## Antivirus history in this repo (read before creating .bat/.ps1 files)

The global `~/.claude/CLAUDE.md` documents this machine's Windows Defender restrictions on
creating executable scripts. It happened **in this repo**: a `Start PianoCoach.bat` launcher
(hidden PowerShell + TCP port-wait) was silently **quarantined** mid-session, and Defender then
blocked re-creating *any* file at that exact path (`Access denied` even for benign content).

Resolution that works and should be kept:

- The launcher is **`Launch PianoCoach.bat`** (new name, AV-safe content: `timeout` delay +
  `explorer` to open the browser, plain visible python/uvicorn — no hidden PowerShell, no sockets).
- The shutdown script is **`Stop PianoCoach.bat`** (netstat/taskkill on port 8770).
- Do **not** recreate anything named `Start PianoCoach.bat` — the path is quarantine-blocked.

## Environment quick facts

- **Analysis venv (the one that matters): `C:\AIProjects(local)\pianocoach-venv312\`** — Python
  3.12, kept **outside OneDrive** so 2.6 GB of CUDA torch isn't sync-churned. It holds the
  **CUDA** build (`torch==2.12.1+cu126`, `torchaudio==2.11.0+cu126`, installed from
  `https://download.pytorch.org/whl/cu126`). This is what `Launch PianoCoach.bat` now uses, and
  it makes song analysis **~5x faster (5 min → ~65 s)** on the machine's RTX 4070.
  ⚠️ A plain `pip install torch` silently installs the `+cpu` build and puts analysis back to
  ~5 minutes. If analysis is ever slow, check `torch.cuda.is_available()` **first**.
- Fallback venv: `.venv` in the repo (Python 3.12, ~1.2 GB, CPU-only torch). The launcher falls
  back to it only if the external venv is missing — everything still works, just slowly.
  In `cmd`, invoke with backslashes: `.venv\Scripts\python.exe`.
- Two-tier deps, split into `requirements.txt` (light — runs the Generator UI + edit/save) and
  `requirements-analysis.txt` (heavy — needed only to analyse a NEW song: librosa, torch,
  demucs, whisper, onnxruntime, pretty_midi, resampy, mir_eval). `basic-pitch` installs
  **separately with `--no-deps`** — it pins an old numpy; see PLAN.md §16.4 and README.md.
- `ffmpeg` must be on PATH (installed via winget Gyan.FFmpeg).
- Repo lives under OneDrive: if a file write fails with `EPERM ... rename`, retry with a direct
  write (`[IO.File]::WriteAllText`).

## Git / GitHub

- This repo is on GitHub as **`mgb00001/PianoCoach`** (public). `samples/` and
  `webgen/uploads/` are **git-ignored** (see `.gitignore`) — they hold commercial recordings
  the user uploads/analyses locally, never project code, and must never be committed or pushed.
  So is `.venv/` (1GB+) and any stray `*.mp3`/`*.m4a`/`*.wav` at the repo root (test audio the
  user drops there ad hoc). Double-check `git status`/`git diff --stat` before committing —
  don't `git add -A` blindly in this repo.
