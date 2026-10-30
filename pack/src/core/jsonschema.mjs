// Kiểm JSON theo tập con JSON Schema 2020-12 mà BTC dùng cho submit.schema.json (Practice 26/10):
// type, const, enum, properties, required, additionalProperties, patternProperties, items, prefixItems,
// minItems/maxItems, uniqueItems, minLength/maxLength, pattern, minimum/maximum (exclusive), allOf/anyOf/
// oneOf/not, if/then/else, $ref nội bộ (#/$defs/..., #/definitions/...). Từ khoá khác bị bỏ qua.

const typeOf = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeMatches = (v, t) => t === typeOf(v) || (t === 'number' && typeof v === 'number');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function resolveRef(root, ref) {
  if (!ref.startsWith('#')) return null;
  let node = root;
  for (const raw of ref.slice(1).split('/').filter(Boolean)) {
    const key = decodeURIComponent(raw.replace(/~1/g, '/').replace(/~0/g, '~'));
    node = node?.[key];
  }
  return node ?? null;
}

export function validateSchema(value, schema, { maxErrors = 20 } = {}) {
  const errors = [];
  const add = (path, message) => { if (errors.length < maxErrors) errors.push(`${path || '$'}: ${message}`); };

  function check(v, s, path, out = add) {
    if (s === true || s === undefined) return true;
    if (s === false) { out(path, 'not allowed'); return false; }
    let ok = true;
    const bad = msg => { ok = false; out(path, msg); };
    if (s.$ref) {
      const target = resolveRef(schema, s.$ref);
      if (!target) bad(`unresolved $ref ${s.$ref}`);
      else if (!check(v, target, path, out)) ok = false;
    }
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some(t => typeMatches(v, t))) { bad(`expected ${types.join('|')}, got ${typeOf(v)}`); return false; }
    }
    if (Object.hasOwn(s, 'const') && !equal(v, s.const)) bad(`must equal ${JSON.stringify(s.const)}`);
    if (s.enum && !s.enum.some(e => equal(e, v))) bad(`must be one of ${s.enum.map(e => JSON.stringify(e)).join(', ')}`);
    if (typeof v === 'string') {
      if (s.minLength !== undefined && [...v].length < s.minLength) bad(`shorter than ${s.minLength}`);
      if (s.maxLength !== undefined && [...v].length > s.maxLength) bad(`longer than ${s.maxLength}`);
      if (s.pattern && !new RegExp(s.pattern, 'u').test(v)) bad(`does not match ${s.pattern}`);
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) bad(`< ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) bad(`> ${s.maximum}`);
      if (s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum) bad(`<= ${s.exclusiveMinimum}`);
      if (s.exclusiveMaximum !== undefined && v >= s.exclusiveMaximum) bad(`>= ${s.exclusiveMaximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) bad(`needs at least ${s.minItems} item(s)`);
      if (s.maxItems !== undefined && v.length > s.maxItems) bad(`allows at most ${s.maxItems} item(s)`);
      if (s.uniqueItems && new Set(v.map(x => JSON.stringify(x))).size !== v.length) bad('items must be unique');
      const prefix = s.prefixItems ?? [];
      v.forEach((item, i) => {
        const sub = i < prefix.length ? prefix[i] : s.items;
        if (sub !== undefined && !check(item, sub, `${path}[${i}]`, out)) ok = false;
      });
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const key of s.required ?? []) if (!Object.hasOwn(v, key)) bad(`missing required property "${key}"`);
      const props = s.properties ?? {};
      const patterns = Object.entries(s.patternProperties ?? {}).map(([p, sub]) => [new RegExp(p, 'u'), sub]);
      for (const [key, item] of Object.entries(v)) {
        const p = `${path}.${key}`;
        const matched = patterns.filter(([re]) => re.test(key));
        if (Object.hasOwn(props, key)) { if (!check(item, props[key], p, out)) ok = false; }
        for (const [, sub] of matched) if (!check(item, sub, p, out)) ok = false;
        if (!Object.hasOwn(props, key) && !matched.length && s.additionalProperties !== undefined) {
          if (s.additionalProperties === false) bad(`unexpected property "${key}"`);
          else if (!check(item, s.additionalProperties, p, out)) ok = false;
        }
      }
    }
    for (const sub of s.allOf ?? []) if (!check(v, sub, path, out)) ok = false;
    const silent = () => {};
    if (s.anyOf && !s.anyOf.some(sub => check(v, sub, path, silent))) bad('matches none of anyOf');
    if (s.oneOf && s.oneOf.filter(sub => check(v, sub, path, silent)).length !== 1) bad('must match exactly one of oneOf');
    if (s.not && check(v, s.not, path, silent)) bad('must not match "not" schema');
    if (s.if !== undefined) {
      const branch = check(v, s.if, path, silent) ? s.then : s.else;
      if (branch !== undefined && !check(v, branch, path, out)) ok = false;
    }
    return ok;
  }

  check(value, schema, '');
  return errors;
}
