#!/usr/bin/env node
// Checker chỉ đọc (09 §5): kiểm pack đã cài trong TeamWorkspace, thử khởi động helper qua MCP.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const tw = resolve(argv[argv.indexOf('--team-workspace') + 1] ?? '.');
const checks = [];
const check = (id, ok, detail = '') => checks.push({ id, ok: Boolean(ok), detail });
const read = p => readFileSync(p, 'utf8');
const runtime = join(tw, 'team-sdlc-pack', 'runtime');

try {
  const pkg = JSON.parse(read(join(runtime, 'package.json')));
  check('package', pkg.name === 'team-sdlc-pack' && /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);
  const rt = JSON.parse(read(join(runtime, 'team-runtime.json')));
  check('team-runtime', JSON.stringify(Object.keys(rt).sort()) === JSON.stringify(['entrypoint', 'kind', 'name', 'protocolVersion', 'provider', 'schemaVersion', 'version']) &&
    rt.version === pkg.version && rt.protocolVersion === 4, rt.version);
  const info = JSON.parse(read(join(runtime, 'team-pack-info.json')));
  check('team-pack-info', info.version === pkg.version && info.teamId, `${info.teamId} / ${info.teamName}`);
} catch (error) { check('package', false, error.message); }

for (const [from, to] of [['agents/team-orchestrator.toml', '.codex/agents/team-orchestrator.toml'],
  ['team-pack-info.json', '.mtm/team-pack-info.json'], ['team-runtime.json', '.mtm/team-runtime.json']]) {
  const a = join(runtime, from), b = join(tw, to);
  check(`registration ${to}`, existsSync(a) && existsSync(b) && read(a) === read(b));
}
check('no node_modules/team-sdlc-pack', !existsSync(join(tw, 'team-sdlc-pack', 'node_modules', 'team-sdlc-pack')));
for (const s of ['game-preparation', 'team-orchestrator', 'team-recovery']) {
  check(`skill ${s}`, existsSync(join(tw, '.agents', 'skills', s, 'SKILL.md')));
}
const server = join(runtime, 'bin', 'runtime-server.mjs').replaceAll('\\', '/');
const cfg = existsSync(join(tw, '.codex', 'config.toml')) ? read(join(tw, '.codex', 'config.toml')) : '';
check('mcp config', cfg.includes(JSON.stringify(server)), server);
// Codegraph (05 §5.21): đúng phiên bản, khai trong config, shim chạy được. Thiếu thì pack vẫn chạy, agent dùng rg.
try {
  const want = JSON.parse(read(join(runtime, 'config', 'codegraph.json')));
  const shim = join(tw, 'team-sdlc-pack', 'codegraph', 'node_modules', ...want.package.split('/'), 'npm-shim.js');
  const res = existsSync(shim) ? spawnSync(process.execPath, [shim, 'version'], { encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DOWNLOAD: '1' } }) : null;
  const version = res?.stdout?.trim().split(/\s+/).pop() ?? null;
  const declared = cfg.includes(JSON.stringify(shim.replaceAll('\\', '/')));
  check('codegraph', version === want.version && declared,
    !res ? 'not installed: rerun install without --no-codegraph' : `${version ?? 'no version'}${declared ? '' : ', missing from .codex/config.toml'}`);
} catch (error) { check('codegraph', false, error.message); }
// capture_evidence (05 §5.24): playwright-core đúng phiên bản mở được Edge/Chrome đã cài. Edge tự cập nhật lên bản mà
// playwright-core đã ghim chưa điều khiển được thì báo ở đây, trước trận.
try {
  const { browserSmoke } = await import(pathToFileURL(join(runtime, 'src', 'env', 'browser.mjs')).href);
  const res = await browserSmoke();
  check('playwright', res.text === 'ok', `${res.browser} ${res.version}`);
} catch (error) { check('playwright', false, `${error.code ?? ''} ${error.message}`.trim()); }
const major = Number(process.versions.node.split('.')[0]);
check('node >= 20', major >= 20, process.versions.node);

try {
  const manifest = JSON.parse(read(join(tw, 'team-sdlc-pack', 'install-manifest.json')));
  const changed = Object.entries(manifest.files).filter(([rel, hash]) =>
    !existsSync(join(tw, rel)) || createHash('sha256').update(readFileSync(join(tw, rel))).digest('hex') !== hash).map(([rel]) => rel);
  check('install manifest', changed.length === 0, changed.join(', '));
} catch (error) { check('install manifest', false, error.message); }

