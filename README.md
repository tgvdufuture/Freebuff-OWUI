# Freebuff Bridge

A **local** bridge between the Freebuff CLI and OpenWebUI: OpenWebUI talks to the
CLI as if it were an OpenAI backend, with no provider API in between.

The CLI is driven inside a PTY, like in a terminal, and everything it writes to
disk — transcript, log, turn state — is read back and rendered in OpenWebUI:
collapsed reasoning, tool calls, question cards, a quota bar, and import of past
conversations.

> **This is not a hosted service.** It is a single-user tool meant to run on your
> own machine, against your own Freebuff account.

## Read this before installing

- **It drives an agent on your machine, with your rights.** Every project you
  bind is read and written by the CLI, which can run commands inside it. Only
  bind directories you are willing to see modified.
- **One key for everything.** `data/api-key.txt` authenticates `/v1`, while the
  `/api/*` routes (project picker, chat binding) and `/diagnostic` are **not
  authenticated** — that is a deliberate choice for local use. Do not expose
  this on an open network: `BRIDGE_HOST` defaults to `127.0.0.1`, keep it that
  way. OpenWebUI itself listens on `0.0.0.0:8080` (LAN/PWA use) and has **no
  TLS**.
- **The quota is yours.** Opening a session costs one hour of the account's free
  quota, and the bridge keeps at most 3 sessions alive at once (beyond that it
  answers 429). Quota probes open a TUI without a prompt: they consume nothing,
  but allow 10 to 45 seconds per profile.
- **Everything rests on the CLI's format.** The TUI screen, `chat-messages.json`,
  `log.jsonl` and `run-state.json` are all parsed. A CLI update can break the
  bridge.
- **Windows first.** `node-pty`, `taskkill //T //F` and `.venv-owui/Scripts/*.exe`
  are used as-is, and the launch scripts are written for Git Bash. Linux and
  macOS are not supported today.

## Requirements

- **Node.js ≥ 22.6** (the TypeScript is executed directly, there is no build
  step).
- **Windows** with **Git Bash** (the `.sh` scripts are run by Git Bash; from
  PowerShell, `bash` resolves to WSL and fails).
- **Python 3.11** for OpenWebUI.
- **The Freebuff CLI installed**, with its profiles under `~/.config/<profile>/`.
  Every profile folder carrying a `credentials.json` is detected on its own,
  whatever it is named, and the bridge looks for the CLI binary inside that
  folder (`FREEBUFF_BIN` overrides it). The *contents* of `credentials.json` are
  never read — only its presence is checked. The bridge launches the CLI, it
  does not authenticate for you.

## Installation

```bash
# 1. The bridge
npm install

# 2. OpenWebUI into .venv-owui (native, no Docker)
py -3.11 -m venv .venv-owui
.venv-owui/Scripts/pip install --upgrade pip
.venv-owui/Scripts/pip install open-webui
```

The bridge keeps its state in `data/` (created on first start, ignored by git):
`api-key.txt`, `bindings.json`, `imports.json`, `profiles.json`, `quota.json`,
`turns.jsonl`, `logs/`.

It also writes **one file outside `data/`**: `<profile>/settings.json`, in the
Freebuff profile in use. That is where the model the CLI starts with is chosen,
so the bridge edits your CLI's own configuration file.

## Running

```bash
npm run start:all
```

The launcher probes your Freebuff profiles, keeps the one with **the most hours
left** (10 to 45 seconds per profile), starts the bridge, waits for it to answer
on `/health`, then starts OpenWebUI.

To skip the probe, or if your profiles are not under `~/.config/`, set them
yourself:

```bash
BRIDGE_PROFILE_DIR="$HOME/.config/my-profile" npm run start:all
```

**Worth knowing:** profiles are discovered by the `credentials.json` they carry,
under `~/.config/`, whatever their folder is called — the launcher probes them
all, the importer scans them all, and the CLI binary is taken from the profile
in use. `BRIDGE_PROFILE_DIR` and `BRIDGE_IMPORT_PROFILES` are only needed if
your profiles live somewhere else.

The two halves can be started separately:

```bash
bash scripts/start-bridge.sh   # bridge only (picks the profile, BRIDGE_STUB=0)
bash scripts/start-owui.sh     # OpenWebUI only (reapplies its patches)
```

`npm start` starts the bridge in **diagnostic** mode (no CLI is driven). Real
mode is `BRIDGE_STUB=0` — which is what `start-bridge.sh` does.

