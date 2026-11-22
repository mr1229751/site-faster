// site-faster: a from-scratch, dependency-free reimplementation of the
// makefun-site 1.0.0 build pipeline, written for speed. run(input) returns the
// same { path: text } output tree as the reference build for every input:
// strict front matter, permalinks, a Markdown subset, collections and tags,
// a small template dialect, static files and the build report.
//
// Hot-path choices: one line split per source shared by the front matter and
// the block renderer, a char-code block classifier, a regex-driven single
// scan for inline markup, fused block classify+render (no token objects),
// word counts and cards computed once per source, and per-case link
// resolution caching.

// ---------------------------------------------------------------- text rules

const ESCAPED = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESCAPE_SCAN = /[&<>"']/g;

// Escape by scanning once with a native regex and assembling the pieces:
// runs without a special are returned untouched, and no per-character
// function call or char loop is paid for the common case.
function escapeHtml(text) {
  ESCAPE_SCAN.lastIndex = 0;
  let m = ESCAPE_SCAN.exec(text);
  if (m === null) return text;
  const parts = [];
  let last = 0;
  while (m !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(ESCAPED[m[0]]);
    last = m.index + 1;
    m = ESCAPE_SCAN.exec(text);
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.join('');
}

// Escape s[from, to) with the same scan, without materialising the slice
// first when it holds nothing escapable.
function escapeRange(s, from, to) {
  ESCAPE_SCAN.lastIndex = from;
  let m = ESCAPE_SCAN.exec(s);
  if (m === null || m.index >= to) return s.slice(from, to);
  const parts = [];
  let last = from;
  while (m !== null && m.index < to) {
    if (m.index > last) parts.push(s.slice(last, m.index));
    parts.push(ESCAPED[m[0]]);
    last = m.index + 1;
    m = ESCAPE_SCAN.exec(s);
  }
  if (last < to) parts.push(s.slice(last, to));
  return parts.join('');
}

const SLUG_LIMIT = 64;

// Slug of a piece of text: NFKD-normalise, drop combining marks, lowercase
// A-Z, fold every run of non [a-z0-9] characters into one dash, trim dashes at
// both ends, cap at SLUG_LIMIT (dropping a dash left by the cut); the empty
// result becomes "untitled". Results are memoised in `cache` for one build.
// The walk is by index over code units: kept characters are ASCII, and a
// non-kept code unit only raises the pending-dash flag, so the result is the
// same as iterating code points.
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let pendingDash = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      if (out.length > 0) pendingDash = true;
      continue;
    }
    if (pendingDash) out += '-';
    pendingDash = false;
    out += keep;
  }
  if (out.length > SLUG_LIMIT) {
    out = out.slice(0, SLUG_LIMIT);
    if (out.endsWith('-')) out = out.slice(0, -1);
  }
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

