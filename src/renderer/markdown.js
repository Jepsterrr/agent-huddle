// Just enough Markdown for the step list: agents answer in Markdown, and
// "**bold**" with the stars showing reads badly. Returns plain segments that
// the renderer turns into elements with textContent: no HTML is ever parsed,
// so nothing in a message can inject markup.
//
//   parse(text) -> [{ s, b?, i?, code?, h? }]
//
// A segment can carry several marks (bold code: **`Always`**). Newlines stay
// in the text (the step list uses pre-wrap). Headings, lists, quotes, tables
// and code fences are flattened to readable lines. `__x__` and `_x_` are left
// alone on purpose: in agent text they are far more often names (__init__,
// snake_case) than emphasis.

(function (root) {
  'use strict';

  const ESCAPABLE = '\\`*_[]()#|>~-';
  const isSpace = (c) => c === undefined || /\s/.test(c);
  const isWord = (c) => c !== undefined && /[\p{L}\p{N}_]/u.test(c);
  const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)/;

  // Where `delim` closes, from `from` on: skips `code spans` and escapes, so
  // **`**text**`** closes at the last pair, not inside the code.
  function findClose(text, from, delim, misses) {
    if (misses[delim] != null && from >= misses[delim]) return -1;
    for (let k = from; k < text.length; k++) {
      const c = text[k];
      if (c === '\\') {
        k++;
        continue;
      }
      if (c === '`') {
        const j = text.indexOf('`', k + 1);
        if (j > 0) {
          k = j;
          continue;
        }
      }
      if (!text.startsWith(delim, k) || k === from || isSpace(text[k - 1])) continue;
      if (delim === '*' && (text[k + 1] === '*' || isWord(text[k + 1]))) continue;
      return k;
    }
    misses[delim] = from; // no close after here: later tries can stop at once
    return -1;
  }

  // Inline marks for one line. A small hand-written reader rather than one
  // regex, because a regex cannot tell that ** inside `code` does not close bold.
  function inline(text, marks, out, misses = {}) {
    let buf = '';
    const flush = () => {
      if (buf) out.push({ ...marks, s: buf });
      buf = '';
    };
    for (let i = 0; i < text.length; ) {
      const c = text[i];
      if (c === '\\' && ESCAPABLE.includes(text[i + 1] || '\0')) {
        buf += text[i + 1];
        i += 2;
        continue;
      }
      if (c === '`') {
        const j = text.indexOf('`', i + 1);
        if (j > i + 1) {
          flush();
          out.push({ ...marks, code: true, s: text.slice(i + 1, j) });
          i = j + 1;
          continue;
        }
      }
      if (text.startsWith('**', i) && !isSpace(text[i + 2])) {
        const k = findClose(text, i + 2, '**', misses);
        if (k > 0) {
          flush();
          inline(text.slice(i + 2, k), { ...marks, b: true }, out);
          i = k + 2;
          continue;
        }
      }
      if (c === '[') {
        const m = LINK.exec(text.slice(i, i + 2000));
        if (m) {
          flush();
          inline(m[1], marks, out); // a link shows its words, not the address
          i += m[0].length;
          continue;
        }
      }
      if (c === '*' && text[i + 1] !== '*' && !isSpace(text[i + 1]) && !isWord(text[i - 1]) && text[i - 1] !== '*') {
        const k = findClose(text, i + 1, '*', misses);
        if (k > 0) {
          flush();
          inline(text.slice(i + 1, k), { ...marks, i: true }, out);
          i = k + 1;
          continue;
        }
      }
      buf += c;
      i++;
    }
    flush();
  }

  function parse(text) {
    const out = [];
    const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
    let fence = false;
    let first = true;
    const nl = () => {
      if (!first) out.push({ s: '\n' });
      first = false;
    };
    for (const raw of lines) {
      if (/^\s*(```|~~~)/.test(raw)) {
        fence = !fence;
        continue;
      }
      if (fence) {
        nl();
        out.push({ code: true, s: raw });
        continue;
      }
      if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(raw) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue; // table rule, hr
      nl();
      let line = raw;
      const h = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        inline(h[1], { h: true }, out);
        continue;
      }
      line = line.replace(/^\s*>\s?/, ''); // quote
      line = line.replace(/^(\s*)[-*+]\s+(\[[ xX]\]\s+)?/, (_, ind, box) => `${ind}${box ? (/x/i.test(box) ? '☑ ' : '☐ ') : '• '}`);
      if (/^\s*\|.*\|\s*$/.test(line)) {
        // Split on pipes that are not inside `code`.
        const cells = [];
        let cell = '';
        let inCode = false;
        for (const ch of line.trim().slice(1, -1)) {
          if (ch === '`') inCode = !inCode;
          if (ch === '|' && !inCode) {
            cells.push(cell.trim());
            cell = '';
          } else cell += ch;
        }
        cells.push(cell.trim());
        line = cells.join('  ·  ');
      }
      inline(line, {}, out);
    }
    // Merge neighbours that carry the same marks.
    const key = (x) => `${!!x.b}${!!x.i}${!!x.code}${!!x.h}`;
    const merged = [];
    for (const seg of out) {
      const prev = merged[merged.length - 1];
      if (prev && key(prev) === key(seg)) prev.s += seg.s;
      else merged.push({ ...seg });
    }
    return merged;
  }

  const api = { parse };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HuddleMarkdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
