/**
 * Small XML toolkit for XMPP: a parser for single stanzas, a serializer, and a streaming
 * splitter that cuts a raw-TCP XMPP stream into top-level stanzas.
 */

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[ent] ?? m;
  });
}

export class XmlNode {
  constructor(name, attrs = {}, children = []) {
    this.name = name;
    this.attrs = attrs;
    this.children = children; // XmlNode | string
  }

  /** Local name without namespace prefix ("stream:features" -> "features"). */
  get local() {
    const i = this.name.indexOf(':');
    return i === -1 ? this.name : this.name.slice(i + 1);
  }

  get text() {
    return this.children.map((c) => (typeof c === 'string' ? c : c.text)).join('');
  }

  get elements() {
    return this.children.filter((c) => typeof c !== 'string');
  }

  child(localName) {
    return this.elements.find((c) => c.local === localName) || null;
  }

  childText(localName) {
    const c = this.child(localName);
    return c ? c.text : null;
  }

  toString() {
    return serialize(this);
  }
}

/** Build an element: el('iq', { type: 'result' }, [el('bind', ...)]) or el('body', {}, 'text'). */
export function el(name, attrs = {}, children = []) {
  const kids = Array.isArray(children) ? children : [children];
  const cleanAttrs = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) cleanAttrs[k] = String(v);
  return new XmlNode(name, cleanAttrs, kids.filter((c) => c !== undefined && c !== null && c !== false));
}

export function serialize(node, { selfClose = true, open = false } = {}) {
  if (typeof node === 'string') return escapeXml(node);
  const attrs = Object.entries(node.attrs).map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
  if (open) return `<${node.name}${attrs}>`;
  if (!node.children.length && selfClose) return `<${node.name}${attrs}/>`;
  return `<${node.name}${attrs}>${node.children.map((c) => serialize(c)).join('')}</${node.name}>`;
}

/**
 * Parse one XML element (optionally preceded by an XML declaration).
 * With { allowUnclosed: true } an unclosed root (e.g. "<stream:stream ...>") is returned as-is.
 */
