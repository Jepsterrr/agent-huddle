const test = require('node:test');
const assert = require('node:assert/strict');
const { parse } = require('../src/renderer/markdown');

// Marks as tags, so the expected strings are easy to read.
const show = (segs) =>
  segs
    .map((x) => {
      let s = x.code ? `<c>${x.s}</c>` : x.s;
      if (x.i) s = `<i>${s}</i>`;
      if (x.b) s = `<b>${s}</b>`;
      if (x.h) s = `<h>${s}</h>`;
      return s;
    })
    .join('');

test('basics: bold, italic, code, links', () => {
  assert.equal(show(parse('Kör `npm test` och *sedan* [README](https://x.y)')), 'Kör <c>npm test</c> och <i>sedan</i> README');
  assert.equal(show(parse('a * b * c and 2*3*4')), 'a * b * c and 2*3*4');
  assert.equal(show(parse('__init__ and snake_case_name')), '__init__ and snake_case_name'); // names, not emphasis
  assert.equal(show(parse('\\*not italic\\* and a\\_b')), '*not italic* and a_b');
});

// ---- verbatim from Claude's own answers in the session that built this ----

test('table with code, parentheses, emoji and arrows', () => {
  const answer = [
    '| Steg | Resultat |',
    '|---|---|',
    '| A. Egen text via `Other…` | ✅ ("Hej" kom fram) |',
    '| B. `Always` | ✅ Regeln hamnade i projektets `.claude/settings.local.json` och gällde exakt det kommandot. Jag har tagit bort den igen. |',
    '| D. Fråga från subagent | ❌ → rättat, se nedan |',
  ].join('\n');
  assert.equal(
    show(parse(answer)),
    [
      'Steg  ·  Resultat',
      'A. Egen text via <c>Other…</c>  ·  ✅ ("Hej" kom fram)',
      'B. <c>Always</c>  ·  ✅ Regeln hamnade i projektets <c>.claude/settings.local.json</c> och gällde exakt det kommandot. Jag har tagit bort den igen.',
      'D. Fråga från subagent  ·  ❌ → rättat, se nedan',
    ].join('\n')
  );
});

test('bold lead-ins with code, quotes and italics inside', () => {
  const answer =
    '**`<task-notification>…`:** Claude Code skickar in "bakgrundsagenten är klar" i samtalet som om du hade skrivit det. ' +
    'Nu blir det en grå rad: *Background task: Agent "Run one test command" finished*.';
  assert.equal(
    show(parse(answer)),
    '<b><c><task-notification>…</c></b><b>:</b> Claude Code skickar in "bakgrundsagenten är klar" i samtalet som om du hade skrivit det. ' +
      'Nu blir det en grå rad: <i>Background task: Agent "Run one test command" finished</i>.'
  );
  assert.equal(show(parse('**`**text**` med synliga stjärnor:**')), '<b><c>**text**</c></b><b> med synliga stjärnor:</b>');
  assert.equal(
    show(parse('**Steg B: `Always`.** Jag kör ett ofarligt `node`-kommando.')),
    '<b>Steg B: </b><b><c>Always</c></b><b>.</b> Jag kör ett ofarligt <c>node</c>-kommando.'
  );
});

test('nested lists, numbered lists and headings', () => {
  const answer = [
    '## Resultat',
    '1. **Kör fas 1 i riktigt arbete en dag eller två.** Tre saker:',
    '   - att en fråga syns i VS Code och i rutan samtidigt (buggfixen)',
    '   - att kvotstapeln får data',
    '- [x] klart',
    '> citat med `kod`',
  ].join('\n');
  assert.equal(
    show(parse(answer)),
    [
      '<h>Resultat</h>',
      '1. <b>Kör fas 1 i riktigt arbete en dag eller två.</b> Tre saker:',
      '   • att en fråga syns i VS Code och i rutan samtidigt (buggfixen)',
      '   • att kvotstapeln får data',
      '☑ klart',
      'citat med <c>kod</c>',
    ].join('\n')
  );
});

test('code blocks keep their content as code, pipes in code do not split table cells', () => {
  assert.equal(show(parse('före\n```js\nconst a = 1;\n```\nefter')), 'före\n<c>const a = 1;</c>\nefter');
  assert.equal(show(parse('| Kommando | Risk |\n|---|---|\n| `ls | head` | low |')), 'Kommando  ·  Risk\n<c>ls | head</c>  ·  low');
  assert.equal(show(parse('a\n---\nb')), 'a\nb');
});

test('nothing is ever turned into HTML, and odd input is safe', () => {
  const segs = parse('<img src=x onerror=alert(1)> **<b>x</b>**');
  assert.ok(segs.every((s) => typeof s.s === 'string'));
  assert.equal(show(segs), '<img src=x onerror=alert(1)> <b><b>x</b></b>'); // only ever text nodes in the DOM
  assert.deepEqual(parse(''), []);
  assert.deepEqual(parse(undefined), []);
  // A message clipped in the middle of a bold run just shows the stars.
  assert.equal(show(parse('Klart. **Alla 53 tes…')), 'Klart. **Alla 53 tes…');
  const t = Date.now();
  parse('**'.repeat(20000) + '`'.repeat(20000) + '*a'.repeat(20000));
  assert.ok(Date.now() - t < 1000, 'slow on pathological input');
});