// First of slug, slug-2, slug-3, ... absent from `taken`; records the winner.
function uniqueSlug(slug, taken) {
  let candidate = slug;
  for (let n = 2; taken.has(candidate); n++) candidate = slug + '-' + n;
  taken.add(candidate);
  return candidate;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// "2026-11-09" -> "9 November 2026", computed from the string alone.
function longDate(date) {
  const dash1 = date.indexOf('-');
  const dash2 = date.indexOf('-', dash1 + 1);
  const month = Number(date.slice(dash1 + 1, dash2));
  const day = Number(date.slice(dash2 + 1));
  return day + ' ' + MONTH_NAMES[month - 1] + ' ' + date.slice(0, dash1);
}

// Code-unit comparison, the only ordering the build uses.
function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ------------------------------------------------------------- front matter
// A source opens with a line "---"; the block runs to the next "---" line.
// Inside, each line is blank, a "#" comment, or "key: value" with exactly one
// space after the colon. Seven keys exist; anything else refuses the file
// with the first reason met, scanning line by line.

const KNOWN_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function monthLength(y, m) {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// A quoted string's value, or the refusal reason. Only \" and \\ escapes.
function quotedValue(raw) {
  if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
    return { error: 'a quoted string is not closed' };
  }
  let out = '';
  for (let i = 1; i < raw.length - 1; i++) {
    const c = raw[i];
    if (c === '\\') {
      const next = raw[i + 1];
      if ((next !== '"' && next !== '\\') || i + 1 === raw.length - 1) {
        return { error: 'a quoted string holds an escape other than \\" or \\\\' };
      }
      out += next;
      i++;
    } else if (c === '"') {
      return { error: 'a quoted string holds a stray quote' };
    } else {
      out += c;
    }
  }
  return { value: out };
}

function stringValue(key, raw) {
  if (raw.startsWith('"')) {
    const q = quotedValue(raw);
    return 'error' in q ? { error: 'key "' + key + '": ' + q.error } : q;
  }
  if (raw.startsWith('[')) return { error: 'key "' + key + '": a bare string opens on [' };
  return { value: raw };
}

function keyValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary':
      return stringValue(key, raw);
    case 'date': {
      // Shape first (dddd-dd-dd, digits only), then a real calendar date in range.
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        const y = Number(raw.slice(0, 4));
        const mo = Number(raw.slice(5, 7));
        const d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= monthLength(y, mo);
      }
      return ok
        ? { value: raw }
        : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) {
        return { error: 'key "tags": not a list [a, b]' };
      }
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw === '') return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) {
          return { error: 'key "layout": not a template name' };
        }
      }
      return { value: raw };
    }
    case 'slug': {
      // [a-z0-9]+(-[a-z0-9]+)* and at most 64 characters.
      let ok = raw.length >= 1 && raw.length <= 64;
      let segment = 0;
      if (ok) {
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (c === 45) {
            if (segment === 0) { ok = false; break; }
            segment = 0;
          } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
            segment++;
          } else { ok = false; break; }
        }
        if (segment === 0) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

// Parse the front matter of an already-split source. On success returns
// { data, bodyFrom } where bodyFrom is the index of the first body line in
// `lines`; on failure { error } with the refusal reason.
function parseFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line === '' || line.startsWith('#')) continue;
    let blank = true;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank) continue;
    // "key: value": key is [a-z_]+, then a colon, then either end of line or
    // exactly one space and the raw value (trailing blanks stripped).
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) {
      return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    }
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: 'line ' + (i + 1) + ' is not "key: value"' };
    let end = raw.length;
    while (end > 0) {
      const c = raw.charCodeAt(end - 1);
      if (c === 32 || c === 9) end--;
      else break;
    }
    if (end !== raw.length) raw = raw.slice(0, end);
    const key = line.slice(0, k);
    if (!KNOWN_KEYS.has(key)) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const v = keyValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyFrom: close + 1 };
}

// ----------------------------------------------------------------- markdown
// Blocks are classified from each line's first characters and rendered in
// the same walk, so no token objects are allocated. Inline markup is driven
// by one native regex scan; nested constructs recurse over index ranges of
// the same string instead of sliced copies.

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Length of a fence opening's language, or -1: exactly three backticks, an
// optional [A-Za-z0-9_+-]* language, then only blanks.
function fenceLangLength(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return -1;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else return -1;
  }
  return langEnd - 3;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// An ATX heading on this line: { depth, text } or null. Needs 1-6 '#', at
// least one blank, then non-empty text (trailing blanks dropped).
function headingOf(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6) return null;
  const c = line.charCodeAt(depth);
  if (c !== 32 && c !== 9) return null;
  let start = depth;
  while (start < line.length) {
    const cc = line.charCodeAt(start);
    if (cc === 32 || cc === 9) start++;
    else break;
  }
  let end = line.length;
  while (end > start) {
    const cc = line.charCodeAt(end - 1);
    if (cc === 32 || cc === 9) end--;
    else break;
  }
  if (end === start) return null;
  return { depth, text: line.slice(start, end) };
}