export function parseXml(input, { allowUnclosed = false } = {}) {
  const s = String(input);
  let i = 0;
  const stack = [];
  let root = null;

  const fail = (msg) => {
    throw new XmlError(`${msg} at offset ${i}`);
  };

  while (i < s.length) {
    if (s[i] !== '<') {
      const next = s.indexOf('<', i);
      const end = next === -1 ? s.length : next;
      const text = s.slice(i, end);
      if (stack.length) stack[stack.length - 1].children.push(decodeEntities(text));
      else if (text.trim()) fail('Text outside root element');
      i = end;
      continue;
    }
    if (s.startsWith('<?', i)) {
      const end = s.indexOf('?>', i);
      if (end === -1) fail('Unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i);
      if (end === -1) fail('Unterminated comment');
      i = end + 3;
      continue;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i);
      if (end === -1) fail('Unterminated CDATA');
      if (stack.length) stack[stack.length - 1].children.push(s.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (s[i + 1] === '/') {
      const end = s.indexOf('>', i);
      if (end === -1) fail('Unterminated closing tag');
      const name = s.slice(i + 2, end).trim();
      const node = stack.pop();
      if (!node || node.name !== name) fail(`Mismatched closing tag </${name}>`);
      i = end + 1;
      if (!stack.length) {
        root = node;
        break;
      }
      continue;
    }
    // opening tag
    i++;
    const nameMatch = /^[^\s/>]+/.exec(s.slice(i));
    if (!nameMatch) fail('Invalid tag name');
    const name = nameMatch[0];
    i += name.length;
    const attrs = {};
    let selfClosing = false;
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) fail('Unterminated tag');
      if (s[i] === '>') {
        i++;
        break;
      }
      if (s[i] === '/' && s[i + 1] === '>') {
        selfClosing = true;
        i += 2;
        break;
      }
      const attrMatch = /^([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(s.slice(i));
      if (!attrMatch) fail(`Invalid attribute in <${name}>`);
      attrs[attrMatch[1]] = decodeEntities(attrMatch[3] ?? attrMatch[4]);
      i += attrMatch[0].length;
    }
    const node = new XmlNode(name, attrs, []);
    if (stack.length) stack[stack.length - 1].children.push(node);
    if (selfClosing) {
      if (!stack.length) {
        root = node;
        break;
      }
    } else {
      stack.push(node);
    }
  }
  if (!root) {
    if (allowUnclosed && stack.length) return stack[0];
    fail('Incomplete XML document');
  }
  return root;
}

export class XmlError extends Error {}

/**
 * Splits a continuous XMPP stream (raw TCP) into events:
 *   { type: 'open', xml }   the <stream:stream ...> opening tag
 *   { type: 'stanza', xml } one complete top-level child element
 *   { type: 'close' }       </stream:stream>
 */
export class XmlStreamSplitter {
  constructor(maxBuffer = 1024 * 1024) {
    this.buf = '';
    this.maxBuffer = maxBuffer;
    this.depth = 0; // element depth at the scan position (stream wrapper counts as 1)
    this.scan = 0; // offset in buf where scanning resumes
    this.stanzaStart = -1; // offset in buf of the stanza being collected
    this.stanzaBase = 0; // depth at which the current stanza started
  }

  push(chunk) {
    this.buf += chunk;
    if (this.buf.length > this.maxBuffer) throw new XmlError('XMPP stanza too large');
    const events = [];
    let i = this.scan;
    let consumed = 0;
    while (i < this.buf.length) {
      const lt = this.buf.indexOf('<', i);
      if (lt === -1) {
        i = this.buf.length;
        if (this.stanzaStart === -1) consumed = i; // whitespace keep-alives between stanzas
        break;
      }
      const end = this._findTagEnd(lt);
      if (end === -1) {
        i = lt; // incomplete tag, wait for more data
        break;
      }
      const tag = this.buf.slice(lt, end + 1);
      i = end + 1;
      if (tag.startsWith('<?') || tag.startsWith('<!--') || tag.startsWith('<![CDATA[')) {
        if (this.stanzaStart === -1) consumed = i;
        continue;
      }
      if (tag.startsWith('</')) {
        this.depth--;
        if (this.stanzaStart !== -1 && this.depth === this.stanzaBase) {
          events.push({ type: 'stanza', xml: this.buf.slice(this.stanzaStart, i) });
          this.stanzaStart = -1;
          consumed = i;
        } else if (this.stanzaStart === -1 && this.depth <= 0) {
          this.depth = 0;
          events.push({ type: 'close' });
          consumed = i;
        }
        continue;
      }
      const selfClosing = tag.endsWith('/>');
      if (this.stanzaStart === -1) {
        // A new <stream:stream> outside any stanza is a stream (re)start, e.g. after SASL success.
        if (!selfClosing && /^<(stream:)?stream[\s>]/.test(tag)) {
          this.depth = 1;
          events.push({ type: 'open', xml: tag });
          consumed = i;
        } else if (selfClosing) {
          events.push({ type: 'stanza', xml: tag });
          consumed = i;
        } else {
          this.stanzaStart = lt;
          this.stanzaBase = this.depth;
          this.depth++;
        }
        continue;
      }
      if (!selfClosing) this.depth++;
    }
    // Drop everything already emitted; keep the partial stanza / partial tag.
    if (consumed > 0) {
      this.buf = this.buf.slice(consumed);
      if (this.stanzaStart !== -1) this.stanzaStart -= consumed;
      i -= consumed;
    }
    this.scan = i;
    return events;
  }

  _findTagEnd(start) {
    const s = this.buf;
    if (s.startsWith('<!--', start)) {
      const e = s.indexOf('-->', start);
      return e === -1 ? -1 : e + 2;
    }
    if (s.startsWith('<![CDATA[', start)) {
      const e = s.indexOf(']]>', start);
      return e === -1 ? -1 : e + 2;
    }
    let quote = null;
    for (let j = start + 1; j < s.length; j++) {
      const c = s[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') return j;
    }
    return -1;
  }
}
