#!/usr/bin/env node
// Điểm vào MCP helper team_runtime. Codex khởi chạy theo TeamWorkspace/.codex/config.toml.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/core/mcp.mjs';
import { redact } from '../src/core/redact.mjs';
import { Runtime } from '../src/tools.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

const runtime = new Runtime();
const server = createServer(runtime, { version, write: message => process.stdout.write(`${JSON.stringify(message)}\n`) });

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).replace(/\r$/, '');
    buffer = buffer.slice(nl + 1);
    server.line(line).catch(error => process.stderr.write(`team_runtime: ${redact(error?.message ?? error)}\n`));
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', error => process.stderr.write(`team_runtime uncaught: ${redact(error?.message ?? error)}\n`));
process.on('unhandledRejection', error => process.stderr.write(`team_runtime rejection: ${redact(error?.message ?? error)}\n`));