const codexConfig = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
const want = tw.toLowerCase().replaceAll('/', '\\');
const trustedText = existsSync(codexConfig) ? read(codexConfig) : '';
const trusted = [...trustedText.matchAll(/\[projects\.(?:'([^']+)'|"((?:[^"\\]|\\.)+)")\]\s*\n\s*trust_level\s*=\s*"trusted"/g)]
  .some(m => (m[1] ?? m[2].replaceAll('\\\\', '\\')).toLowerCase().replaceAll('/', '\\') === want);
check('codex trust', trusted, trusted ? '' : `add [projects.'${tw}'] trust_level = "trusted"`);
check('machine config', existsSync(join(tw, 'team-sdlc-pack', 'local', 'machine.json')), 'team-sdlc-pack/local/machine.json');

// Codex mà Player sẽ chạy (codex-cli.mjs của Player 0.9.33): CODEX_CLI_PATH → "codex.exe" trên PATH (Windows chỉ
// nhận đúng tên này, shim npm codex.cmd/.ps1 bị bỏ qua) → codex.exe mới nhất trong %LOCALAPPDATA%\OpenAI\Codex\bin.
// Bản Desktop tự cập nhật, nên kiểm [features] của TeamWorkspace bằng đúng exe đó (hoặc --codex <exe> như trang Init).
function playerCodex() {
  const env = process.env;
  if (env.CODEX_CLI_PATH?.trim() && existsSync(env.CODEX_CLI_PATH.trim())) return { path: env.CODEX_CLI_PATH.trim(), via: 'CODEX_CLI_PATH' };
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  for (const dir of String(env.PATH ?? '').split(delimiter).map(d => d.trim().replace(/^"|"$/g, '')).filter(Boolean)) {
    if (existsSync(join(dir, name))) return { path: join(dir, name), via: 'PATH' };
  }
  const root = env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null;
  if (root && existsSync(root)) {
    const found = [join(root, 'codex.exe'), ...readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => join(root, e.name, 'codex.exe'))]
      .filter(p => existsSync(p)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (found.length) return { path: found[0], via: 'Codex Desktop' };
  }
  return null;
}
const override = argv.includes('--codex') ? argv[argv.indexOf('--codex') + 1] : null;
const codex = override ? { path: resolve(override), via: '--codex' } : playerCodex();
if (!codex) check('codex features', false, 'no codex executable found the way Player looks for it');
else if (!existsSync(codex.path)) check('codex features', false, `${codex.via}: ${codex.path} does not exist`);
else {
  const version = spawnSync(codex.path, ['--version'], { encoding: 'utf8', timeout: 20_000 }).stdout?.trim() ?? '?';
  const res = spawnSync(codex.path, ['features', 'list'], { cwd: tw, encoding: 'utf8', timeout: 30_000 });
  const state = name => (res.stdout ?? '').match(new RegExp(`^${name}\\s+\\S+(?:\\s\\S+)*?\\s+(true|false)\\s*$`, 'm'))?.[1] ?? '?';
  const mustBeOff = ['computer_use', 'browser_use', 'in_app_browser', 'plugins', 'apps'].filter(n => state(n) !== 'false');
  const multiAgent = state('multi_agent');
  check('codex features', res.status === 0 && !mustBeOff.length && multiAgent === 'true',
    `${codex.via}: ${codex.path} (${version}); ${mustBeOff.length ? `still on: ${mustBeOff.join(', ')}` : 'computer/browser/plugins off'}; multi_agent=${multiAgent}`);
}

// Jev (D9): chỉ báo thông tin, không chặn READY (không có key thì helper chạy bằng luật code). Lưu ý: biến môi trường
// phải có trong môi trường của Player (Codex chuyển cho helper qua env_vars), không phải chỉ trong shell này.
try {
  const jevCfg = JSON.parse(read(join(runtime, 'config', 'jev.json')));
  const localJev = existsSync(join(tw, 'team-sdlc-pack', 'local', 'jev.json')) ? JSON.parse(read(join(tw, 'team-sdlc-pack', 'local', 'jev.json'))) : {};
  const enabled = localJev.enabled ?? jevCfg.enabled;
  const keyFile = localJev.apiKeyFile ?? jevCfg.apiKeyFile;
  const fromEnv = Boolean(process.env[jevCfg.apiKeyEnv]);
  const fromFile = Boolean(keyFile && existsSync(keyFile) && read(keyFile).trim());
  check('jev', true, !enabled ? 'disabled (code rules only)' : fromEnv || fromFile
    ? `key from ${fromEnv ? `env ${jevCfg.apiKeyEnv}` : `file ${keyFile}`}` : 'no key: decide falls back to code rules');
} catch (error) { check('jev', true, `config unreadable: ${error.message}`); }

// Helper khởi động được: initialize + tools/list rồi tắt.
const helper = await new Promise(resolveHelper => {
  const child = spawn(process.execPath, [join(runtime, 'bin', 'runtime-server.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  const timer = setTimeout(() => { child.kill(); resolveHelper({ ok: false, detail: 'timeout' }); }, 10_000);
  child.stdout.on('data', d => {
    out += d;
    const lines = out.split('\n').filter(Boolean);
    if (lines.length >= 2) {
      clearTimeout(timer);
      child.kill();
      try {
        const tools = JSON.parse(lines[1]).result.tools.map(t => t.name);
        resolveHelper({ ok: tools.includes('configure_session'), detail: `${tools.length} tools` });
      } catch (error) { resolveHelper({ ok: false, detail: error.message }); }
    }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'checker', version: '1' } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
});
check('mcp helper', helper.ok, helper.detail);

const hardFail = checks.filter(c => !c.ok && c.id !== 'machine config');
const status = hardFail.length ? 'NOT_READY' : 'READY';
process.stdout.write(`${JSON.stringify({ status, checks }, null, 2)}\n`);
process.exit(status === 'READY' ? 0 : 2);