// "---" or "***", then only blanks.
function isBreakLine(line) {
  const a = line.charCodeAt(0);
  if (a !== 45 && a !== 42) return false;
  if (line.charCodeAt(1) !== a || line.charCodeAt(2) !== a) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A list marker on this line: { textFrom, num } for "N. text" (num set) or
// { textFrom } for "- text" / "* text"; null otherwise.
function listMarker(line, ordered) {
  if (ordered) {
    let i = 0;
    while (i < line.length && i < 9) {
      const c = line.charCodeAt(i);
      if (c >= 48 && c <= 57) i++;
      else break;
    }
    if (i === 0) return null;
    // A tenth digit means the run is longer than \d{1,9} followed by ". ".
    const after = line.charCodeAt(i);
    if (after >= 48 && after <= 57) return null;
    if (after !== 46 || line.charCodeAt(i + 1) !== 32) return null;
    return { textFrom: i + 2, num: Number(line.slice(0, i)) };
  }
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return { textFrom: 2 };
  return null;
}

// JavaScript's \s as a char code (the dialect's word and continuation rules
// are stated in those terms).
function isSpaceCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279;
}

// A continuation line: at least two spaces, then a non-whitespace character.
function isContinuation(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length && !isSpaceCode(line.charCodeAt(i));
}

// A rendered paragraph line: blanks at either end dropped.
function trimLine(line) {
  let start = 0;
  let end = line.length;
  while (start < end) {
    const c = line.charCodeAt(start);
    if (c === 32 || c === 9) start++;
    else break;
  }
  while (end > start) {
    const c = line.charCodeAt(end - 1);
    if (c === 32 || c === 9) end--;
    else break;
  }
  return start === 0 && end === line.length ? line : line.slice(start, end);
}

// Whether a line ends a paragraph: blank, fence, heading or thematic break.
function endsParagraph(line) {
  return isBlankLine(line) || fenceLangLength(line) !== -1 || headingOf(line) !== null || isBreakLine(line);
}

// The characters a backslash can escape.
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

function isEscapable(c) {
  return ESCAPABLE.has(c);
}

// Whether the character at `pos` is swallowed by a backslash escape: the
// run of backslashes immediately before it, back to `floor`, is odd. An
// even run pairs up into escaped backslashes and leaves the character live.
function swallowedAt(s, pos, floor) {
  let n = 0;
  for (let k = pos - 1; k >= floor && s.charCodeAt(k) === 92; k--) n++;
  return (n & 1) === 1;
}

