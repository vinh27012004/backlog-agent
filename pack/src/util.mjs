// Hàm dùng chung, chỉ dùng built-in của Node.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export class HelperError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.detail = detail;
  }
}

export const fail = (code, detail) => { throw new HelperError(code, detail); };

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export const exactKeys = (value, keys) => isObject(value) &&
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());

export const isId = value => typeof value === 'string' && value.length > 0 && value.length <= 128 &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);

export const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

export const randomSecret = (bytes = 33) => randomBytes(bytes).toString('base64');

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Ghi file tạm rồi rename để không bao giờ để lại file ghi dở khi bị kill.
export function writeFileAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

// Một dòng tóm tắt hợp lệ cho log của Player: không xuống dòng, ≤ max ký tự.
export function oneLine(text, max = 200) {
  const flat = String(text ?? '').replace(/[\r\n\0]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// UUID v4 tất định từ seed (03 §6).
export function deterministicUuid(seed) {
  const bytes = createHash('sha256').update(seed, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const nowIso = () => new Date().toISOString();
