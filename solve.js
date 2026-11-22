// site-faster — a fast, dependency-free stand-in for makefun-site 1.0.0.
//
// run(input) rebuilds the reference site's whole output tree, byte for byte:
// strict front matter, permalinks, a Markdown subset, tag/collection
// assembly, a small template language, static files and the build report.
//
// How this build is organised (and where its speed comes from):
//   * each source is split into lines exactly once; the front-matter reader
//     and the block renderer both walk that single array;
//   * block rendering classifies a line once into a small numeric kind and
//     renders in the same pass — no intermediate block objects;
//   * inline markup is one regex-driven sweep over index ranges of the
//     original string, recursing on ranges rather than sliced copies;
//   * templates are compiled to a flat instruction list with numeric opcodes
//     and patched jump addresses; a closure ("thunk") form of the same list
//     is the fast path, and the program-counter interpreter over the list is
//     kept as the automatic fallback if thunk construction ever fails;
//   * word counts, cards and link resolutions are computed once per source
//     and memoised for the rest of the run (never across runs).

// ------------------------------------------------------------ text basics

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

// Escape a whole string. The regex finds the specials; the stretches between
// them are copied verbatim, so a string with nothing to escape is returned
// as-is and no character loop ever runs over plain text.
function escHtml(str) {
  ESC_RE.lastIndex = 0;
  let m = ESC_RE.exec(str);
  if (m === null) return str;
  const pieces = [str.slice(0, m.index), ESC_MAP[m[0]]];
  let last = m.index + 1;
  for (m = ESC_RE.exec(str); m !== null; m = ESC_RE.exec(str)) {
    pieces.push(str.slice(last, m.index), ESC_MAP[m[0]]);
    last = m.index + 1;
  }
  pieces.push(str.slice(last));
  return pieces.join('');
}

// Escape str[a, b) the same way, without slicing the range out first when
// it turns out to hold no special at all.
function escSlice(str, a, b) {
  ESC_RE.lastIndex = a;
  let m = ESC_RE.exec(str);
  if (m === null || m.index >= b) return str.slice(a, b);
  const pieces = [str.slice(a, m.index), ESC_MAP[m[0]]];
  let last = m.index + 1;
  for (m = ESC_RE.exec(str); m !== null && m.index < b; m = ESC_RE.exec(str)) {
    pieces.push(str.slice(last, m.index), ESC_MAP[m[0]]);
    last = m.index + 1;
  }
  pieces.push(str.slice(last, b));
  return pieces.join('');
}

