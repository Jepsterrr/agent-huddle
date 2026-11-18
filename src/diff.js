// A compact line diff for permission cards. No Electron, no dependencies.

const fs = require('fs');
const { secretKind } = require('./risk');

const MAX_CELLS = 2_000_000; // LCS table size limit; beyond it, show "all removed / all added"
const MAX_LINES = 400; // lines kept for the "show all" view
const CONTEXT = 2;
const MAX_FILE = 512 * 1024;

const split = (s) => (s === '' || s == null ? [] : String(s).replace(/\r\n/g, '\n').split('\n'));

// [{ t: ' ' | '-' | '+', s }]
function lineDiff(a, b) {
  const A = split(a);
  const Bl = split(b);
  let start = 0;
  while (start < A.length && start < Bl.length && A[start] === Bl[start]) start++;
  let endA = A.length;
  let endB = Bl.length;
  while (endA > start && endB > start && A[endA - 1] === Bl[endB - 1]) endA--, endB--;

  const out = A.slice(0, start).map((s) => ({ t: ' ', s }));
  const x = A.slice(start, endA);
  const y = Bl.slice(start, endB);
  const n = x.length;
  const m = y.length;

  if (n * m > MAX_CELLS) {
    for (const s of x) out.push({ t: '-', s });
    for (const s of y) out.push({ t: '+', s });
  } else if (n || m) {
    // lcs[i][j] = length of the LCS of x[i..] and y[j..]
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) out.push({ t: ' ', s: x[i++] }), j++;
      // On a tie, removals go first, the way diffs are usually read.
      else if (i < n && (j === m || lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) out.push({ t: '-', s: x[i++] });
      else out.push({ t: '+', s: y[j++] });
    }
  }
  for (const s of A.slice(endA)) out.push({ t: ' ', s });
  return out;
}

// Keep changes plus a little context; long unchanged runs become one '…' line.
function compact(ops, context = CONTEXT) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.t === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = true;
  });
  const out = [];
  let gap = false;
  ops.forEach((o, i) => {
    if (keep[i]) {
      if (gap && out.length) out.push({ t: '…', s: '' });
      gap = false;
      out.push(o);
    } else gap = true;
  });
  return out;
}

function summarise(ops, extra = {}) {
  const added = ops.filter((o) => o.t === '+').length;
  const removed = ops.filter((o) => o.t === '-').length;
  const lines = compact(ops);
  return {
    lines: lines.slice(0, MAX_LINES),
    total: lines.length,
    truncated: lines.length > MAX_LINES,
    added,
    removed,
    ...extra,
  };
}

// What a file edit would change, or null for tools that do not edit files.
// readFile(path) -> string | null is only used for Write, to diff against the
// file on disk; it is never called for secret files.
function diffForTool(tool, input, readFile) {
  input = input && typeof input === 'object' ? input : {};
  const file = input.file_path;
  if (!file || !['Edit', 'Write', 'MultiEdit'].includes(tool)) return null;
  const clipLine = (o) => ({ t: o.t, s: o.s.length > 400 ? o.s.slice(0, 399) + '…' : o.s });

  if (secretKind(file)) {
    const n = tool === 'Write' ? split(input.content).length : null;
    return { hidden: true, note: n == null ? 'Contents not shown: secret file' : `Contents not shown: secret file (${n} lines)`, lines: [], total: 0, added: 0, removed: 0 };
  }

  if (tool === 'Edit') {
    const ops = lineDiff(input.old_string, input.new_string).map(clipLine);
    return summarise(ops, input.replace_all ? { note: 'Every occurrence in the file' } : {});
  }

  if (tool === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const ops = [];
    edits.forEach((e, i) => {
      if (i) ops.push({ t: '…', s: '' });
      ops.push(...lineDiff(e?.old_string, e?.new_string).map(clipLine));
    });
    return summarise(ops); // the '…' separators count as changes, so they are kept
  }

  // Write. readFile returns the text, null when the file does not exist, or
  // undefined when it exists but should not be compared (too big, binary, unreadable).
  let before;
  try {
    before = readFile ? readFile(file) : undefined;
  } catch {
    before = undefined;
  }
  if (typeof before === 'string' && (before.length > MAX_FILE || before.includes('\0'))) before = undefined;
  const lines = split(input.content).length;
  if (before === null) return summarise(lineDiff('', input.content).map(clipLine), { note: `New file, ${lines} lines` });
  if (before === undefined) {
    return summarise(lineDiff('', input.content).map(clipLine), { note: `Replaces the whole file (${lines} lines); old version not compared` });
  }
  return summarise(lineDiff(before, input.content).map(clipLine));
}

// The file on disk that a Write would replace, for its diff: its text, null
// when it does not exist yet, undefined when it is not shown (too big, not a
// file, unreadable, or a secret). The secret check on the name is not enough
// for a link: a harmless-looking file, or one in a junctioned folder, can point
// at a secret one, so the link's target is checked too.
function readForDiff(file) {
  let real;
  let st;
  try {
    real = fs.realpathSync(file);
    st = fs.statSync(real);
  } catch (err) {
    return err.code === 'ENOENT' ? null : undefined;
  }
  if (secretKind(real) || !st.isFile() || st.size > MAX_FILE) return undefined;
  try {
    return fs.readFileSync(real, 'utf8');
  } catch {
    return undefined;
  }
}

module.exports = { lineDiff, compact, diffForTool, readForDiff, MAX_FILE };
