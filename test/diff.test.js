const test = require('node:test');
const assert = require('node:assert/strict');
const { lineDiff, compact, diffForTool } = require('../src/diff');

const render = (lines) => lines.map((l) => `${l.t}${l.s}`).join('\n');

test('lineDiff finds the changed lines', () => {
  assert.equal(render(lineDiff('a\nb\nc', 'a\nB\nc')), ' a\n-b\n+B\n c');
  assert.equal(render(lineDiff('', 'x\ny')), '+x\n+y');
  assert.equal(render(lineDiff('x\r\ny', 'x\ny')), ' x\n y'); // CRLF is not a change
  assert.equal(render(lineDiff('a\nb', 'b\nc')), '-a\n b\n+c');
});

test('compact keeps two lines of context and folds the rest', () => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 15', 'changed');
  const lines = compact(lineDiff(before, after));
  assert.equal(render(lines), ' line 13\n line 14\n-line 15\n+changed\n line 16\n line 17');
  const two = compact(lineDiff(before, after.replace('line 2\n', 'two\n')));
  assert.ok(two.some((l) => l.t === '…'));
});

test('large inputs fall back to removed-then-added without hanging', () => {
  const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n');
  const ops = lineDiff(a, b);
  assert.equal(ops.filter((o) => o.t === '-').length, 3000);
  assert.equal(ops.filter((o) => o.t === '+').length, 3000);
});

test('Edit, MultiEdit and Write diffs', () => {
  const e = diffForTool('Edit', { file_path: 'C:\\p\\a.js', old_string: 'x = 1', new_string: 'x = 2', replace_all: true });
  assert.equal(render(e.lines), '-x = 1\n+x = 2');
  assert.equal(e.added, 1);
  assert.equal(e.removed, 1);
  assert.match(e.note, /Every occurrence/);

  const m = diffForTool('MultiEdit', { file_path: 'C:\\p\\a.js', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] });
  assert.equal(render(m.lines), '-a\n+b\n…\n-c\n+d');

  const fresh = diffForTool('Write', { file_path: 'C:\\p\\new.js', content: 'one\ntwo' }, () => null);
  assert.equal(fresh.note, 'New file, 2 lines');
  assert.equal(fresh.added, 2);

  const existing = diffForTool('Write', { file_path: 'C:\\p\\a.js', content: 'one\nTWO\nthree' }, () => 'one\ntwo\nthree');
  assert.equal(render(existing.lines), ' one\n-two\n+TWO\n three');

  const big = diffForTool('Write', { file_path: 'C:\\p\\a.js', content: 'x' }, () => undefined);
  assert.match(big.note, /not compared/);
  const binary = diffForTool('Write', { file_path: 'C:\\p\\a.bin', content: 'x' }, () => 'a\0b');
  assert.match(binary.note, /not compared/);

  assert.equal(diffForTool('Bash', { command: 'ls' }), null);
});

test('secret files never show their contents, and are never read', () => {
  let read = false;
  const d = diffForTool('Write', { file_path: 'C:\\p\\.env', content: 'TOKEN=abc\nB=2' }, () => {
    read = true;
    return 'TOKEN=old';
  });
  assert.equal(read, false);
  assert.equal(d.hidden, true);
  assert.equal(d.lines.length, 0);
  assert.ok(!JSON.stringify(d).includes('abc'));
  const e = diffForTool('Edit', { file_path: 'C:\\Users\\me\\.ssh\\config', old_string: 'a', new_string: 'b' });
  assert.equal(e.hidden, true);
});
