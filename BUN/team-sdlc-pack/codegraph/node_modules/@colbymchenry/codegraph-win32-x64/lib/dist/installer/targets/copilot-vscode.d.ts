/**
 * VS Code (GitHub Copilot Chat) target.
 *
 *   - MCP server entry to `.vscode/mcp.json` (local, workspace-scoped)
 *     or the user-level `mcp.json` in the VS Code User dir (global):
 *
 *       macOS:   ~/Library/Application Support/Code/User/mcp.json
 *       Windows: %APPDATA%\Code\User\mcp.json
 *       Linux:   $XDG_CONFIG_HOME|~/.config/Code/User/mcp.json
 *
 *     VS Code moved MCP config out of settings.json into this dedicated
 *     `mcp.json` (v1.102, "MCP: Open User Configuration"). Shape is
 *     `{ "servers": { "<name>": { "type": "stdio", "command", "args" } } }`
 *     — note `servers`, not the `mcpServers` wrapper Claude/Cursor use.
 *   - No instructions file: Copilot Chat consumes the MCP `initialize`
 *     instructions, the single source of truth (#529).
 *   - No permissions concept — `autoAllow` is silently ignored.
 *
 * ## Why `--path` only for local installs (NOT the Cursor pattern)
 *
 * Unlike Cursor, VS Code DOCUMENTS the launch cwd for stdio MCP
 * servers: "Working directory for the server command. Defaults to the
 * workspace folder when run in a workspace" (mcp-configuration
 * reference). The codegraph server resolves its project via the MCP
 * roots/list dance with a cwd fallback, so cwd alone is sufficient:
 *
 *   - `local`  install: absolute `--path` (known at install time) —
 *     deterministic, and free of variables.
 *   - `global` install: NO `--path`. Do not be tempted to pin it with
 *     `${workspaceFolder}`: VS Code refuses to start a user-level
 *     server whose entry uses that variable whenever a window has no
 *     folder open (loose files, welcome tab), surfacing an error toast
 *     "Variable workspaceFolder can not be resolved" in every such
 *     window — exactly the error-noise that teaches users to disable
 *     the server. With no `--path`, a folderless window still starts
 *     the server fine and it serves the "no project" guidance.
 *
 * ## JSONC
 *
 * VS Code parses its config files as JSONC (comments + trailing commas
 * allowed), so reads + writes go through `jsonc-parser` — surgical
 * edits that preserve sibling servers, user comments, and formatting
 * across install / re-install / uninstall (same approach as opencode).
 */
import { AgentTarget } from './types';
export declare const copilotVscodeTarget: AgentTarget;
//# sourceMappingURL=copilot-vscode.d.ts.map