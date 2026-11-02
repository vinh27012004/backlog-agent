# Install MTM PLAYER

## Scope

MTM PLAYER supports a standalone Windows application, a macOS command launcher, and a Linux (Ubuntu) shell launcher. It does not require a Codex plugin. The release includes this guide so an AI coding session can install and verify the application. Team packs remain separate packages.

## macOS package

Run `npm run package:macos` from `mtm-player/`. A build on macOS bundles the current Node executable for the build machine's architecture (arm64 or x64). A build on Windows produces a portable macOS archive requiring Node.js 20+ installed separately; it never bundles Windows binaries. Packages are unsigned and are not notarized.

Extract the entire `.tar.gz` archive and open `MTM Player.command`. Install Git and authenticate the Codex CLI first. The launcher checks `/opt/homebrew/bin`, `/usr/local/bin`, and the inherited PATH. If the CLI is elsewhere, enter its absolute path in Init and refresh models. Player stores its state under `~/Library/Application Support/MTM Player/`. Open `http://127.0.0.1:54321/manage` if the browser does not open.

Team packs are installed separately. On a Mac, `install.ps1` does not run; open `Install Team Pack.command` from the Player folder instead. It asks for the extracted team pack folder and the team workspace (or takes them as two arguments in Terminal), creates `matches/` and `team-sdlc-pack/`, then runs the pack's own `scripts/install.mjs --team-workspace <workspace>` and, when present, `scripts/check-distribution.mjs`. It never changes the pack. The pack's `install.mjs` must therefore not depend on PowerShell or Windows paths. If Finder blocks the file, right-click it and choose Open; if the archive lost its permissions, run `chmod +x "Install Team Pack.command"` or `bash "Install Team Pack.command"`. Preserve the team workspace, `.codex/`, `.agents/`, and pack assets when preparing a Mac workspace. Before distributing for competition, verify Init, preparation, start, chat, stop, restart recovery, and snapshot delivery on both Apple Silicon and Intel. Windows tests cannot establish macOS runtime compatibility.

## Linux package

Run `npm run package:linux` from `mtm-player/`. A build on Linux bundles the current Node executable for the build machine's architecture. A build on Windows or macOS produces a portable Linux archive requiring Node.js 20+ installed separately; it never bundles another platform's binaries. The target is Ubuntu 22.04 or newer with a desktop session.

Extract the entire `.tar.gz` archive, open a terminal in the extracted folder, and run `./mtm-player.sh`. Install Git and authenticate the Codex CLI first; the launcher uses the inherited PATH, so a Codex CLI installed through a Node version manager must be on PATH in that terminal, or its absolute path must be entered in Init. Player stores its state under `$XDG_DATA_HOME/mtm-player/` (default `~/.local/share/mtm-player/`) and opens the browser with `xdg-open`. Open `http://127.0.0.1:54321/manage` if the browser does not open. Browse uses `zenity` (`sudo apt install zenity`); without it, type the team workspace path and select Load workspace.

The team pack is the same package on every platform; it needs no Linux build. `install.ps1` does not run on Linux; run `./install-team-pack.sh <extracted team pack folder> <team workspace>` from the Player folder instead. Without arguments it asks for both folders with zenity. It follows the macOS installer: it creates `matches/` and `team-sdlc-pack/`, then runs the pack's own `scripts/install.mjs --team-workspace <workspace>` and, when present, `scripts/check-distribution.mjs`. If the archive lost its permissions, run `chmod +x mtm-player.sh install-team-pack.sh` or start them with `bash`. Before distributing for competition, verify Init, preparation, start, chat, stop, restart recovery, and snapshot delivery on a real Ubuntu machine.

## Minimum Player version

The Game Master can require a minimum MTM PLAYER version. Player reports its version during Init and Restart. If it is too old, the page shows the required version and a download link when the organizers provide one. Install that version, then try again. Your Team API Key is not the problem in that case.

## Required artifacts

- `mtm-player-<version>.zip`: extract the complete archive.
- `player-app/` inside it: copy the entire directory containing mtm-player.exe, node.exe and app/. A lone executable is insufficient.
- The requested team's compatible runtime package and its installer, if not already installed.

Use artifacts supplied by the organizer. Do not invent download URLs. If an artifact is missing, request its location. When working in the source repository, building the Windows application requires `node dev/build-player-app.mjs` from mtm-player/.

## Procedure for Codex

1. Inspect installed versions and query `http://127.0.0.1:54321/health`. Check `pwsh --version` and `codex --version`. The Codex CLI must be authenticated. The app bundles Node.js; a team installer may separately require Node.js and npm. Do not print authentication material.
2. Before stopping a running Player/runtime for upgrade, ask the operator. Existing explicit approval for this installation is sufficient. Stop through the app; verify LOCAL_APP_STOPPED and the listener closing. Do not kill all Node/Codex processes. Preserve rounds, local user-profile data, credentials, logs, challenge source and team runtime.
3. Extract the release and copy the complete `player-app` folder to an agreed location, for example `D:\mtm\MTM-PLAYER\<version>`. Prefer a new version directory. Never mix app/ or node.exe from different builds. The application is portable and has no registry or plugin installation step.
4. If needed, install the requested team pack separately using its own install.ps1 and documented TeamWorkspace parameter (on macOS, use `Install Team Pack.command`; on Linux, `install-team-pack.sh`, both from the Player folder). Verify team ID/name/version. Do not substitute HNK for HNKSUPER or another team.
5. Launch the installed mtm-player.exe WITHOUT arguments. It starts the server and opens Manage. Workspace selection happens in the web UI. If using Start-Process, use -WindowStyle Hidden.
6. Verify `/health` reports LOCAL_APP_READY and the intended version. Open `/manage` visibly. Select the team workspace with Browse/Load workspace to see saved rounds. Init uses that workspace and loads its team pack. Do not initialize a new match merely to verify installation; Resume continues a saved eligible round.
7. Report the application version, installed executable path, management URL and any unverified prerequisite.

## Stop and recovery

Stop Team Orchestrator stops the owned runtime while keeping the web server available. Shut down MTM PLAYER also closes the server. Both preserve saved round data. Resume is available for an operator-stopped current round whose official match has not finished or been cancelled. Saved bootstrap secrets stay in local server storage; do not use DPAPI or browser storage. A rotated or invalid credential requires replacement.
