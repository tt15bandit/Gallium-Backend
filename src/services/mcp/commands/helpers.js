import { Errors } from '../../../core/errors.js';

/** Attach routing metadata to an MCP handler. */
export function command(fn, { routes, profiles } = {}) {
  if (routes) fn.routes = routes;
  if (profiles) fn.profiles = profiles;
  return fn;
}

export function requireString(body, key, { allowEmpty = false, max = 256 } = {}) {
  const v = body[key];
  if (typeof v !== 'string' || (!allowEmpty && v.length === 0) || v.length > max) {
    throw Errors.validation(`${key} must be a ${allowEmpty ? '' : 'non-empty '}string of at most ${max} characters`);
  }
  return v;
}

export function optionalString(body, key, fallback = '') {
  const v = body[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string') throw Errors.validation(`${key} must be a string`);
  return v;
}

export function requireBool(body, key) {
  const v = body[key];
  if (typeof v !== 'boolean') throw Errors.validation(`${key} must be a boolean`);
  return v;
}

export function requireInt(body, key, { min = -Infinity, max = Infinity, fallback } = {}) {
  let v = body[key];
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) v = Number(v);
  if (!Number.isInteger(v) || v < min || v > max) throw Errors.validation(`${key} must be an integer between ${min} and ${max}`);
  return v;
}

export function requireArray(body, key, { max = 1000, of = null } = {}) {
  const v = body[key];
  if (!Array.isArray(v) || v.length > max) throw Errors.validation(`${key} must be an array of at most ${max} entries`);
  if (of === 'string' && v.some((x) => typeof x !== 'string')) throw Errors.validation(`${key} must only contain strings`);
  return v;
}