// First index in [from, end) where `what` occurs outside a backslash
// escape, found with indexOf jumps between candidate occurrences.
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  let j = s.indexOf(what, from);
  while (j !== -1 && j + wlen <= end) {
    if (!swallowedAt(s, j, from)) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

// First single '*' in [from, end): one whose run is not '**', outside
// escapes. The character at `end` belongs to an enclosing construct, never
// to this run, exactly as in the reference scan.
function findSingleStar(s, from, end) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < end) {
    if (swallowedAt(s, j, from)) { j = s.indexOf('*', j + 1); continue; }
    if (j + 1 < end && s[j + 1] === '*') { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

// One scan for everything that can interrupt a plain run: the inline
// construct starters, the HTML specials (tracked so a flush can skip a
// second escape scan) and '!' (plain, but scanned in the reference set).
const INLINE_SCAN = /[\\`*\[!<>&"']/g;

// Render s[from, end) as inline markup into `out` (an array of strings).
// Plain runs are copied whole; only markup characters break a run.
function renderInlineRange(s, from, end, env, out) {
  let i = from;
  let runStart = from;
  let runSpecial = false;
  const flush = (upto) => {
    if (upto > runStart) {
      out.push(runSpecial ? escapeRange(s, runStart, upto) : s.slice(runStart, upto));
    }
  };
  INLINE_SCAN.lastIndex = from;
  let m;
  while ((m = INLINE_SCAN.exec(s)) !== null) {
    i = m.index;
    if (i >= end) break;
    const c = m[0];
    if (c === '<' || c === '>' || c === '&' || c === '"' || c === "'") {
      runSpecial = true;
      i++;
      INLINE_SCAN.lastIndex = i;
      continue;
    }
    if (c === '!') {
      i++;
      INLINE_SCAN.lastIndex = i;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < end && isEscapable(s[i + 1])) {
        flush(i);
        out.push(escapeRange(s, i + 1, i + 2));
        i += 2;
        runStart = i;
        runSpecial = false;
      } else {
        i++;
      }
      INLINE_SCAN.lastIndex = i;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < end && j > i + 1) {
        flush(i);
        out.push('<code>', escapeRange(s, i + 1, j), '</code>');
        i = j + 1;
        runStart = i;
        runSpecial = false;
      } else {
        i++;
      }
      INLINE_SCAN.lastIndex = i;
      continue;
    }
    if (c === '*') {
      if (i + 1 < end && s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2, end);
        if (j > i + 2) {
          flush(i);
          out.push('<strong>');
          renderInlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
          runStart = i;
          runSpecial = false;
        } else {
          i += 2;
        }
        INLINE_SCAN.lastIndex = i;
        continue;
      }
      const j = findSingleStar(s, i + 1, end);
      if (j > i + 1) {
        flush(i);
        out.push('<em>');
        renderInlineRange(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
        runStart = i;
        runSpecial = false;
      } else {
        i++;
      }
      INLINE_SCAN.lastIndex = i;
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1, end);
    let mm = -1;
    if (k !== -1 && k + 1 < end && s[k + 1] === '(') {
      mm = s.indexOf(')', k + 2);
      if (mm >= end) mm = -1;
    }
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      flush(i);
      out.push('<a href="', escapeHtml(env.link(target)), '">');
      renderInlineRange(s, i + 1, k, env, out);
      out.push('</a>');
      i = mm + 1;
      runStart = i;
      runSpecial = false;
    } else {
      i++;
    }
    INLINE_SCAN.lastIndex = i;
  }
  flush(end);
}

function renderInline(s, env) {
  // Fast path: with no backslash, backtick, '*' or '[' the range scan can
  // only ever flush the whole string through the escaper, so return that
  // directly — byte-identical to what the range path would produce.
  if (!/[\\`*\[]/.test(s)) return escapeHtml(s);
  const out = [];
  renderInlineRange(s, 0, s.length, env, out);
  return out.join('');
}

// Render a body's lines in one fused classify+render walk: the HTML (one
// block after another, each followed by a newline), the table of contents
// (levels 2 and 3) and the excerpt (the first paragraph's inline HTML).
function renderMarkdown(lines, from, env, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = from;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const langLen = fenceLangLength(line);
    if (langLen !== -1) {
      const lang = line.slice(3, 3 + langLen);
      i++;
      let inner = '';
      while (i < lines.length && !isFenceClose(lines[i])) { inner += escapeHtml(lines[i]) + '\n'; i++; }
      i++;
      const cls = lang === '' ? '' : ' class="language-' + escapeHtml(lang) + '"';
      blocks.push('<pre><code' + cls + '>' + inner + '</code></pre>');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const html = renderInline(heading.text, env);
      blocks.push('<h' + heading.depth + ' id="' + id + '">' + html + '</h' + heading.depth + '>');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isBreakLine(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let stripped = lines[i].slice(1);
        if (stripped.charCodeAt(0) === 32) stripped = stripped.slice(1);
        const t = trimLine(stripped);
        if (t !== '') body.push(t);
        i++;
      }
      if (body.length === 0) blocks.push('<blockquote>\n</blockquote>');
      else blocks.push('<blockquote>\n<p>' + renderInline(body.join('\n'), env) + '</p>\n</blockquote>');
      continue;
    }
    const bullet = listMarker(line, false);
    const orderedMark = bullet === null ? listMarker(line, true) : null;
    if (bullet !== null || orderedMark !== null) {
      const isOrdered = orderedMark !== null;
      const items = [];
      while (i < lines.length) {
        const mk = listMarker(lines[i], isOrdered);
        if (mk !== null) {
          items.push([trimLine(lines[i].slice(mk.textFrom))]);
          i++;
        } else if (items.length > 0 && isContinuation(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && orderedMark.num !== 1 ? '<ol start="' + orderedMark.num + '">' : '<' + tag + '>';
      let inner = '';
      for (const parts of items) inner += '<li>' + renderInline(parts.join('\n'), env) + '</li>\n';
      blocks.push(open + '\n' + inner + '</' + tag + '>');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) {
      body.push(trimLine(lines[i]));
      i++;
    }
    const html = renderInline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push('<p>' + html + '</p>');
  }
  let html = '';
  for (const b of blocks) html += b + '\n';
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates
// The template dialect: {{ path }} escaped, {{{ path }}} raw, {% for %},
// {% if %}/{% if not %}/{% else %}, {% include "name" %}. A {% %} tag alone
// on its line removes the whole line, newline included. Paths are dot-joined
// names; lookup walks the scope chain by own properties only.
//
// Each parsed template is also converted into thunks (one closure per node)
// that render through the same helpers and scope objects; if thunk
// construction throws for a template, that template automatically falls
// back to the interpreted node walk below.

const INCLUDE_LIMIT = 8;

class TemplateProblem extends Error {}

function isPathText(text) {
  // [A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*
  let i = 0;
  for (;;) {
    const c = text.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) return false;
    i++;
    while (i < text.length) {
      const d = text.charCodeAt(i);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95) i++;
      else break;
    }
    if (i === text.length) return true;
    if (text.charCodeAt(i) !== 46) return false;
    i++;
    if (i === text.length) return false;
  }
}

function checkedPath(name, text) {
  if (!isPathText(text)) {
    throw new TemplateProblem('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  }
  return text.split('.');
}

// Split a template source into text / var / raw / tag tokens.
function tokenizeTemplate(name, src) {
  const tokens = [];
  let pending = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      pending += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      pending += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    pending += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const closer = raw ? '}}}' : '}}';
      const close = src.indexOf(closer, open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TemplateProblem('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      }
      if (pending !== '') { tokens.push({ t: 'text', text: pending }); pending = ''; }
      const inner = src.slice(open + (raw ? 3 : 2), close).trim();
      tokens.push({ t: raw ? 'raw' : 'var', path: checkedPath(name, inner) });
      i = close + closer.length;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) {
      throw new TemplateProblem('template "' + name + '": a {% is not closed');
    }
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let standalone = true;
    for (let j = lineStart; j < open; j++) {
      const c = src.charCodeAt(j);
      if (c !== 32 && c !== 9) { standalone = false; break; }
    }
    if (standalone) {
      for (let j = end; j < lineEnd; j++) {
        const c = src.charCodeAt(j);
        if (c !== 32 && c !== 9) { standalone = false; break; }
      }
    }
    if (standalone) pending = pending.slice(0, pending.length - (open - lineStart));
    if (pending !== '') { tokens.push({ t: 'text', text: pending }); pending = ''; }
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (pending !== '') tokens.push({ t: 'text', text: pending });
  return tokens;
}

// Parse a template into its node tree, or throw TemplateProblem.
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') { body.push({ kind: 'text', text: tok.text }); continue; }
    if (tok.t === 'var' || tok.t === 'raw') { body.push({ kind: tok.t, path: tok.path }); continue; }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    if (tag.startsWith('for ') || tag === 'for') {
      const m = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/.exec(tag);
      if (m !== null) {
        const node = { kind: 'for', name: m[1], path: checkedPath(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
        continue;
      }
    }
    if (tag.startsWith('if ') || tag === 'if') {
      const m = /^if (not )?(\S+)$/.exec(tag);
      if (m !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: checkedPath(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
        continue;
      }
    }
    if (tag === 'else') {
      if (top.kind !== 'if' || top.else !== null) {
        throw new TemplateProblem('template "' + name + '": an else outside an if');
      }
      top.else = [];
      body = top.else;
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== want) {
        throw new TemplateProblem('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      continue;
    }
    if (tag.startsWith('include ') || tag === 'include') {
      const m = /^include "([a-z0-9-]+)"$/.exec(tag);
      if (m !== null) {
        body.push({ kind: 'include', name: m[1] });
        continue;
      }
    }
    throw new TemplateProblem('template "' + name + '": {% ' + tag + ' %} is not a tag');
  }
  if (stack.length > 1) {
    throw new TemplateProblem('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  }
  return root.body;
}

// The value at `path`: its first name from the nearest scope holding it,
// then own properties down the chain.
function lookupPath(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

// A value as template text.
function valueText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(valueText).join(', ');
  return '';
}

function isTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Render parsed nodes into `out`. Includes nest at most INCLUDE_LIMIT deep.
function renderNodes(nodes, scope, templates, depth, out) {
  for (const n of nodes) {
    if (n.kind === 'text') {
      out.push(n.text);
    } else if (n.kind === 'var') {
      out.push(escapeHtml(valueText(lookupPath(scope, n.path))));
    } else if (n.kind === 'raw') {
      out.push(valueText(lookupPath(scope, n.path)));
    } else if (n.kind === 'if') {
      const branch = isTruthy(lookupPath(scope, n.path)) !== n.not ? n.then : n.else;
      if (branch !== null) renderNodes(branch, scope, templates, depth, out);
    } else if (n.kind === 'for') {
      const xs = lookupPath(scope, n.path);
      if (!Array.isArray(xs)) continue;
      for (let k = 0; k < xs.length; k++) {
        const vars = {
          [n.name]: xs[k],
          loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length },
        };
        renderNodes(n.body, { vars, parent: scope }, templates, depth, out);
      }
    } else if (n.kind === 'include') {
      const t = templates.get(n.name);
      if (t !== undefined && depth < INCLUDE_LIMIT) renderEntry(t, scope, templates, depth + 1, out);
    }
  }
}

// One node -> one closure with the same semantics as renderNodes.
function thunkOf(n) {
  if (n.kind === 'text') {
    const text = n.text;
    return (scope, templates, depth, out) => { out.push(text); };
  }
  if (n.kind === 'var') {
    const path = n.path;
    return (scope, templates, depth, out) => { out.push(escapeHtml(valueText(lookupPath(scope, path)))); };
  }
  if (n.kind === 'raw') {
    const path = n.path;
    return (scope, templates, depth, out) => { out.push(valueText(lookupPath(scope, path))); };
  }
  if (n.kind === 'if') {
    const path = n.path;
    const neg = n.not;
    const thenThunks = n.then.map(thunkOf);
    const elseThunks = n.else === null ? null : n.else.map(thunkOf);
    return (scope, templates, depth, out) => {
      const branch = isTruthy(lookupPath(scope, path)) !== neg ? thenThunks : elseThunks;
      if (branch !== null) for (const t of branch) t(scope, templates, depth, out);
    };
  }
  if (n.kind === 'for') {
    const path = n.path;
    const name = n.name;
    const bodyThunks = n.body.map(thunkOf);
    return (scope, templates, depth, out) => {
      const xs = lookupPath(scope, path);
      if (!Array.isArray(xs)) return;
      for (let k = 0; k < xs.length; k++) {
        const vars = {
          [name]: xs[k],
          loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length },
        };
        const child = { vars, parent: scope };
        for (const t of bodyThunks) t(child, templates, depth, out);
      }
    };
  }
  // include
  const incName = n.name;
  return (scope, templates, depth, out) => {
    const t = templates.get(incName);
    if (t !== undefined && depth < INCLUDE_LIMIT) renderEntry(t, scope, templates, depth + 1, out);
  };
}

// A template entry is { nodes, thunks }: thunks when construction worked,
// null when it threw (the interpreted walk is then used for every render).
function makeEntry(nodes) {
  let thunks = null;
  try {
    thunks = nodes.map(thunkOf);
  } catch {
    thunks = null;
  }
  return { nodes, thunks };
}

function renderEntry(entry, scope, templates, depth, out) {
  if (entry.thunks !== null) {
    for (const t of entry.thunks) t(scope, templates, depth, out);
  } else {
    renderNodes(entry.nodes, scope, templates, depth, out);
  }
}

// ------------------------------------------------------------------- build

const REPORT_PATH = 'build-report.txt';
const ROOT_RESERVED = ['posts', 'tags', 'page'];

function dirOf(path) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

// Resolve a link's relative path against a source directory whose segments
// were split once (`dirParts`); null when the path climbs above the root.
// The caller's array is copied, never mutated.
function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}

// The number of whitespace-separated words in a body's lines, with the
// whitespace predicate inlined (no per-character function call).
function countWords(lines, from) {
  let count = 0;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    let inWord = false;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      const space = c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
        (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
        c === 8287 || c === 12288 || c === 65279;
      if (space) inWord = false;
      else if (!inWord) { inWord = true; count++; }
    }
  }
  return count;
}

const ABSOLUTE_LINK = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// One site's output tree: path -> text.
export function run(input) {
  const slugCache = new Map();

  // Templates parse first, in name order; one that fails is reported and
  // counts as absent for every later check.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, makeEntry(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateProblem)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources in path order; .md files are sources, everything else static.
  // The CRLF normalisation is skipped entirely for sources without a CR.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const rawSources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      rawSources.push({ path: f.path, lines: text.split('\n') });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // Front matter: refused sources and drafts are reported and dropped.
  const sources = [];
  for (const s of rawSources) {
    const fm = parseFrontMatter(s.lines);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.bodyFrom = fm.bodyFrom;
    s.post = s.path.startsWith('posts/');
    let own = null;
    for (const d of ROOT_RESERVED) {
      if (d !== 'posts' && s.path.startsWith(d + '/')) { own = d; break; }
    }
    if (own !== null) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    sources.push(s);
  }

  // Permalinks: each page's slug, unique within its output directory.
  const takenByDir = new Map();
  const takenIn = (dir) => {
    let set = takenByDir.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ROOT_RESERVED : []);
      takenByDir.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // Markdown, with links resolved against built pages and static files.
  // Resolutions are cached per case by (dir, rel): the cache stores the
  // href without its fragment, or null for a broken target; the broken
  // line itself is still recorded once per linking source.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  const linkCache = new Map();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (ABSOLUTE_LINK.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        if (rel === '') {
          broken.add('broken-link ' + s.path + ' -> ' + target);
          return target;
        }
        const key = dir + '\n' + rel;
        let href = linkCache.get(key);
        if (href === undefined) {
          href = null;
          const path = resolvePath(dirParts, rel);
          if (path !== null) {
            const page = bySource.get(path);
            if (page !== undefined) href = page.url;
            else if (staticPaths.has(path)) href = base + '/' + path;
          }
          linkCache.set(key, href);
        }
        if (href === null) {
          broken.add('broken-link ' + s.path + ' -> ' + target);
          return target;
        }
        return href + frag;
      },
    };
    s.words = countWords(s.lines, s.bodyFrom);
    const md = renderMarkdown(s.lines, s.bodyFrom, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, then by slug; neighbours linked.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, named as first met in post order, ordered by
  // count then slug. A page's tags resolve to the posts' tag of the slug.
  const tagBySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const kept = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        kept.push(name);
      }
    }
    return kept;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = tagBySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        tagBySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return tagBySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...tagBySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug),
  );

  // The records templates read. A source's link record and card are built
  // once and memoised on the source / in the cards map.
  const linkOf = (s) => {
    if (s === null) return null;
    if (s.linkObj === undefined) {
      s.linkObj = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      };
    }
    return s.linkObj;
  };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil((s.words ?? countWords(s.lines, s.bodyFrom)) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s, cards) => ({
    ...cards.get(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // Layouts: every page, the paginated index, the tag pages, the tags index,
  // then the static files (a built page's path shadows a static file).
  const cards = new Map();
  for (const s of sources) cards.set(s, cardOf(s));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const render = (name, vars) => {
    const entry = templates.get(name);
    if (entry === undefined) return null;
    const out = [];
    renderEntry(entry, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, templates, 0, out);
    return out.join('');
  };
  for (const s of sources) output[s.outDir + '/index.html'] = render(s.layout, { page: pageOf(s, cards) });
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: {
        name: t.name,
        slug: t.slug,
        url: t.url,
        count: t.posts.length,
        posts: t.posts.map((p) => cards.get(p)),
      },
    });
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // Report: every refusal, draft, broken link and parse failure, sorted in
  // code-unit order, then the built counts as the last line.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageTotal = 0;
  for (const s of sources) if (!s.post) pageTotal++;
  lines.push(
    'built ' + pageTotal + ' pages, ' + posts.length + ' posts, ' + tags.length +
    ' tags and ' + statics.length + ' static files',
  );
  output[REPORT_PATH] = lines.join('\n') + '\n';
  return output;
}
