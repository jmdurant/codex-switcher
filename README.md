<p align="center">
  <img src="src-tauri/icons/logo.svg" alt="AI Account Switcher" width="128" height="128">
</p>

<h1 align="center">AI Account Switcher</h1>

<p align="center">
  A desktop application for managing multiple AI coding accounts across Codex and Antigravity<br>
  Switch accounts, monitor live usage, schedule warm-ups, and stay in control of your quota
</p>

## Features

- **Multi-Account Management** – Add, rename, mask, import, export, and manage multiple Codex and Antigravity accounts in one place
- **Quick Switching** – Switch between accounts from the main window, native tray menu, or tray popup while preserving rotated ChatGPT sessions
- **Usage Stats** – View account usage stats for OAuth accounts, including lifetime tokens, daily buckets, streaks, activity insights, and top integrations
- **Manual Reset Credits** – See available manual reset credits beside each account plan badge, with the closest expiry highlighted as it approaches
- **Automatic Warm-Up** – Warm up one account or all accounts manually, after each 5-hour reset window, or at specific scheduled times of day
- **System Tray Controls** – Use the tray popup to switch accounts, inspect quota and active-account stats, refresh usage, open the main window, or quit the app
- **Tray Display Modes** – Choose between the app icon with session percentage, a text-only hourly/weekly percentage display, or a hidden tray icon
- **macOS Dock Control** – Keep AI Account Switcher in the Dock or run it as a menu bar only app, with a first-close prompt and a tray fallback
- **Rate-Limit Monitoring** – View real-time 5-hour session and weekly usage, reset timing, credits, and subscription expiry
- **Blocked Switch Recovery** – Detect running Codex sessions and offer a force-close flow before retrying the account switch
- **IDE Terminal Resume (experimental)** – With the companion extension installed, resume Codex and `agy` sessions in VS Code or Antigravity integrated terminals after a forced profile switch
- **Dual Login Mode** – Authenticate with ChatGPT OAuth or import existing `auth.json` files
- **Antigravity / Gemini Sessions** – Capture and switch Antigravity desktop sessions; the `agy` CLI uses the same selected session

## Installation

### Download a Release

The easiest way to install AI Account Switcher is from the latest GitHub release:

