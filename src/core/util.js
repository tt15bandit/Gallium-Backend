import crypto from 'node:crypto';

/** 32-character lowercase hex id, the format Epic uses for account ids, party ids, etc. */
export function hexId() {
  return crypto.randomBytes(16).toString('hex');
}

/** RFC 4122 v4 GUID (used for MCP item instance ids). */
export function guid() {
  return crypto.randomUUID();
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha1Hex(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

export function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** ISO-8601 timestamp with milliseconds, e.g. 2026-11-11T09:30:00.000Z */
export function isoNow() {
  return new Date().toISOString();
}

export function isoIn(ms) {
  return new Date(Date.now() + ms).toISOString();
}

export function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function deepClone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deterministic PRNG (mulberry32) so daily shop rotations are reproducible. */
export function seededRandom(seedString) {
  let seed = 0;
  for (const ch of String(seedString)) seed = (Math.imul(31, seed) + ch.charCodeAt(0)) | 0;
  return function next() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
