/**
 * JetBrains IDEs (GitHub Copilot plugin) target.
 *
 *   - MCP server entry to the plugin's user-level `mcp.json`, which
 *     lives under the shared `github-copilot` config dir (the same dir
 *     the Copilot ecosystem uses for `hosts.json`):
 *
 *       macOS/Linux: $XDG_CONFIG_HOME|~/.config/github-copilot/intellij/mcp.json
 *       Windows:     %LOCALAPPDATA%\github-copilot\intellij\mcp.json
 *
 *     `$XDG_CONFIG_HOME` is honored on every platform when set —
 *     matching the plugin family's own resolution (copilot.vim /
 *     copilot-language-server check it before the OS default).
 *   - Shape is VS Code-compatible: `{ "servers": { "<name>": { "type":
 *     "stdio", "command", "args" } } }` — the plugin documents mcp.json
 *     parity with `.vscode/mcp.json`.
 *   - **Global-only.** The plugin reads exactly one user-level file; a
 *     project-level mcp.json is an open feature request
 *     (microsoft/copilot-intellij-feedback#701, still open 2026-07).
 *     `supportsLocation('local')` returns false so the orchestrator
 *     skips local installs with a clear message (Codex pattern).
 *   - No `--path` injection: the config is user-global and the plugin
 *     documents no `${workspaceFolder}`-style variable expansion for
 *     this file, so we ship the plain entry and let the MCP server
 *     resolve the project from the client's roots/cwd as with other
 *     global installs.
 *   - No instructions file (MCP `initialize` instructions are the
 *     single source of truth, #529) and no permissions concept —
 *     `autoAllow` is silently ignored.
 *
 * The IDE opens this file in a JSON editor for hand-editing (Settings →
 * Tools → GitHub Copilot → MCP → Configure), so reads + writes go
 * through `jsonc-parser` — surgical edits that preserve sibling
 * servers, user comments, and formatting (same approach as the
 * copilot-vscode target).
 *
 * The plugin only re-reads mcp.json on IDE restart
 * (microsoft/copilot-intellij-feedback#1139) — hence the restart note.
 */
import { AgentTarget } from './types';
export declare const copilotJetbrainsTarget: AgentTarget;
//# sourceMappingURL=copilot-jetbrains.d.ts.map