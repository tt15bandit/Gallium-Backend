/**
 * Minimal path router. Patterns use "/literal/:param/*" syntax; literal segments match
 * case-insensitively (Fortnite builds are inconsistent about casing), params keep their case.
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, ...handlers) {
    if (!handlers.length) throw new Error(`No handler for ${method} ${pattern}`);
    this.routes.push({ method: method.toUpperCase(), pattern, segments: compile(pattern), handlers: handlers.flat() });
    return this;
  }

  get(p, ...h) { return this.add('GET', p, ...h); }
  post(p, ...h) { return this.add('POST', p, ...h); }
  put(p, ...h) { return this.add('PUT', p, ...h); }
  patch(p, ...h) { return this.add('PATCH', p, ...h); }
  delete(p, ...h) { return this.add('DELETE', p, ...h); }
  all(p, ...h) { return this.add('*', p, ...h); }

  /** @returns {{route, params}|{methodMismatch: true}|null} */
  match(method, path) {
    const parts = splitPath(path);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      if (route.method === '*' || route.method === method || (method === 'HEAD' && route.method === 'GET')) {
        return { route, params };
      }
      pathMatched = true;
    }
    return pathMatched ? { methodMismatch: true } : null;
  }
}

function splitPath(path) {
  return path.split('/').filter((s) => s.length > 0);
}

function compile(pattern) {
  return splitPath(pattern).map((seg) => {
    if (seg === '*') return { type: 'rest' };
    if (seg.startsWith(':')) return { type: 'param', name: seg.slice(1) };
    return { type: 'literal', value: seg.toLowerCase() };
  });
}

function matchSegments(segments, parts) {
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type === 'rest') {
      params['*'] = parts.slice(i).map(safeDecode).join('/');
      return params;
    }
    const part = parts[i];
    if (part === undefined) return null;
    if (seg.type === 'literal') {
      if (part.toLowerCase() !== seg.value) return null;
    } else {
      params[seg.name] = safeDecode(part);
    }
  }
  return parts.length === segments.length ? params : null;
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
