#!/usr/bin/env node
// Checker chỉ đọc (09 §5): kiểm pack đã cài trong TeamWorkspace, thử khởi động helper qua MCP.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
