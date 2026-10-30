import { decrypt, encrypt, isEncrypted } from './crypto.js';
import type { ConfigSchema } from './plugin-api.js';

export const REDACTED = '••••••••';

type Visitor = (value: unknown, schema: ConfigSchema, path: string[]) => unknown;

/** Walk a config value alongside its JSON schema, applying `fn` at every x-secret leaf. */
function walk(value: unknown, schema: ConfigSchema | undefined, fn: Visitor, path: string[] = []): unknown {
  if (!schema || value == null) return value;
  if (schema['x-secret']) return fn(value, schema, path);
  if (schema.type === 'object' && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = { ...(value as object) };
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in out) out[k] = walk(out[k], sub as ConfigSchema, fn, [...path, k]);
    }
    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const k of Object.keys(out)) {
        if (!(schema.properties ?? {})[k]) out[k] = walk(out[k], schema.additionalProperties, fn, [...path, k]);
      }
    }
    return out;
  }
  if (schema.type === 'array' && Array.isArray(value)) {
    return value.map((v, i) => walk(v, schema.items, fn, [...path, String(i)]));
  }
  return value;
}

/** Encrypt plaintext secrets (leave already-encrypted ones alone). */
export function encryptSecrets(cfg: unknown, schema: ConfigSchema) {
  return walk(cfg, schema, (v) => (typeof v === 'string' && v && !isEncrypted(v) ? encrypt(v) : v));
}

export function decryptSecrets(cfg: unknown, schema: ConfigSchema) {
  return walk(cfg, schema, (v) => (isEncrypted(v) ? decrypt(v) : v));
}

/** Replace secrets with a placeholder for the UI; empty secrets stay empty. */
export function redactSecrets(cfg: unknown, schema: ConfigSchema) {
  return walk(cfg, schema, (v) => (typeof v === 'string' && v ? REDACTED : v));
}

/**
 * Merge a UI submission into the stored config: anywhere the UI left the placeholder,
 * keep the stored (encrypted) value. Array items are matched by `name` when they have one
 * (so removing or reordering a host never hands its key to a neighbour), else by index.
 */
export function mergeSecrets(incoming: unknown, stored: unknown, schema: ConfigSchema): unknown {
  const m = (inc: unknown, st: unknown, sch: ConfigSchema | undefined): unknown => {
    if (!sch || inc == null) return inc;
    if (sch['x-secret']) return inc === REDACTED ? (typeof st === 'string' ? st : '') : inc;
    if (sch.type === 'object' && typeof inc === 'object' && !Array.isArray(inc)) {
      const out: Record<string, unknown> = { ...(inc as object) }; const so = (st ?? {}) as Record<string, unknown>;
      for (const k of Object.keys(out)) {
        const sub = (sch.properties ?? {})[k] ?? (typeof sch.additionalProperties === 'object' ? sch.additionalProperties : undefined);
        out[k] = m(out[k], so[k], sub);
      }
      return out;
    }
    if (sch.type === 'array' && Array.isArray(inc)) {
      const sa = Array.isArray(st) ? st : [];
      return inc.map((v, i) => m(v, v && typeof v === 'object' && 'name' in v ? sa.find((s: any) => s?.name === (v as any).name) : sa[i], sch.items));
    }
    return inc;
  };
  return m(incoming, stored, schema);
}
