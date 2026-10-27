#!/usr/bin/env node
// Installer của team-sdlc-pack (09 §4). Chỉ ghi vào TeamWorkspace; không đụng matches/, logs/ hay config của user.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['agents/', 'bin/', 'config/', 'contracts/', 'docs/', 'install.ps1', 'scripts/check-distribution.mjs',
  'scripts/install.mjs', 'skills/', 'src/', 'README.md', 'team-pack-info.json', 'team-runtime.json'];
const BEGIN = '<!-- TEAM-PACK:BEGIN -->';
const END = '<!-- TEAM-PACK:END -->';

class InstallError extends Error { constructor(code, detail) { super(detail); this.code = code; } }
const fail = (code, detail = '') => { throw new InstallError(code, detail); };

function args(argv) {
  const out = { force: false, codegraph: true };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--team-workspace') out.teamWorkspace = argv[++i];
    else if (argv[i] === '--force') out.force = true;
    else if (argv[i] === '--no-codegraph') out.codegraph = false;
  }
  return out;
}

// Codegraph (config/codegraph.json) vào team-sdlc-pack/codegraph/, ngoài runtime/ (Player gắn cờ mọi lần ghi vào
// runtime/ trong trận, T11). Cài bằng npm-cli.js đi kèm Node (không qua shell); BTC cho tải package lúc setup (Q3).
// Đã có đúng phiên bản thì bỏ qua; cài lỗi chỉ là cảnh báo, pack vẫn chạy và agent dùng rg.
function installCodegraph(packRoot, enabled) {
  const cfg = readJson(join(source, 'config', 'codegraph.json'));
  const dir = join(packRoot, 'codegraph');
  const pkgDir = join(dir, 'node_modules', ...cfg.package.split('/'));
  const installed = () => existsSync(join(pkgDir, 'npm-shim.js')) && existsSync(join(pkgDir, 'package.json'))
    && readJson(join(pkgDir, 'package.json')).version === cfg.version;
  let error = null;
  if (!installed() && enabled) {
    const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(npmCli)) error = `npm not found next to node (${npmCli})`;
    else {
      mkdirSync(dir, { recursive: true });
      const res = spawnSync(process.execPath, [npmCli, 'install', '--prefix', dir, '--no-save', '--no-fund', '--no-audit',
        `${cfg.package}@${cfg.version}`], { encoding: 'utf8', timeout: 600_000, env: { ...process.env, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1' } });
      if (res.status !== 0) error = `npm install failed: ${(res.stderr || res.error?.message || '').trim().split('\n').pop()}`;
    }
  }
  if (installed()) return { shim: join(pkgDir, 'npm-shim.js').replaceAll('\\', '/'), tools: cfg.tools, version: cfg.version };
  return { shim: null, warning: `CODEGRAPH_NOT_INSTALLED: ${error ?? (enabled ? 'unknown' : 'skipped (--no-codegraph)')}; agents fall back to rg` };
}

// Khối [mcp_servers.codegraph] trong config/codex.toml: điền path + danh sách tool, hoặc bỏ cả khối khi chưa cài.
function codexConfig(template, server, codegraph) {
  const text = template.replace('__TEAM_RUNTIME_SERVER__', JSON.stringify(server));
  if (!codegraph.shim) return text.replace(/# BEGIN codegraph[\s\S]*?# END codegraph\r?\n\r?\n/, '');
  return text.replace('__CODEGRAPH_SHIM__', JSON.stringify(codegraph.shim)).replace('__CODEGRAPH_TOOLS__', JSON.stringify(codegraph.tools.join(',')));
}

function noLinks(path) {
  let cursor = resolve(path);
  const root = parse(cursor).root;
  while (cursor !== root) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('UNSAFE_TEAM_WORKSPACE', `link at ${cursor}`);
    cursor = dirname(cursor);
  }
}

function listFiles(root, entry) {
  const abs = join(root, entry);
  if (!existsSync(abs)) fail('INVALID_TEAM_PACK', `missing ${entry}`);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) fail('INVALID_TEAM_PACK', `link ${entry}`);
  if (st.isFile()) return [entry];
  const out = [];
  for (const name of readdirSync(abs)) out.push(...listFiles(root, join(entry, name).replaceAll('\\', '/')));
  return out;
}

const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

function checkSource() {
  const pkg = readJson(join(source, 'package.json'));
  if (pkg.name !== 'team-sdlc-pack' || JSON.stringify(pkg.files) !== JSON.stringify(FILES)) fail('INVALID_TEAM_PACK', 'package.json');
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    if (pkg[k] && Object.keys(pkg[k]).length) fail('INVALID_TEAM_PACK', k);
  }
  for (const k of ['preinstall', 'install', 'postinstall', 'prepare']) if (pkg.scripts?.[k]) fail('INVALID_TEAM_PACK', k);
  const runtime = readJson(join(source, 'team-runtime.json'));
  const info = readJson(join(source, 'team-pack-info.json'));
  if (runtime.version !== pkg.version || info.version !== pkg.version) fail('INVALID_TEAM_PACK', 'version mismatch');
  if (!info.teamId || info.teamId === 'YOUR_TEAM_ID') fail('INVALID_TEAM_PACK_INFO', 'teamId placeholder');
  return { pkg, info };
}

function trusted(teamWorkspace) {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  const file = join(home, 'config.toml');
  if (!existsSync(file)) return false;
  const want = resolve(teamWorkspace).toLowerCase().replaceAll('/', '\\');
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(/\[projects\.(?:'([^']+)'|"((?:[^"\\]|\\.)+)")\]\s*\n\s*trust_level\s*=\s*"trusted"/g)) {
    const path = (m[1] ?? m[2].replaceAll('\\\\', '\\')).toLowerCase().replaceAll('/', '\\');
    if (path === want) return true;
  }
  return false;
}

