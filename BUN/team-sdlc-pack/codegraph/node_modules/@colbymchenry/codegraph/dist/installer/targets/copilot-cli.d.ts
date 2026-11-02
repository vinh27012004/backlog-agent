/**
 * GitHub Copilot CLI target.
 *
 *   - MCP server entry to `~/.copilot/mcp-config.json` under the
 *     `mcpServers` key (same wrapper as Claude/Cursor). Entry shape per
 *     the GitHub docs: `{ "type": "stdio", "command", "args", "tools" }`
 *     — `type` accepts `"local"` or `"stdio"`; we write `"stdio"` (the
 *     standard MCP name, recommended by the docs for cross-client
 *     compatibility). `"tools": ["*"]` mirrors the docs' example and is
 *     the documented default.
 *   - The config dir is `~/.copilot` unless the user moved it via
 *     `COPILOT_HOME` (documented override) — we honor it so install and
 *     detect follow the CLI's own resolution.
 *
 * Copilot CLI as of 2026-07 has no project-local MCP config — per-repo
 * config (`.github/mcp.json`) is an open feature request
 * (github/copilot-cli#2528). `supportsLocation('local')` returns false;
 * the orchestrator skips this target for local installs with a clear
 * message (same pattern as Codex).
 *
 * The file is machine-written by the CLI's own `/mcp add` flow, so it's
 * plain JSON — no JSONC handling needed; surgical edits go through the
 * shared read/mutate/write helpers (Cursor pattern), preserving sibling
 * servers.
 *
 * No instructions file (MCP `initialize` instructions are the single
 * source of truth, #529) and no permissions concept — `autoAllow` is
 * silently ignored.
 */
import { AgentTarget } from './types';
export declare const copilotCliTarget: AgentTarget;
//# sourceMappingURL=copilot-cli.d.ts.map