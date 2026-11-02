"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.copilotVscodeTarget = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const jsonc_parser_1 = require("jsonc-parser");
const shared_1 = require("./shared");
function vscodeUserDir() {
    const home = os.homedir();
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA && process.env.APPDATA.trim().length > 0
            ? process.env.APPDATA
            : path.join(home, 'AppData', 'Roaming');
        return path.join(appData, 'Code', 'User');
    }
    if (process.platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Code', 'User');
    }
    const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length > 0
        ? process.env.XDG_CONFIG_HOME
        : path.join(home, '.config');
    return path.join(xdg, 'Code', 'User');
}
function mcpJsonPath(loc) {
    return loc === 'global'
        ? path.join(vscodeUserDir(), 'mcp.json')
        : path.join(process.cwd(), '.vscode', 'mcp.json');
}
/**
 * Build the codegraph server entry for VS Code at the given location.
 * Local installs pin `--path`; global installs rely on VS Code's
 * documented workspace-folder cwd — see file header for why the global
 * entry must stay variable-free.
 */
function buildVscodeServerEntry(loc) {
    const base = (0, shared_1.getMcpServerConfig)();
    if (loc === 'local') {
        return { ...base, args: [...base.args, '--path', process.cwd()] };
    }
    return { ...base, args: [...base.args] };
}
function readConfigText(file) {
    if (!fs.existsSync(file))
        return '';
    return fs.readFileSync(file, 'utf-8');
}
function parseConfig(text) {
    if (!text.trim())
        return {};
    const errors = [];
    const result = (0, jsonc_parser_1.parse)(text, errors, { allowTrailingComma: true });
    if (result == null || typeof result !== 'object' || Array.isArray(result)) {
        return {};
    }
    return result;
}
const FORMATTING = { tabSize: 2, insertSpaces: true, eol: '\n' };
class CopilotVscodeTarget {
    id = 'copilot-vscode';
    displayName = 'VS Code (Copilot Chat)';
    docsUrl = 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers';
    supportsLocation(_loc) {
        return true;
    }
    detect(loc) {
        const file = mcpJsonPath(loc);
        const config = parseConfig(readConfigText(file));
        const alreadyConfigured = !!config.servers?.codegraph;
        // "Installed" heuristic: the VS Code User dir (created on first
        // launch) or ~/.vscode (extensions dir) for global; an existing
        // .vscode/ dir in the project for local.
        const installed = loc === 'global'
            ? fs.existsSync(vscodeUserDir()) || fs.existsSync(path.join(os.homedir(), '.vscode'))
            : fs.existsSync(path.join(process.cwd(), '.vscode'));
        return { installed, alreadyConfigured, configPath: file };
    }
    install(loc, _opts) {
        return {
            files: [writeMcpEntry(loc)],
            notes: ['Restart VS Code for MCP changes to take effect.'],
        };
    }
    uninstall(loc) {
        return { files: [removeMcpEntry(loc)] };
    }
    printConfig(loc) {
        const target = mcpJsonPath(loc);
        const snippet = JSON.stringify({ servers: { codegraph: buildVscodeServerEntry(loc) } }, null, 2);
        return `# Add to ${target}\n\n${snippet}\n`;
    }
    describePaths(loc) {
        return [mcpJsonPath(loc)];
    }
}
function writeMcpEntry(loc) {
    const file = mcpJsonPath(loc);
    const existed = fs.existsSync(file);
    let text = readConfigText(file);
    if (!text.trim())
        text = '{}\n';
    const config = parseConfig(text);
    const before = config.servers?.codegraph;
    const after = buildVscodeServerEntry(loc);
    if ((0, shared_1.jsonDeepEqual)(before, after)) {
        return { path: file, action: 'unchanged' };
    }
    // Surgical edit — preserves comments, formatting, and sibling
    // servers ("servers" is created when missing).
    const edits = (0, jsonc_parser_1.modify)(text, ['servers', 'codegraph'], after, {
        formattingOptions: FORMATTING,
    });
    const updated = (0, jsonc_parser_1.applyEdits)(text, edits);
    (0, shared_1.atomicWriteFileSync)(file, updated);
    return { path: file, action: existed ? 'updated' : 'created' };
}
function removeMcpEntry(loc) {
    const file = mcpJsonPath(loc);
    if (!fs.existsSync(file))
        return { path: file, action: 'not-found' };
    const text = readConfigText(file);
    const config = parseConfig(text);
    if (!config.servers?.codegraph)
        return { path: file, action: 'not-found' };
    let edits = (0, jsonc_parser_1.modify)(text, ['servers', 'codegraph'], undefined, {
        formattingOptions: FORMATTING,
    });
    let updated = (0, jsonc_parser_1.applyEdits)(text, edits);
    // Drop an emptied `servers` wrapper; the file itself is left in
    // place — VS Code recreates/reads it and siblings like `inputs`
    // may remain.
    const afterParsed = parseConfig(updated);
    if (afterParsed.servers && typeof afterParsed.servers === 'object' &&
        Object.keys(afterParsed.servers).length === 0) {
        edits = (0, jsonc_parser_1.modify)(updated, ['servers'], undefined, { formattingOptions: FORMATTING });
        updated = (0, jsonc_parser_1.applyEdits)(updated, edits);
    }
    (0, shared_1.atomicWriteFileSync)(file, updated);
    return { path: file, action: 'removed' };
}
exports.copilotVscodeTarget = new CopilotVscodeTarget();
//# sourceMappingURL=copilot-vscode.js.map