function writeIfChanged(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return;
  writeFileSync(path, text, 'utf8');
}

function agentsBlock(existing) {
  const block = [BEGIN,
    '## Team pack (team-sdlc-pack)',
    '',
    '- Use the `team_runtime` MCP tools for Game Master calls, the progress log, git commit/push and submissions.',
    '- Skills: `.agents/skills/game-preparation`, `team-orchestrator`, `team-recovery`.',
    '- Work only inside the assigned match folder. Never print or store credentials.',
    END].join('\n');
  if (existing.includes(BEGIN) && existing.includes(END)) {
    return existing.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block);
  }
  return `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}${block}\n`;
}

function install({ teamWorkspace, force, codegraph: withCodegraph }) {
  if (!teamWorkspace || !isAbsolute(teamWorkspace)) fail('INVALID_TEAM_WORKSPACE', '--team-workspace must be absolute');
  const tw = resolve(teamWorkspace);
  if (parse(tw).root === tw) fail('INVALID_TEAM_WORKSPACE', 'drive root not allowed');
  noLinks(tw);
  mkdirSync(tw, { recursive: true });
  const { pkg, info } = checkSource();

  const logs = join(tw, 'team-sdlc-pack', 'logs');
  if (!force && existsSync(logs)) {
    for (const f of readdirSync(logs)) {
      if (f.endsWith('.progress.ndjson') && Date.now() - statSync(join(logs, f)).mtimeMs < 120_000) {
        fail('MATCH_RUNNING', `${f} changed in the last 2 minutes; use --force to install anyway`);
      }
    }
  }
  mkdirSync(join(tw, 'matches'), { recursive: true });
  mkdirSync(logs, { recursive: true });

  // runtime/: chép payload sang runtime.new rồi đổi tên, để Player không bao giờ thấy bản dở.
  const packRoot = join(tw, 'team-sdlc-pack');
  const fresh = join(packRoot, 'runtime.new');
  const runtime = join(packRoot, 'runtime');
  const old = join(packRoot, 'runtime.old');
  rmSync(fresh, { recursive: true, force: true });
  rmSync(old, { recursive: true, force: true });
  const payload = ['package.json', ...FILES.flatMap(e => listFiles(source, e.replace(/\/$/, '')))];
  for (const rel of payload) {
    mkdirSync(dirname(join(fresh, rel)), { recursive: true });
    cpSync(join(source, rel), join(fresh, rel));
  }
  if (existsSync(runtime)) renameSync(runtime, old);
  renameSync(fresh, runtime);
  rmSync(old, { recursive: true, force: true });

  // File đăng ký: chép từ runtime/, đúng từng byte.
  const owned = [];
  const copy = (from, to) => {
    const target = join(tw, to);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(runtime, from), target);
    owned.push(to.replaceAll('\\', '/'));
  };
  for (const f of readdirSync(join(runtime, 'agents'))) if (f.endsWith('.toml')) copy(`agents/${f}`, `.codex/agents/${f}`);
  copy('team-pack-info.json', '.mtm/team-pack-info.json');
  copy('team-runtime.json', '.mtm/team-runtime.json');
  for (const rel of listFiles(runtime, 'skills')) copy(rel, `.agents/${rel}`);

  const server = join(runtime, 'bin', 'runtime-server.mjs').replaceAll('\\', '/');
  const codegraph = installCodegraph(packRoot, withCodegraph);
  const config = codexConfig(readFileSync(join(runtime, 'config', 'codex.toml'), 'utf8'), server, codegraph);
  writeIfChanged(join(tw, '.codex', 'config.toml'), config);
  owned.push('.codex/config.toml');

  const agentsMd = join(tw, 'AGENTS.md');
  if (existsSync(agentsMd)) {
    const st = lstatSync(agentsMd);
    if (st.isSymbolicLink() || st.nlink > 1) fail('UNSAFE_TEAM_WORKSPACE', 'AGENTS.md is a link');
  }
  writeIfChanged(agentsMd, agentsBlock(existsSync(agentsMd) ? readFileSync(agentsMd, 'utf8') : ''));

  // Manifest: xoá file của bản cũ không còn trong bản mới.
  const manifestPath = join(packRoot, 'install-manifest.json');
  const previous = existsSync(manifestPath) ? readJson(manifestPath).files ?? {} : {};
  const files = Object.fromEntries(owned.sort().map(rel => [rel, sha(join(tw, rel))]));
  for (const rel of Object.keys(previous)) if (!files[rel] && existsSync(join(tw, rel))) rmSync(join(tw, rel));
  writeIfChanged(manifestPath, `${JSON.stringify({ schemaVersion: 1, version: pkg.version, files }, null, 2)}\n`);

  const local = join(packRoot, 'local');
  mkdirSync(local, { recursive: true });

  const warnings = codegraph.warning ? [codegraph.warning] : [];
  if (!trusted(tw)) warnings.push(`CODEX_WORKSPACE_NOT_TRUSTED: add [projects.'${tw}'] trust_level = "trusted" to ~/.codex/config.toml`);
  if (!existsSync(join(local, 'machine.json'))) warnings.push('team-sdlc-pack/local/machine.json missing: .env placeholders for the database password will stay unresolved');
  return { status: 'READY', version: pkg.version, teamId: info.teamId, teamName: info.teamName, teamWorkspace: tw,
    codegraph: codegraph.version ?? null, warnings };
}

try {
  const result = install(args(process.argv.slice(2)));
  for (const w of result.warnings) process.stderr.write(`WARNING ${w}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ status: 'FAILED', code: error.code ?? 'INSTALL_FAILED', detail: error.message })}\n`);
  process.exit(1);
}