// Code-unit order: the one ordering used everywhere in the build.
function cmpCU(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

const SLUG_CAP = 64;

// Turn arbitrary text into a slug: NFKD-normalise, strip combining marks,
// keep [a-z0-9] (folding A-Z down), collapse every run of anything else to a
// single dash, trim edge dashes, cap the length, and fall back to
// "untitled" when nothing survives. `memo` caches per build. The walk goes
// by code point: a dropped code point only raises the pending-dash flag,
// which is exactly what the reference's code-unit walk computes.
function makeSlug(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  const out = [];
  let dashPending = false;
  for (const ch of plain) {
    let keep = '';
    if (ch >= 'a' && ch <= 'z') keep = ch;
    else if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if (ch >= '0' && ch <= '9') keep = ch;
    if (keep === '') {
      if (out.length > 0) dashPending = true;
    } else {
      if (dashPending) {
        out.push('-');
        dashPending = false;
      }
      out.push(keep);
    }
  }
  let slug = out.join('');
  if (slug.length > SLUG_CAP) {
    slug = slug.slice(0, SLUG_CAP);
    if (slug.endsWith('-')) slug = slug.slice(0, slug.length - 1);
  }
  if (slug === '') slug = 'untitled';
  memo.set(text, slug);
  return slug;
}

// Claim slug, slug-2, slug-3, ... — the first one `taken` does not hold.
function claimSlug(slug, taken) {
  let n = 2;
  let candidate = slug;
  while (taken.has(candidate)) {
    candidate = slug + '-' + n;
    n++;
  }
  taken.add(candidate);
  return candidate;
}

const MONTH_WORDS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// "2026-11-09" as "9 November 2026", straight from the date string's parts.
function spellDate(date) {
  const parts = date.split('-');
  return Number(parts[2]) + ' ' + MONTH_WORDS[Number(parts[1]) - 1] + ' ' + parts[0];
}

// ---------------------------------------------------------- front matter
// A source must open with a "---" line; the block ends at the next "---"
// line. Reading is an explicit line-cursor machine: find the closing fence,
// then consume one line at a time — blank lines and "#" comments are
// skipped, every other line must be "key: value" (exactly one space after
// the colon) and is dispatched through the handler table below. The first
// problem met refuses the file, with the reference's exact wording.

function leapYear(y) {
  return y % 400 === 0 || (y % 4 === 0 && y % 100 !== 0);
}

function daysInMonth(y, m) {
  if (m === 2) return leapYear(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// Read a quoted raw value: [value] on success, [null, reason] on failure.
// The only escapes are \" and \\.
function readQuoted(raw) {
  if (raw.length < 2 || raw[raw.length - 1] !== '"') {
    return [null, 'a quoted string is not closed'];
  }
  let value = '';
  let i = 1;
  while (i < raw.length - 1) {
    const c = raw[i];
    if (c === '"') return [null, 'a quoted string holds a stray quote'];
    if (c === '\\') {
      const nxt = raw[i + 1];
      if (i + 1 === raw.length - 1 || (nxt !== '"' && nxt !== '\\')) {
        return [null, 'a quoted string holds an escape other than \\" or \\\\'];
      }
      value += nxt;
      i += 2;
    } else {
      value += c;
      i++;
    }
  }
  return [value, null];
}

// Handler results are [value, null] or [null, reason].
function fmString(key, raw) {
  if (raw.startsWith('"')) {
    const [value, why] = readQuoted(raw);
    return why === null ? [value, null] : [null, 'key "' + key + '": ' + why];
  }
  if (raw.startsWith('[')) return [null, 'key "' + key + '": a bare string opens on ['];
  return [raw, null];
}

function fmDate(raw) {
  const bad = [null, 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)'];
  if (raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-') return bad;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return bad;
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return bad;
  return [raw, null];
}

function fmTags(raw) {
  if (!raw.startsWith('[') || !raw.endsWith(']')) {
    return [null, 'key "tags": not a list [a, b]'];
  }
  const inner = raw.slice(1, raw.length - 1);
  if (inner.trim() === '') return [[], null];
  const tags = [];
  for (const piece of inner.split(',')) {
    const t = piece.trim();
    if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
      return [null, 'key "tags": an empty tag, or one holding " [ or ]'];
    }
    tags.push(t);
  }
  return [tags, null];
}

function fmDraft(raw) {
  if (raw === 'true') return [true, null];
  if (raw === 'false') return [false, null];
  return [null, 'key "draft": true or false'];
}

function fmLayout(raw) {
  let ok = raw.length > 0;
  for (let i = 0; ok && i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
  }
  return ok ? [raw, null] : [null, 'key "layout": not a template name'];
}

function fmSlug(raw) {
  // [a-z0-9]+(-[a-z0-9]+)* with total length at most 64.
  let ok = raw.length >= 1 && raw.length <= 64;
  let segLen = 0;
  for (let i = 0; ok && i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 45) {
      ok = segLen > 0;
      segLen = 0;
    } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      segLen++;
    } else {
      ok = false;
    }
  }
  if (segLen === 0) ok = false;
  return ok ? [raw, null] : [null, 'key "slug": not a slug'];
}

// Key dispatch: the seven keys that exist, each with its own reader.
const FM_READERS = {
  title: (raw) => fmString('title', raw),
  summary: (raw) => fmString('summary', raw),
  date: fmDate,
  tags: fmTags,
  draft: fmDraft,
  layout: fmLayout,
  slug: fmSlug,
};

// Read the front matter of an already-split source. Success:
// { data, bodyFrom } with bodyFrom the index of the first body line.
// Failure: { error } carrying the refusal reason.
function readFrontMatter(lines) {
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let pos = 1;
  while (pos < close) {
    const line = lines[pos];
    pos++;
    if (line === '' || line[0] === '#') continue;
    let blankOnly = true;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) {
        blankOnly = false;
        break;
      }
    }
    if (blankOnly) continue;
    // Split "key: value": the key is [a-z_]+ up to the colon.
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    const lineNo = pos; // pos was already advanced: it equals the 1-based number
    if (k === 0 || line.charCodeAt(k) !== 58) {
      return { error: 'line ' + lineNo + ' is not "key: value"' };
    }
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: 'line ' + lineNo + ' is not "key: value"' };
    // Trailing blanks are not part of the value.
    let end = raw.length;
    while (end > 0 && (raw.charCodeAt(end - 1) === 32 || raw.charCodeAt(end - 1) === 9)) end--;
    if (end !== raw.length) raw = raw.slice(0, end);
    const key = line.slice(0, k);
    const reader = FM_READERS[key];
    if (reader === undefined) return { error: 'unknown key "' + key + '"' };
    if (Object.hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
    if (raw === '') return { error: 'key "' + key + '" has no value' };
    const [value, why] = reader(raw);
    if (why !== null) return { error: why };
    data[key] = value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, bodyFrom: close + 1 };
}

// ------------------------------------------------------------- markdown
// A line is classified once, from its opening characters, into one of the
// kinds below; the renderer is a switch over that kind. probeLine returns a
// tuple: [kind] for blank/break/quote, [K_FENCE, langLength],
// [K_HEAD, depth, text], [K_LIST, ordered, startNumber, textFrom].

const K_BLANK = 0;
const K_FENCE = 1;
const K_HEAD = 2;
const K_BREAK = 3;
const K_QUOTE = 4;
const K_LIST = 5;
const K_PARA = 6;

function lineIsBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Length of the language tag on a fence opener, or -1 when the line is not
// one: three backticks, an optional [A-Za-z0-9_+-]* tag, then only blanks.
function fenceTagLen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return -1;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    const tagChar =
      (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
      c === 95 || c === 43 || c === 45;
    if (!tagChar) break;
    i++;
  }
  const tagEnd = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return -1;
    i++;
  }
  return tagEnd - 3;
}