[Download the latest release](https://github.com/jmdurant/codex-switcher/releases/latest)

Choose the file for your platform:

- **macOS Apple Silicon:** `Codex.Switcher_*_aarch64.dmg`
- **macOS Intel:** `Codex.Switcher_*_x64.dmg`
- **Windows:** `Codex.Switcher_*_x64-setup.exe` or `Codex.Switcher_*_x64_en-US.msi`
- **Linux Debian/Ubuntu:** `Codex.Switcher_*_amd64.deb`
- **Linux AppImage:** `Codex.Switcher_*_amd64.AppImage`
- **Linux RPM:** `Codex.Switcher-*-1.x86_64.rpm`

> **macOS:** current release builds are not Apple-notarized. If macOS says the
> app is damaged, move it to `/Applications` and remove the quarantine flag:
>
> ```bash
> sudo xattr -dr com.apple.quarantine "/Applications/AI Account Switcher.app"
> open "/Applications/AI Account Switcher.app"
> ```

### Auto Updates

AI Account Switcher checks the latest release from `jmdurant/codex-switcher` on startup. When a newer signed
update package is available, the app shows an update prompt and can install it
from inside the app.

Fork release setup: the public updater key in `src-tauri/tauri.conf.json` is still
inherited from upstream. Before publishing this fork's updates, replace it with
your own public key and configure the matching `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub Actions secrets. Keep the private key
out of the repository. The release workflow publishes the signed packages and
`latest.json`; until a release exists, the startup check has no update to offer.

### Build from Source

#### Prerequisites

- [Node.js](https://nodejs.org/) (v24 LTS; also runs the TypeScript tests directly)
- [pnpm](https://pnpm.io/)
- [Rust](https://rustup.rs/)

```bash
# Clone the repository
git clone https://github.com/jmdurant/codex-switcher.git
cd codex-switcher

# Install dependencies
pnpm install

# Run in development mode
pnpm tauri dev

# Build for production
pnpm tauri build
```

> **Windows:** the `pnpm tauri` script runs through a POSIX shell wrapper
> (`sh ./scripts/tauri.sh`) and will not work in PowerShell/CMD. Use the
> `tauri:win` script instead: `pnpm tauri:win dev` and `pnpm tauri:win build`.

The built application will be in `src-tauri/target/release/bundle/`.

#### macOS development

Install Xcode or its Command Line Tools (`xcode-select --install`) and the Rust
toolchain; see [Tauri's macOS prerequisites](https://v2.tauri.app/start/prerequisites/#macos).
The same `pnpm tauri dev` command works on Apple Silicon and Intel. Tauri loads
`src-tauri/tauri.macos.conf.json` automatically for the native title bar.

To build and install the app and its companion extension in one step:

```bash
pnpm install:macos
```

This packages the VSIX, builds an optimized locally signed `.app`, installs it
in `/Applications`, automatically installs and verifies the extension in detected
VS Code/Insiders and Antigravity IDE installations, and opens the switcher. An
existing `Codex Switcher.app` installation is upgraded in place. Quit the switcher
before upgrading; reload open editor windows afterward to activate the extension.
Editors that are not installed are skipped. Editor discovery uses app bundles
and Spotlight, so the `code` command does not need to be on your shell's PATH.
The extension is installed in each editor's default profile; custom profiles can
use the editor CLI's `--profile` option with the VSIX.

Use `pnpm install:macos --debug` for a faster development build, or append
`--skip-build` to install existing artifacts. To install the extension after
adding another editor, run `pnpm install:extensions:macos`.
This automation belongs to the scripted installer; dragging a DMG app into
Applications does not run the extension installer.

To build a local `.app` without release updater signing keys:

```bash
pnpm tauri build --debug --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

The app is written to `src-tauri/target/debug/bundle/macos/AI Account Switcher.app`.
For an optimized local build, omit `--debug` and use the `release` output directory.
The `macOS checks` workflow runs native Rust and frontend tests, checks the Intel
target, packages the companion extension, and builds a local app on pull requests.

Codex account switching, process detection, Dock/menu bar settings, and launch at
login have macOS implementations. Antigravity / agy also supports macOS Keychain
capture/switching, process detection and force-close, live usage, and reopening
Antigravity IDE for terminal resume. Linux Antigravity credential and usage
integration remains unimplemented.

### IDE Terminal Resume Companion

The optional companion extension lets a forced account switch return an active
Codex or `agy` session to its VS Code-compatible integrated terminal. It uses
terminal shell integration to capture the tool and working directory, then runs
`codex resume --last` or `agy --continue` after the switch. If Antigravity must
close for its credential replacement, the switcher reopens it and the extension
creates a replacement terminal in the original workspace.

```bash
pnpm --dir ide-extension run package
code --install-extension ide-extension/ai-account-switcher-resume.vsix --force
antigravity-ide --install-extension ide-extension/ai-account-switcher-resume.vsix --force
```

Packaging works on macOS/Linux with `zip` installed (included with macOS), and
on Windows with PowerShell. The editor CLI must be available on your `PATH`.

The bridge is local-only, does not copy credentials, and becomes a no-op when
the extension is absent or no matching integrated-terminal command is active.
VS Code terminal shell integration must be enabled. Sessions in remote extension
hosts are intentionally excluded.

### Run the Dashboard in a Browser

You can also serve the built dashboard over HTTP instead of opening the Tauri shell.

```bash
# Build the frontend and start the web server on 0.0.0.0:3210
pnpm lan
```

Optional environment variables:

- `CODEX_SWITCHER_WEB_HOST` to override the bind host
- `CODEX_SWITCHER_WEB_PORT` to override the port

The browser dashboard serves the same UI and backend actions through `/api/invoke/*`, which makes it usable over LAN, Tailscale, or a remote host tunnel when you expose the chosen port safely.

## Usage and Reset Credits

Codex Switcher shows two kinds of account usage information:

- **Rate limits** – the account card shows the current 5-hour and weekly limit
  windows, remaining percentage, reset timing, credit balance, and subscription
  expiry when available.
- **Usage Stats** – ChatGPT OAuth accounts can expand the **Usage
  Stats** panel to view stats such as lifetime tokens,
  today, last 7 days, last 30 days, streaks, longest task, token activity,
  reasoning/activity insights, and most-used integrations. The active account
  opens this panel by default; other accounts keep it collapsed until needed.
- **Manual reset credits** – OAuth accounts with available reset credits show a
  compact badge next to the plan badge. It includes the available count and the
  closest expiry date, hides zero-count results, and turns amber within 10 days
  or red within 3 days of expiry.

The tray popup also includes compact active-account stats for today and
the last 7 days, while keeping the normal rate-limit refresh flow separate.

## Safe Account Switching

The desktop dashboard automatically detects the current Codex login from
`$CODEX_HOME/auth.json` (normally `~/.codex/auth.json`) on startup, when focused,
and every 30 seconds. **Add current login** saves that session in the switcher
without writing Codex's credentials or interrupting running sessions. Existing
matching accounts are reused, preserving their names and masking settings;
personal and team workspaces remain separate. This detection covers file-based
Codex credentials; Keychain-only Codex logins are not discovered by this feature.

ChatGPT can replace an OAuth refresh token after using it. Once replaced, the
older token may no longer be accepted. Before Codex Switcher writes another
account to `~/.codex/auth.json`, it now saves the latest tokens from the account
that is currently active. Switching back therefore restores the current session
instead of an older snapshot.

Token refreshes and account switches are serialized so a background refresh
cannot finish late and overwrite the account you just selected. Codex Switcher
also avoids refreshing the active account while Codex or ChatGPT is running;
close the running app before switching accounts.

If an older Codex Switcher version already saved an invalid refresh token, sign
in to that account again or remove and re-add it once. An invalidated token
cannot be recovered locally.

## macOS Dock and Menu Bar Mode

On macOS, Codex Switcher can either stay visible in the Dock or live only in the
menu bar. The first time you close the main window, the app asks which behavior
you want and lets you choose whether to show that prompt again.

You can change the same setting later from the tray popup or from the native
tray menu under **Dock Icon**. If you choose **Menu Bar Only**, the app keeps a
visible tray item so you can always reopen the main window or switch back to
Dock mode.

## Warm-Up

A warm-up sends one minimal request to an account so its current usage window
has activity before you need it.

- **Manual** – warm up a single or all accounts, from the main window or tray menu.
- **Automatic** – when enabled (per account or for all), the app tracks the
  5-hour window when available and warms it after each reset, as long as the
  weekly limit isn't exhausted. If only the weekly window is available, it
  warms once after the weekly reset and automatically returns to the 5-hour
  schedule if that window reappears.
- **Timed** – pick specific times of day (e.g. `08:00`, `13:00`, `18:00`) from
  the **Timed** control in the main window. At each time the app warms all
  accounts (skipping any whose weekly limit is exhausted), so you control when
  your 5-hour windows start instead of letting them drift.

Timed warm-up checks the schedule every 30 seconds, runs each configured minute
only once per day, and skips missed times if the machine was asleep instead of
warming accounts late.

## Antigravity / Gemini

On Windows and macOS, the **Antigravity / Gemini** section captures the currently
signed-in Antigravity session and lets you switch between captured sessions.
The `agy` CLI uses the shared credential (Windows Credential Manager or macOS
Keychain). macOS uses Security.framework directly, keeping tokens out of command
arguments. macOS may ask you to allow access to the `gemini` / `antigravity`
Keychain item when capturing or switching.

Quit Antigravity desktop, Antigravity IDE, and `agy` before switching. Capture each
account while it is signed in, then use **Switch** to restore that session later.
Each capture becomes the active account because it represents the live login.

On macOS, the switcher prefers the `Antigravity IDE` profile when present and
otherwise uses `Antigravity`. If neither profile exists, it captures an agy-only
Keychain session. Captures record which profile they belong to; installing or
migrating the editor may require capturing accounts again. Newer IDE profiles
no longer expose the legacy email/status field, so give these accounts distinct
names. If their live credential changes and the account identity cannot be
verified, the switcher asks you to capture the live session separately instead
of overwriting an existing account with an unidentified login.

The optional macOS read-only integration checks require a signed-in local session:

```bash
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib keychain_read_smoke -- --ignored
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib live_usage_smoke -- --ignored
```

On macOS you can keep the machine awake with the built-in `caffeinate` command,
which stops automatically when the app quits:

```bash
caffeinate -i -w "$(pgrep -x 'Codex Switcher')"
```

## Disclaimer

This tool is designed **exclusively for individuals who personally own multiple OpenAI/ChatGPT accounts**. It is intended to help users manage their own accounts more conveniently.

**This tool is NOT intended for:**

- Sharing accounts between multiple users
- Circumventing OpenAI's terms of service
- Any form of account pooling or credential sharing

By using this software, you agree that you are the rightful owner of all accounts you add to the application. The authors are not responsible for any misuse or violations of OpenAI's terms of service.

## Versioning

Use the version bump helper to keep app versions in sync across Tauri, Cargo, and the frontend.

```bash
# Exact version
pnpm version:bump 0.2.1

# Semver bumps
pnpm version:patch
pnpm version:minor
pnpm version:major

# Prepare a release commit and tag
# This prompts for a short release note and runs the version bump first.
pnpm release patch

# Prepare and push a release
# The tag stores the release note for the in-app update prompt.
pnpm release patch -- --push

# For non-interactive use, pass the note explicitly.
pnpm release patch -- --push --note "Fixed account switching issues"
```
