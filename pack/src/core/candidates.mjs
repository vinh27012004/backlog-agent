// Candidate bất biến ở mỗi lần bàn giao; schema và dấu vân tay không phụ thuộc số lần spawn worker.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { validateSchema } from './jsonschema.mjs';
import { contentTree } from './git.mjs';
import { fail } from './util.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const schemas = Object.fromEntries(['fix-result', 'review', 'hypothesis'].map(name =>
  [name, JSON.parse(readFileSync(new URL(`../../contracts/${name}.schema.json`, import.meta.url), 'utf8'))]));

export function resultArtifact(dir, file, kind) {
  if (!isAbsolute(file ?? '')) fail('INVALID_ARGUMENT', 'result file must be absolute');
  const rel = relative(resolve(dir), resolve(file));
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || dirname(rel) !== '.') fail('PATH_NOT_ALLOWED', 'result file must be directly inside .team-work/results/');
  let raw;
  try {
    if (relative(realpathSync(dir), realpathSync(file)) !== basename(file)) fail('PATH_NOT_ALLOWED', 'result symlink leaves results directory');
    raw = readFileSync(file, 'utf8');
  } catch (e) { if (e.code === 'PATH_NOT_ALLOWED') throw e; fail('RESULT_INVALID', 'result file is missing or unreadable'); }
  let value;
  try { value = JSON.parse(raw); } catch { fail('RESULT_INVALID', '$: invalid JSON (write to a temporary file, then rename)'); }
  if (!schemas[kind]) fail('INVALID_ARGUMENT', `unknown result contract ${kind}`);
  const errors = validateSchema(value, schemas[kind]);
  if (errors.length) fail('RESULT_INVALID', errors.join('; '));
  return { file: resolve(file), hash: digest(raw), value };
}

// Bao gồm cả .env bị gitignore, marker dependency và phiên bản runtime; chỉ hash rời khỏi helper.
export function environmentFingerprint(matchRoot, profile, epoch = 0) {
  const roots = [...new Set([matchRoot, profile.root].filter(Boolean))];
  const inputs = [];
  for (const root of roots) {
    const names = existsSync(root) ? readdirSync(root).filter(n => /^\.env($|\.)/.test(n)) : [];
    for (const name of [...names, 'node_modules/.package-lock.json', 'node_modules/.modules.yaml']) {
      const file = join(root, name);
      if (existsSync(file) && statSync(file).isFile()) inputs.push([relative(matchRoot, file), digest(readFileSync(file))]);
    }
  }
  return digest({ inputs, node: process.version, platform: process.platform, arch: process.arch,
    commands: profile.commands, epoch, runtimeEnv: Object.fromEntries(['NODE_OPTIONS', 'NODE_ENV', 'CI', 'TZ', 'LANG', 'LC_ALL',
      'JAVA_HOME', 'MAVEN_OPTS', 'DOTNET_ROOT', 'GOFLAGS', 'DATABASE_URL', 'TEST_DATABASE_URL'].map(k => [k, process.env[k] ?? null])) });
}

export async function sourceSnapshot(checkoutRoot, folder, profile, epoch = 0) {
  return { source: await contentTree(checkoutRoot, folder, [`${folder}/answers`]),
    environment: environmentFingerprint(join(checkoutRoot, folder), profile, epoch) };
}

export function repairPlan({ fixer, answerProblems = [], evidenceProblems = [], gate, review }) {
  const todo = [];
  const add = (id, action, source) => { if (action && !todo.some(t => t.id === id && t.action === action)) todo.push({ id, action, source }); };
  for (const r of fixer?.requirements ?? []) if (r.status === 'not_met') add(r.id, r.evidence, 'fixer');
  if (fixer && fixer.status !== 'fixed') add('worker-status', `${fixer.status}: ${fixer.summary}`, 'fixer');
  for (const v of fixer?.verification ?? []) if (v.result !== 'pass') add(v.check, v.note ?? `Complete ${v.check}`, 'fixer');
  answerProblems.forEach((p, i) => add(`answer-${i + 1}`, p, 'answer'));
  evidenceProblems.forEach((p, i) => add(`evidence-${i + 1}`, p, 'evidence'));
  if (gate && !gate.passed) add('gate', gate.detail ?? gate.failKind, 'gate');
  for (const i of review?.issues ?? []) if (i.severity === 'high') add(i.file ?? 'review', `${i.problem}: ${i.suggestion}`, 'reviewer');
  const sourceFailure = gate && (!gate.codePassed || ['not_reproduced', 'weak_test'].includes(gate.failKind)) && !['answer_invalid', 'evidence_missing'].includes(gate.failKind);
  const sourceReview = review?.issues?.some(i => i.severity === 'high' && (i.file && !/(^|[\\/])(answers|evidence)[\\/]|submit\.json$/i.test(i.file)
    || !i.file && !/\[R8\]|missing evidence|not captured|stale screenshot/i.test(i.problem)));
  const investigation = fixer?.hypotheses?.some(h => h.verdict === 'open') && !fixer.hypotheses.some(h => h.verdict === 'confirmed');
  const kind = sourceFailure || sourceReview || investigation ? 'code' : evidenceProblems.length || todo.some(t => /evidence|screenshot|capture|\bcsv\b|ảnh/i.test(t.action)) ? 'evidence' : 'answer';
  return { kind, keepImplementation: kind !== 'code', continuation: kind === 'code' ? 'consider_new_worker' : 'followup_worker', todo };
}