`start-owui.sh` reapplies three patches to the installed OpenWebUI (checkbox
cards, folder sorting by activity, project picker button). They are idempotent
and **fail loudly** if OpenWebUI changed its code: an OpenWebUI update shows up
immediately instead of lying in the interface.

## Connecting OpenWebUI

In OpenWebUI → **Settings → Connections**, add an OpenAI connection:

| Field | Value |
|---|---|
| URL | `http://127.0.0.1:7799/v1` |
| Key | the contents of `data/api-key.txt` |

Then disable, in **Admin → Settings**, title generation, tag generation,
follow-up suggestions and autocomplete: those tasks call the model and would
start pointless CLI turns.

## What the bridge adds

- **Quota bar** (account and current session) and **profile switching** in the
  OpenWebUI sidebar.
- **Project picker**: a chat is created already bound to the directory you pick.
- **iMessage-style bubbles**: shades of black and white only — a solid bubble
  for your own messages, one light bubble per run of paragraphs from the model,
  and one per tool call. OpenWebUI's own **Settings → Interface → chat bubbles**
  switch is the only knob: turn it off and the whole style is gone, without a
  restart.
- **Import** of past CLI conversations into OpenWebUI, one folder per project,
  with periodic sync and crash recovery.
- **`/recover`** inside a chat: re-reads the answer of an interrupted turn
  without starting a CLI.
- **`/import [n]`**: resumes a past conversation in a live session.
- **Agent questions** rendered in the thread, the answer is forwarded to the CLI.
- **Clickable links** for suggested follow-ups, a **Continue button** when the
  free session ends, a **Windows toast** at the end of a turn.
- **Stop** a running turn from OpenWebUI.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `BRIDGE_PROFILE_DIR` | `~/.config/freebuff` | Freebuff profile in use (skips the probe). |
| `BRIDGE_PROJECTS_ROOT` | `D:/code` | Roots of bindable projects, separated by `;`. **Set this** if your repositories live elsewhere. |
| `FREEBUFF_BIN` | the binary inside the profile, else `~/.config/manicode/freebuff.exe` | Path to the CLI binary. |
| `BRIDGE_PORT` | `7799` | Bridge port. |
| `BRIDGE_HOST` | `127.0.0.1` | Bridge listen address. |
| `BRIDGE_DATA_DIR` | `./data` | Local state (key, bindings, quota, turns). |
| `BRIDGE_API_KEY` | generated into `data/api-key.txt` | Key expected by `/v1`. |
| `BRIDGE_STUB` | `1` | `0` = real mode (CLI is driven). |
| `BRIDGE_MAX_SESSIONS` | `3` | Concurrent CLI sessions. |
| `BRIDGE_OWUI_URL` | `http://127.0.0.1:8080` | Redirect target (Continue button). |
| `BRIDGE_OWUI_KEY` | — | OpenWebUI API key for import (Settings → Account → API keys). A session token will not do: it expires. |
| `BRIDGE_IMPORT_INTERVAL_MS` | `900000` (15 min) | Sync cycle; `0` disables it. |
| `BRIDGE_IMPORT_PROFILES` | every profile under `~/.config` | Profiles scanned on import, separated by `;`; absolute paths allowed. |
| `BRIDGE_IMPORT_MODEL` | default archive model | Model advertised on imported chats. |
| `BRIDGE_ASK_CARD` | `0` | `1` = OpenWebUI native question card. |
| `BRIDGE_TURN_TIMEOUT_MS` | `2700000` (45 min) | Absolute ceiling for a turn. |
| `BRIDGE_TURN_IDLE_MS` | `600000` (10 min) | CLI inactivity after which the turn is rendered. |
| `BRIDGE_ACTIVITY_AFTER_MS` | `5000` | Delay before the activity marker appears in the stream. |
| `BRIDGE_CAPTURE` | `0` | `1` = write request bodies (prompts) to disk. |

## Layout

```text
src/freebuff/   driving the CLI: PTY, screen, transcript, quota, import
src/            HTTP server, bindings, diagnostics, models
scripts/        launching, import, recovery, OpenWebUI patches
test/           test suite (node:test)
sandbox/        test benches used by the quota probes
```

## Tests

```bash
npm test           # full suite (node:test)
npm run typecheck  # tsc --noEmit
npm run check-owui # checks the OpenWebUI patch in headless Chrome
```

`check-owui` exits `0` when the patch is compliant, `1` when it is not, and `2`
when it cannot be verified (OpenWebUI or Chrome missing).

## License

AGPL-3.0-only — see [LICENSE](LICENSE). OpenWebUI is a separate project under its
own license: this repository does not redistribute it, it installs and patches it
on your machine.
