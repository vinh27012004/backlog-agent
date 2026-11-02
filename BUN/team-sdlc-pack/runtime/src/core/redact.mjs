// Che secret trong mọi chuỗi helper trả ra (kết quả tool, lỗi, stderr).
const secrets = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 4) secrets.add(value);
}

const patterns = [
  /(authorization\s*:\s*bearer\s+)\S+/gi,
  /\b(password|secret|api[-_ ]?key|access[-_ ]?token)(\s*[:=]\s*)\S+/gi,
  /\b(?:gm|gh[pousr])_[A-Za-z0-9_-]{12,}/g,
  /(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/gi
];

export function redact(text) {
  let out = String(text ?? '');
  for (const secret of secrets) out = out.split(secret).join('***');
  out = out.replace(patterns[0], '$1***');
  out = out.replace(patterns[1], '$1$2***');
  out = out.replace(patterns[2], '***');
  out = out.replace(patterns[3], '$1***@');
  return out;
}

export function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}