function fenceCloses(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// [depth, text] for an ATX heading line, else null: 1-6 '#', at least one
// blank, then non-empty text with edge blanks dropped.
function probeHeading(line) {
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth === 0 || depth > 6) return null;
  const after = line.charCodeAt(depth);
  if (after !== 32 && after !== 9) return null;
  let start = depth;
  while (start < line.length && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  let end = line.length;
  while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  if (end === start) return null;
  return [depth, line.slice(start, end)];
}

// "---" or "***" followed by nothing but blanks.
function lineIsBreak(line) {
  const a = line.charCodeAt(0);
  if ((a !== 45 && a !== 42) || line.charCodeAt(1) !== a || line.charCodeAt(2) !== a) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// List markers: for unordered lines [2] (the text offset); for ordered
// lines [textOffset, number]; null when the line carries no marker of the
// requested flavour.
function probeMarker(line, ordered) {
  if (!ordered) {
    const c = line.charCodeAt(0);
    return (c === 45 || c === 42) && line.charCodeAt(1) === 32 ? [2] : null;
  }
  let i = 0;
  while (i < line.length && i < 9) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    i++;
  }
  if (i === 0) return null;
  const after = line.charCodeAt(i);
  if (after >= 48 && after <= 57) return null; // a tenth digit: not \d{1,9}
  if (after !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return [i + 2, Number(line.slice(0, i))];
}

function probeLine(line) {
  if (lineIsBlank(line)) return [K_BLANK];
  const tagLen = fenceTagLen(line);
  if (tagLen !== -1) return [K_FENCE, tagLen];
  const head = probeHeading(line);
  if (head !== null) return [K_HEAD, head[0], head[1]];
  if (lineIsBreak(line)) return [K_BREAK];
  if (line.charCodeAt(0) === 62) return [K_QUOTE];
  const bullet = probeMarker(line, false);
  if (bullet !== null) return [K_LIST, false, 0, bullet[0]];
  const numbered = probeMarker(line, true);
  if (numbered !== null) return [K_LIST, true, numbered[1], numbered[0]];
  return [K_PARA];
}

// JavaScript's \s as a char code — the dialect states its word and
// continuation rules in exactly those terms.
function wsCode(c) {
  return (
    c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
    (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
    c === 8287 || c === 12288 || c === 65279
  );
}

// A list continuation: two or more leading spaces, then a non-space.
function lineContinues(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i < line.length && !wsCode(line.charCodeAt(i));
}

// A content line with edge blanks dropped, for paragraph/list/quote bodies.
function stripLine(line) {
  let start = 0;
  let end = line.length;
  while (start < end && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
  while (end > start && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
  return start === 0 && end === line.length ? line : line.slice(start, end);
}

// Only these kinds cut a paragraph short.
function kindEndsPara(kind) {
  return kind === K_BLANK || kind === K_FENCE || kind === K_HEAD || kind === K_BREAK;
}

// The kind of a line without computing any payload — in particular without
// slicing a heading's text. The paragraph scanner below only ever needs
// the kind, and paragraph lines are the bulk of every document, so this
// cheaper probe is what runs there. Its heading test mirrors probeHeading
// exactly: 1-6 '#', a blank, then at least one non-blank character.
function kindOfLine(line) {
  if (lineIsBlank(line)) return K_BLANK;
  if (fenceTagLen(line) !== -1) return K_FENCE;
  let depth = 0;
  while (depth < line.length && line.charCodeAt(depth) === 35) depth++;
  if (depth >= 1 && depth <= 6) {
    const after = line.charCodeAt(depth);
    if (after === 32 || after === 9) {
      let start = depth;
      while (start < line.length && (line.charCodeAt(start) === 32 || line.charCodeAt(start) === 9)) start++;
      if (start < line.length) return K_HEAD;
    }
  }
  if (lineIsBreak(line)) return K_BREAK;
  if (line.charCodeAt(0) === 62) return K_QUOTE;
  if (probeMarker(line, false) !== null || probeMarker(line, true) !== null) return K_LIST;
  return K_PARA;
}

// ------------------------------------------------------- inline markup
// One regex finds everything that can interrupt a plain run. Nested
// constructs recurse over [lo, hi) ranges of the same string; nothing is
// sliced until a construct is known to match.

const INLINE_RE = /[\\`*\[!<>&"']/g;
const ESCAPABLE_SET = new Set('\\`*_[]()#+-.!>'.split(''));

// Is the character at `at` neutralised by an escape? Count the backslashes
// immediately before it, back to `floor`: an odd run swallows it, an even
// run pairs up into literal backslashes and leaves it live.
function swallowed(s, at, floor) {
  let run = 0;
  let k = at - 1;
  while (k >= floor && s.charCodeAt(k) === 92) {
    run++;
    k--;
  }
  return run % 2 === 1;
}

// First unescaped occurrence of `needle` inside [from, hi), or -1.
function seekUnescaped(s, needle, from, hi) {
  const span = needle.length;
  let j = s.indexOf(needle, from);
  while (j !== -1 && j + span <= hi) {
    if (!swallowed(s, j, from)) return j;
    j = s.indexOf(needle, j + 1);
  }
  return -1;
}

// First lone '*' inside [from, hi): not escaped, and not half of a '**'
// pair. The character sitting at `hi` belongs to an enclosing construct and
// never counts as this star's partner.
function seekLoneStar(s, from, hi) {
  let j = s.indexOf('*', from);
  while (j !== -1 && j < hi) {
    if (swallowed(s, j, from)) {
      j = s.indexOf('*', j + 1);
    } else if (j + 1 < hi && s[j + 1] === '*') {
      j = s.indexOf('*', j + 2);
    } else {
      return j;
    }
  }
  return -1;
}

// Render s[lo, hi) as inline markup, appending fragments to `sink`. A plain
// run is flushed whole — escaped in one escSlice call when the run was seen
// to contain an HTML special, copied untouched otherwise.
function renderSpan(s, lo, hi, env, sink) {
  let segStart = lo;
  let segDirty = false;
  let pos = lo;
  const flush = (upto) => {
    if (upto > segStart) {
      sink.push(segDirty ? escSlice(s, segStart, upto) : s.slice(segStart, upto));
    }
  };
  INLINE_RE.lastIndex = lo;
  let m;
  while ((m = INLINE_RE.exec(s)) !== null) {
    const at = m.index;
    if (at >= hi) break;
    const ch = m[0];
    if (ch === '<' || ch === '>' || ch === '&' || ch === '"' || ch === "'") {
      segDirty = true;
      pos = at + 1;
    } else if (ch === '!') {
      pos = at + 1;
    } else if (ch === '\\') {
      if (at + 1 < hi && ESCAPABLE_SET.has(s[at + 1])) {
        flush(at);
        sink.push(escSlice(s, at + 1, at + 2));
        pos = at + 2;
        segStart = pos;
        segDirty = false;
      } else {
        pos = at + 1;
      }
    } else if (ch === '`') {
      const j = s.indexOf('`', at + 1);
      if (j !== -1 && j < hi && j > at + 1) {
        flush(at);
        sink.push('<code>', escSlice(s, at + 1, j), '</code>');
        pos = j + 1;
        segStart = pos;
        segDirty = false;
      } else {
        pos = at + 1;
      }
    } else if (ch === '*') {
      if (at + 1 < hi && s[at + 1] === '*') {
        const j = seekUnescaped(s, '**', at + 2, hi);
        if (j > at + 2) {
          flush(at);
          sink.push('<strong>');
          renderSpan(s, at + 2, j, env, sink);
          sink.push('</strong>');
          pos = j + 2;
          segStart = pos;
          segDirty = false;
        } else {
          pos = at + 2;
        }
      } else {
        const j = seekLoneStar(s, at + 1, hi);
        if (j > at + 1) {
          flush(at);
          sink.push('<em>');
          renderSpan(s, at + 1, j, env, sink);
          sink.push('</em>');
          pos = j + 1;
          segStart = pos;
          segDirty = false;
        } else {
          pos = at + 1;
        }
      }
    } else {
      // ch === '[': a link only when ](target) follows with a non-empty,
      // whitespace-free target.
      const k = seekUnescaped(s, ']', at + 1, hi);
      let closeParen = -1;
      if (k !== -1 && k + 1 < hi && s[k + 1] === '(') {
        closeParen = s.indexOf(')', k + 2);
        if (closeParen >= hi) closeParen = -1;
      }
      const target = closeParen === -1 ? '' : s.slice(k + 2, closeParen);
      if (target !== '' && !/\s/.test(target)) {
        flush(at);
        sink.push('<a href="', escHtml(env.link(target)), '">');
        renderSpan(s, at + 1, k, env, sink);
        sink.push('</a>');
        pos = closeParen + 1;
        segStart = pos;
        segDirty = false;
      } else {
        pos = at + 1;
      }
    }
    INLINE_RE.lastIndex = pos;
  }
  flush(hi);
}

function renderInlineText(s, env) {
  // With none of the four construct starters present, the sweep above could
  // only ever flush the whole string through the escaper — do just that.
  if (!/[\\`*\[]/.test(s)) return escHtml(s);
  const sink = [];
  renderSpan(s, 0, s.length, env, sink);
  return sink.join('');
}

// Render one body (lines[from..]) in a single classify-and-render walk.
// Returns the HTML (each block followed by a newline), the TOC entries for
// heading levels 2 and 3, and the excerpt (the first paragraph's HTML).
function renderBody(lines, from, env, slugMemo) {
  const seenIds = new Set();
  const chunks = [];
  const toc = [];
  let excerpt = null;
  let i = from;
  while (i < lines.length) {
    const probe = probeLine(lines[i]);
    const kind = probe[0];
    if (kind === K_BLANK) {
      i++;
    } else if (kind === K_FENCE) {
      const lang = lines[i].slice(3, 3 + probe[1]);
      i++;
      let inner = '';
      while (i < lines.length && !fenceCloses(lines[i])) {
        inner += escHtml(lines[i]) + '\n';
        i++;
      }
      i++;
      const attr = lang === '' ? '' : ' class="language-' + escHtml(lang) + '"';
      chunks.push('<pre><code' + attr + '>' + inner + '</code></pre>');
    } else if (kind === K_HEAD) {
      const depth = probe[1];
      const text = probe[2];
      const id = claimSlug(makeSlug(text, slugMemo), seenIds);
      const html = renderInlineText(text, env);
      chunks.push('<h' + depth + ' id="' + id + '">' + html + '</h' + depth + '>');
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html });
      i++;
    } else if (kind === K_BREAK) {
      chunks.push('<hr>');
      i++;
    } else if (kind === K_QUOTE) {
      const quoted = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        let rest = lines[i].slice(1);
        if (rest.charCodeAt(0) === 32) rest = rest.slice(1);
        const t = stripLine(rest);
        if (t !== '') quoted.push(t);
        i++;
      }
      if (quoted.length === 0) chunks.push('<blockquote>\n</blockquote>');
      else chunks.push('<blockquote>\n<p>' + renderInlineText(quoted.join('\n'), env) + '</p>\n</blockquote>');
    } else if (kind === K_LIST) {
      const ordered = probe[1];
      const startNum = probe[2];
      const items = [];
      while (i < lines.length) {
        const p = probeLine(lines[i]);
        if (p[0] === K_LIST && p[1] === ordered) {
          items.push([stripLine(lines[i].slice(p[3]))]);
          i++;
        } else if (items.length > 0 && lineContinues(lines[i])) {
          items[items.length - 1].push(stripLine(lines[i]));
          i++;
        } else {
          break;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      const openTag = ordered && startNum !== 1 ? '<ol start="' + startNum + '">' : '<' + tag + '>';
      let inner = '';
      for (const item of items) {
        inner += '<li>' + renderInlineText(item.join('\n'), env) + '</li>\n';
      }
      chunks.push(openTag + '\n' + inner + '</' + tag + '>');
    } else {
      const paraLines = [stripLine(lines[i])];
      i++;
      while (i < lines.length && !kindEndsPara(kindOfLine(lines[i]))) {
        paraLines.push(stripLine(lines[i]));
        i++;
      }
      const html = renderInlineText(paraLines.join('\n'), env);
      if (excerpt === null) excerpt = html;
      chunks.push('<p>' + html + '</p>');
    }
  }
  let html = '';
  for (const chunk of chunks) html += chunk + '\n';
  return { html, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------ templates
// The dialect: {{ path }} escaped output, {{{ path }}} raw output,
// {% for x in path %}, {% if path %} / {% if not path %} / {% else %},
// {% include "name" %}. A {% %} tag alone on its line removes the whole
// line, newline included. Paths are dot-joined names and resolve through
// the scope stack by own properties only.
//
// A template compiles to a flat instruction list — tuples with a numeric
// opcode and operand slots, control flow expressed as patched jump
// addresses:
//   [OP_TEXT, string]
//   [OP_VAR, pathParts, rawFlag]
//   [OP_IF, pathParts, negFlag, elseAddr, endAddr]
//   [OP_JUMP, addr]
//   [OP_FOR, varName, pathParts, endAddr]
//   [OP_ENDFOR, forAddr]
//   [OP_INCLUDE, templateName]
// Two executors share the list: a closure tree built from it (fast path)
// and a program-counter interpreter (fallback, used automatically whenever
// building the closure tree throws).

const OP_TEXT = 0;
const OP_VAR = 1;
const OP_IF = 2;
const OP_JUMP = 3;
const OP_FOR = 4;
const OP_ENDFOR = 5;
const OP_INCLUDE = 6;
const INCLUDE_DEPTH_MAX = 8;

class TplError extends Error {}

// A dotted path's shape: name(.name)* with names [A-Za-z_][A-Za-z0-9_]*.
function pathShapeOk(text) {
  let i = 0;
  for (;;) {
    const c = text.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95)) return false;
    i++;
    while (i < text.length) {
      const d = text.charCodeAt(i);
      const part = (d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95;
      if (!part) break;
      i++;
    }
    if (i === text.length) return true;
    if (text.charCodeAt(i) !== 46) return false;
    i++;
    if (i === text.length) return false;
  }
}

function checkedParts(name, text) {
  if (!pathShapeOk(text)) {
    throw new TplError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  }
  return text.split('.');
}

// Split a template source into ['text', str] / ['var', parts, rawFlag] /
// ['tag', tagText] tokens, applying the standalone-line rule for {% %}.
function scanTemplate(name, src) {
  const tokens = [];
  let buf = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      buf += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      buf += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    buf += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const closer = raw ? '}}}' : '}}';
      const close = src.indexOf(closer, open + (raw ? 3 : 2));
      if (close === -1) {
        throw new TplError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      }
      if (buf !== '') {
        tokens.push(['text', buf]);
        buf = '';
      }
      const inner = src.slice(open + (raw ? 3 : 2), close).trim();
      tokens.push(['var', checkedParts(name, inner), raw ? 1 : 0]);
      i = close + closer.length;
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) {
      throw new TplError('template "' + name + '": a {% is not closed');
    }
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    let alone = true;
    for (let j = lineStart; alone && j < open; j++) {
      const c = src.charCodeAt(j);
      if (c !== 32 && c !== 9) alone = false;
    }
    for (let j = end; alone && j < lineEnd; j++) {
      const c = src.charCodeAt(j);
      if (c !== 32 && c !== 9) alone = false;
    }
    if (alone) buf = buf.slice(0, buf.length - (open - lineStart));
    if (buf !== '') {
      tokens.push(['text', buf]);
      buf = '';
    }
    tokens.push(['tag', src.slice(open + 2, close).trim()]);
    i = alone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (buf !== '') tokens.push(['text', buf]);
  return tokens;
}

// Compile tokens into the flat instruction list, patching jump addresses as
// blocks close. Throws TplError with the reference's exact messages.
function compileTemplate(name, src) {
  const ops = [];
  const open = []; // frames: { kind, at, elseSeen, jumpAt }
  for (const tok of scanTemplate(name, src)) {
    if (tok[0] === 'text') {
      ops.push([OP_TEXT, tok[1]]);
      continue;
    }
    if (tok[0] === 'var') {
      ops.push([OP_VAR, tok[1], tok[2]]);
      continue;
    }
    const tag = tok[1];
    const top = open[open.length - 1];
    if (tag.startsWith('for ') || tag === 'for') {
      const m = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/.exec(tag);
      if (m !== null) {
        open.push({ kind: 'for', at: ops.length });
        ops.push([OP_FOR, m[1], checkedParts(name, m[2]), -1]);
        continue;
      }
    }
    if (tag.startsWith('if ') || tag === 'if') {
      const m = /^if (not )?(\S+)$/.exec(tag);
      if (m !== null) {
        open.push({ kind: 'if', at: ops.length, elseSeen: false, jumpAt: -1 });
        ops.push([OP_IF, checkedParts(name, m[2]), m[1] === undefined ? 0 : 1, -1, -1]);
        continue;
      }
    }
    if (tag === 'else') {
      if (top === undefined || top.kind !== 'if' || top.elseSeen) {
        throw new TplError('template "' + name + '": an else outside an if');
      }
      top.elseSeen = true;
      top.jumpAt = ops.length;
      ops.push([OP_JUMP, -1]);
      ops[top.at][3] = ops.length; // else branch starts right after the jump
      continue;
    }
    if (tag === 'endfor' || tag === 'endif') {
      const want = tag === 'endfor' ? 'for' : 'if';
      if (top === undefined || top.kind !== want) {
        throw new TplError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
      }
      open.pop();
      if (want === 'for') {
        ops[top.at][3] = ops.length + 1; // first instruction past the ENDFOR
        ops.push([OP_ENDFOR, top.at]);
      } else {
        const endAddr = ops.length;
        ops[top.at][4] = endAddr;
        if (top.elseSeen) ops[top.jumpAt][1] = endAddr;
        else ops[top.at][3] = endAddr;
      }
      continue;
    }
    if (tag.startsWith('include ') || tag === 'include') {
      const m = /^include "([a-z0-9-]+)"$/.exec(tag);
      if (m !== null) {
        ops.push([OP_INCLUDE, m[1]]);
        continue;
      }
    }
    throw new TplError('template "' + name + '": {% ' + tag + ' %} is not a tag');
  }
  if (open.length > 0) {
    throw new TplError('template "' + name + '": a ' + open[open.length - 1].kind + ' is not closed');
  }
  return ops;
}

// Resolve a dotted path against the scope stack (an array of vars objects,
// innermost last): the first segment comes from the nearest scope owning
// it, the rest descend by own properties through objects only.
function resolvePath(stack, parts) {
  let depth = stack.length - 1;
  while (depth >= 0 && !Object.hasOwn(stack[depth], parts[0])) depth--;
  if (depth < 0) return undefined;
  let v = stack[depth][parts[0]];
  for (let k = 1; k < parts.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, parts[k])) return undefined;
    v = v[parts[k]];
  }
  return v;
}

// A value rendered as template text.
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// The fallback executor: a program-counter walk over the flat list, with an
// explicit frame stack for loops. Each frame remembers its FOR instruction,
// its items and its cursor; the loop's vars object sits on the scope stack
// for exactly the frame's lifetime.
function execOps(ops, stack, templates, depth, out) {
  const frames = [];
  let pc = 0;
  while (pc < ops.length) {
    const op = ops[pc];
    switch (op[0]) {
      case OP_TEXT:
        out.push(op[1]);
        pc++;
        break;
      case OP_VAR: {
        const text = textOf(resolvePath(stack, op[1]));
        out.push(op[2] === 1 ? text : escHtml(text));
        pc++;
        break;
      }
      case OP_IF:
        pc = truthy(resolvePath(stack, op[1])) !== (op[2] === 1) ? pc + 1 : op[3];
        break;
      case OP_JUMP:
        pc = op[1];
        break;
      case OP_FOR: {
        const items = resolvePath(stack, op[2]);
        if (!Array.isArray(items) || items.length === 0) {
          pc = op[3];
          break;
        }
        const vars = {};
        stack.push(vars);
        frames.push({ at: pc, items, idx: 0, vars, name: op[1] });
        bindLoopVar(frames[frames.length - 1]);
        pc++;
        break;
      }
      case OP_ENDFOR: {
        const frame = frames[frames.length - 1];
        frame.idx++;
        if (frame.idx < frame.items.length) {
          bindLoopVar(frame);
          pc = frame.at + 1;
        } else {
          frames.pop();
          stack.pop();
          pc++;
        }
        break;
      }
      default: {
        // OP_INCLUDE
        const entry = templates.get(op[1]);
        if (entry !== undefined && depth < INCLUDE_DEPTH_MAX) {
          renderWith(entry, stack, templates, depth + 1, out);
        }
        pc++;
      }
    }
  }
}

function bindLoopVar(frame) {
  frame.vars[frame.name] = frame.items[frame.idx];
  frame.vars.loop = {
    index: frame.idx + 1,
    first: frame.idx === 0,
    last: frame.idx === frame.items.length - 1,
    length: frame.items.length,
  };
}

// Build the closure fast path for ops[lo, hi): one closure per instruction,
// with IF/FOR closures capturing the closures of their sub-ranges. Mirrors
// execOps instruction for instruction.
function buildThunks(ops, lo, hi) {
  const thunks = [];
  let i = lo;
  while (i < hi) {
    const op = ops[i];
    if (op[0] === OP_TEXT) {
      const text = op[1];
      thunks.push((stack, templates, depth, out) => {
        out.push(text);
      });
      i++;
    } else if (op[0] === OP_VAR) {
      const parts = op[1];
      const raw = op[2];
      thunks.push((stack, templates, depth, out) => {
        const text = textOf(resolvePath(stack, parts));
        out.push(raw === 1 ? text : escHtml(text));
      });
      i++;
    } else if (op[0] === OP_IF) {
      const parts = op[1];
      const negated = op[2] === 1;
      const elseAddr = op[3];
      const endAddr = op[4];
      const thenEnd = elseAddr === endAddr ? endAddr : elseAddr - 1; // skip the JUMP
      const thenThunks = buildThunks(ops, i + 1, thenEnd);
      const elseThunks = elseAddr === endAddr ? null : buildThunks(ops, elseAddr, endAddr);
      thunks.push((stack, templates, depth, out) => {
        const branch = truthy(resolvePath(stack, parts)) !== negated ? thenThunks : elseThunks;
        if (branch !== null) {
          for (const t of branch) t(stack, templates, depth, out);
        }
      });
      i = endAddr;
    } else if (op[0] === OP_FOR) {
      const name = op[1];
      const parts = op[2];
      const endAddr = op[3];
      const bodyThunks = buildThunks(ops, i + 1, endAddr - 1);
      thunks.push((stack, templates, depth, out) => {
        const items = resolvePath(stack, parts);
        if (!Array.isArray(items)) return;
        const vars = {};
        stack.push(vars);
        for (let k = 0; k < items.length; k++) {
          vars[name] = items[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === items.length - 1, length: items.length };
          for (const t of bodyThunks) t(stack, templates, depth, out);
        }
        stack.pop();
      });
      i = endAddr;
    } else if (op[0] === OP_INCLUDE) {
      const incName = op[1];
      thunks.push((stack, templates, depth, out) => {
        const entry = templates.get(incName);
        if (entry !== undefined && depth < INCLUDE_DEPTH_MAX) {
          renderWith(entry, stack, templates, depth + 1, out);
        }
      });
      i++;
    } else {
      // OP_JUMP / OP_ENDFOR are consumed structurally by their owners and
      // never appear as standalone thunks in a well-formed range.
      i++;
    }
  }
  return thunks;
}

// A compiled template: the flat list plus its thunk tree, or thunks = null
// when building the tree threw — renders then go through execOps instead.
function prepareTemplate(name, src) {
  const ops = compileTemplate(name, src);
  let thunks = null;
  try {
    thunks = buildThunks(ops, 0, ops.length);
  } catch {
    thunks = null;
  }
  return { ops, thunks };
}

function renderWith(entry, stack, templates, depth, out) {
  if (entry.thunks !== null) {
    for (const t of entry.thunks) t(stack, templates, depth, out);
  } else {
    execOps(entry.ops, stack, templates, depth, out);
  }
}

// -------------------------------------------------------------- the build

const REPORT_NAME = 'build-report.txt';
const ROOT_TAKEN = ['posts', 'tags', 'page'];

function parentDir(path) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

// Walk a link's relative path from a source directory (given as pre-split
// segments): '' and '.' segments vanish, '..' pops — or fails the whole
// resolution when it would climb above the root. The segment array is
// copied, never mutated.
function walkRel(dirSegs, rel) {
  const segs = dirSegs.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length === 0) return null;
      segs.pop();
    } else {
      segs.push(seg);
    }
  }
  return segs.join('/');
}

// Count whitespace-separated words over lines[from..]. The whitespace test
// is inlined in the loop — no per-character function call on this hot path.
function tallyWords(lines, from) {
  let total = 0;
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    let inWord = false;
    for (let j = 0; j < line.length; j++) {
      const c = line.charCodeAt(j);
      const space =
        c === 32 || (c >= 9 && c <= 13) || c === 160 || c === 5760 ||
        (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 ||
        c === 8287 || c === 12288 || c === 65279;
      if (space) inWord = false;
      else if (!inWord) {
        inWord = true;
        total++;
      }
    }
  }
  return total;
}

const ABSOLUTE_LINK_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// Build one site and return its { path: text } output tree.
export function run(input) {
  const slugMemo = new Map();

  // Phase 1 — templates, compiled in name order. A template that fails to
  // compile is reported and treated as absent from here on.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(cmpCU)) {
    try {
      templates.set(name, prepareTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TplError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Phase 2 — split the file list into Markdown sources and static files,
  // in path order. CRLF normalisation is skipped for sources without a CR;
  // each source is split into lines here and never again.
  const ordered = [...input.files].sort((x, y) => cmpCU(x.path, y.path));
  const rawSources = [];
  const statics = [];
  for (const f of ordered) {
    if (f.path.endsWith('.md')) {
      const text = f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n');
      rawSources.push({ path: f.path, lines: text.split('\n') });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // Phase 3 — admission: front matter first, then the generator's own
  // directories, the post-date rule, layout existence, and the draft drop.
  // Each refusal is reported with its reason, in source order.
  const sources = [];
  for (const s of rawSources) {
    const fm = readFrontMatter(s.lines);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.bodyFrom = fm.bodyFrom;
    s.post = s.path.startsWith('posts/');
    let own = null;
    for (const d of ROOT_TAKEN) {
      if (d !== 'posts' && s.path.startsWith(d + '/')) {
        own = d;
        break;
      }
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

  // Phase 4 — permalinks: a slug per source, unique within its output
  // directory; the root directory starts out holding the reserved names.
  const takenByDir = new Map();
  const takenFor = (dir) => {
    let set = takenByDir.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? ROOT_TAKEN : []);
      takenByDir.set(dir, set);
    }
    return set;
  };
  const sourceByPath = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : parentDir(s.path);
    const slug = claimSlug(s.data.slug ?? makeSlug(s.data.title, slugMemo), takenFor(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    sourceByPath.set(s.path, s);
  }

  // Phase 5 — bodies. Links resolve against built pages and static files;
  // a resolution is cached per (directory, relative path) for the whole
  // run, storing the fragment-free href or null — but a broken target is
  // still recorded once per linking source, cache hit or not.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const brokenLinks = new Set();
  const linkMemo = new Map();
  for (const s of sources) {
    const dir = parentDir(s.path);
    const dirSegs = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (ABSOLUTE_LINK_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        if (rel === '') {
          brokenLinks.add('broken-link ' + s.path + ' -> ' + target);
          return target;
        }
        const key = dir + '\n' + rel;
        let href = linkMemo.get(key);
        if (href === undefined) {
          href = null;
          const resolved = walkRel(dirSegs, rel);
          if (resolved !== null) {
            const page = sourceByPath.get(resolved);
            if (page !== undefined) href = page.url;
            else if (staticPaths.has(resolved)) href = base + '/' + resolved;
          }
          linkMemo.set(key, href);
        }
        if (href === null) {
          brokenLinks.add('broken-link ' + s.path + ' -> ' + target);
          return target;
        }
        return href + frag;
      },
    };
    s.words = tallyWords(s.lines, s.bodyFrom);
    const body = renderBody(s.lines, s.bodyFrom, env, slugMemo);
    s.html = body.html;
    s.toc = body.toc;
    s.excerpt = body.excerpt;
  }

  // Phase 6 — collections. Posts run newest first, slug breaking ties, and
  // neighbours are linked in that order.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => cmpCU(y.data.date, x.data.date) || cmpCU(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags group by slug; a tag takes the name it is first met with, in post
  // order, and tags sort by membership count, then slug.
  const tagBySlug = new Map();
  const dedupTagNames = (s) => {
    const seen = new Set();
    const kept = [];
    for (const name of s.data.tags ?? []) {
      const slug = makeSlug(name, slugMemo);
      if (!seen.has(slug)) {
        seen.add(slug);
        kept.push(name);
      }
    }
    return kept;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of dedupTagNames(p)) {
      const slug = makeSlug(name, slugMemo);
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
    s.tagRefs = dedupTagNames(s).map((name) => {
      const slug = makeSlug(name, slugMemo);
      return tagBySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...tagBySlug.values()].sort(
    (x, y) => y.posts.length - x.posts.length || cmpCU(x.slug, y.slug),
  );

  // Phase 7 — the records templates read. A source's link record is built
  // lazily and memoised on the source; its card is built exactly once and
  // kept in the cards map; page records spread the cached card.
  const linkRecord = (s) => {
    if (s === null) return null;
    if (s.linkObj === undefined) {
      s.linkObj = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : spellDate(s.data.date),
      };
    }
    return s.linkObj;
  };
  const buildCard = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : spellDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of sources) cards.set(s, buildCard(s));
  const pageRecord = (s) => ({
    ...cards.get(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkRecord(s.newer ?? null),
    older: linkRecord(s.older ?? null),
    is_post: s.post,
  });

  // Phase 8 — layouts: every page, the paginated index, one page per tag,
  // the tags index, then static files (a built page shadows a static file
  // that wanted its path).
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const output = {};
  const renderNamed = (name, vars) => {
    const entry = templates.get(name);
    if (entry === undefined) return null;
    const out = [];
    renderWith(entry, [{ site, tags: allTags, recent, ...vars }], templates, 0, out);
    return out.join('');
  };
  for (const s of sources) {
    output[s.outDir + '/index.html'] = renderNamed(s.layout, { page: pageRecord(s) });
  }
  const perPage = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / perPage));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pageCount; k++) {
    const html = renderNamed('index', {
      posts: posts.slice((k - 1) * perPage, k * perPage).map((p) => cards.get(p)),
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
    const html = renderNamed('tag', {
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
  const tagsIndex = renderNamed('tags', {});
  if (tagsIndex !== null) output['tags/index.html'] = tagsIndex;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) {
      report.push('shadowed ' + f.path + ': a built page has its path');
    } else {
      output[f.path] = f.content;
    }
  }

  // Phase 9 — the report: refusals, drafts, template failures, broken
  // links and shadowed files, all sorted in code-unit order, with the
  // built counts as the final line.
  const reportLines = [...report, ...brokenLinks].sort(cmpCU);
  let pageTotal = 0;
  for (const s of sources) if (!s.post) pageTotal++;
  reportLines.push(
    'built ' + pageTotal + ' pages, ' + posts.length + ' posts, ' + tags.length +
    ' tags and ' + statics.length + ' static files',
  );
  output[REPORT_NAME] = reportLines.join('\n') + '\n';
  return output;
}
