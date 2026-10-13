"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "sidepanel.js"), "utf8");
const context = vm.createContext({
  escapeHtml: text => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  renderContent: (text, mode) => `<result mode="${mode}">${String(text)}</result>`
});
for (const name of ["isFormulaPane", "getPaneResultText", "highlightFormulaSource", "getFormulaBracketMatch", "renderFormulaTypeEditor", "renderFormulaContent"]) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf("\n  }", start) + 4;
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
}

test("unavailable and confirmed empty formula results have different displays", () => {
  const pane = { text: '=IF(TRUE,"",1)', mode: "auto" };
  assert.doesNotMatch(context.renderFormulaContent(pane), /计算结果为空|重试|暂未/);
  pane.formulaResult = { status: "ready", text: "" };
  assert.match(context.renderFormulaContent(pane), /class="fz-formula-empty"/);
  assert.equal(context.getPaneResultText(pane), "");
  pane.formulaResult.text = "计算结果为空";
  assert.doesNotMatch(context.renderFormulaContent(pane), /class="fz-formula-empty"/);
  assert.match(context.renderFormulaContent(pane), /<result mode="auto">计算结果为空<\/result>/);
});

test("copy uses formatted results and preserves zero and formula errors", () => {
  const pane = { text: "=A1", mode: "raw" };
  for (const text of ["0", "25%", "2026/10/12", "#N/A", "#DIV/0!", "a\nb"]) {
    pane.formulaResult = { status: "ready", text };
    assert.equal(context.getPaneResultText(pane), text);
  }
  pane.formulaResult = { status: "unavailable" };
  assert.equal(context.getPaneResultText(pane), "");
  assert.equal(context.getPaneResultText({ text: "普通内容" }), "普通内容");
});

test("formula source stays escaped and has an independent copy action", () => {
  const html = context.renderFormulaContent({ text: '="<script>"', mode: "json" });
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-action="copy-formula"/);
});

const readerSource = fs.readFileSync(path.join(__dirname, "..", "formula-reader.js"), "utf8");
function nativeReaderFixture(options = {}) {
  const coord = { row: 150, col: 4 };
  const attrs = {};
  const sheet = {
    options: { showFormulaText: Boolean(options.showFormulaText) },
    getActiveRowIndex: () => coord.row,
    getActiveColumnIndex: () => coord.col,
    getFormula: () => options.formula ?? 'XLOOKUP(A151,A:A,F:F)',
    getText: () => {
      if (options.onRead) options.onRead(coord);
      return options.text ?? '';
    },
    getTextWithValues: () => options.text ?? '',
    getTextByTextWithValues: value => value
  };
  const spread = { getActiveSheet: () => sheet, getSheetFromId: id => id === 'test' ? sheet : null };
  const node = {
    getBoundingClientRect: () => ({ width: 100 }),
    __reactFiber$test: { memoizedProps: { spread, coord }, return: null }
  };
  const fixture = vm.createContext({
    URL, location: { href: 'https://example.larkoffice.com/sheets/token?sheet=test' }, window: {},
    document: { documentElement: { setAttribute: (key, value) => attrs[key] = value }, querySelectorAll: () => [node] }
  });
  vm.runInContext(readerSource, fixture);
  return { read: fixture.window.__cellPeekReadFormulaResult, coord, attrs };
}

test('native reader returns complete formatted results, including true blanks', () => {
  for (const text of ['', '0', '25%', '#N/A', '2026/10/13', '完整长文本\n'.repeat(3000)]) {
    const { read, attrs } = nativeReaderFixture({ text });
    const result = read('E151', '=XLOOKUP(A151,A:A,F:F)');
    assert.equal(result.status, 'ready');
    assert.equal(result.text, text);
    assert.equal(JSON.parse(attrs['data-cellpeek-formula-status']).length, text.length);
    assert.equal(JSON.parse(attrs['data-cellpeek-formula-status']).text, undefined);
  }
});

test('native reader rejects a different selection or formula instead of returning a false blank', () => {
  const { read } = nativeReaderFixture();
  assert.equal(read('E152', '=XLOOKUP(A151,A:A,F:F)').status, 'unavailable');
  assert.equal(read('E151', '=SUM(A:A)').status, 'unavailable');
  assert.equal(read('invalid', '=SUM(A:A)').status, 'unavailable');
});

test('a missing address label does not block the verified native selection result', () => {
  const { read } = nativeReaderFixture({ text: '25%' });
  assert.equal(read('', '=XLOOKUP(A151,A:A,F:F)').text, '25%');
});

test('native reader discards results if the selection changes during the read', () => {
  const { read } = nativeReaderFixture({ text: 'previous cell', onRead: coord => coord.row++ });
  assert.equal(read('E151', '=XLOOKUP(A151,A:A,F:F)').status, 'unavailable');
});

test('Show Formulas mode still reads the evaluated display value', () => {
  const { read } = nativeReaderFixture({ text: '25%', showFormulaText: true });
  assert.equal(read('E151', '=XLOOKUP(A151,A:A,F:F)').text, '25%');
});

test('formula highlighting preserves source and escapes HTML', () => {
  const input = '=IF(A1="<script>(""text"")",SUM($B$2,3),\'Sheet \'\'One\'\'\'!F:F)';
  const html = context.highlightFormulaSource(input);
  const restored = html.replace(/<\/?span\b[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  assert.equal(restored, input);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /fz-formula-string/);
  assert.match(html, /fz-formula-function">SUM/);
});

test('repeated references share colors and nested parentheses pair by depth', () => {
  const html = context.highlightFormulaSource('=SUM(A1,IF(A1>0,B2,0))');
  assert.equal((html.match(/fz-formula-ref-0">A1</g) || []).length, 2);
  assert.equal((html.match(/fz-formula-bracket-0/g) || []).length, 2);
  assert.equal((html.match(/fz-formula-bracket-1/g) || []).length, 2);
  assert.match(html, /fz-formula-ref-1">B2/);
});

test('numeric function names and quoted sheet ranges are distinct tokens', () => {
  const html = context.highlightFormulaSource('=LOG10(100)+XLOOKUP($A151,\'题目信息\'!$A:$A,\'题目信息\'!F:F)');
  assert.match(html, /fz-formula-function">LOG10/);
  assert.match(html, /fz-formula-ref-1">'题目信息'!\$A:\$A/);
  assert.match(html, /fz-formula-ref-2">'题目信息'!F:F/);
});


test('caret highlights the matching nested pair on either side of a bracket', () => {
  const text = '=SUM(A1,IF(B1>0,2,3))';
  const opening = text.indexOf('(', text.indexOf('IF'));
  const closing = text.length - 2;
  const pair = context.getFormulaBracketMatch(text, opening + 1);
  assert.equal(pair.active, opening);
  assert.equal(pair.partner, closing);
  assert.equal(context.getFormulaBracketMatch(text, closing + 1).partner, opening);
  assert.equal((context.highlightFormulaSource(text, pair).match(/fz-formula-bracket-match/g) || []).length, 2);
});

test('brackets inside strings and quoted sheet names do not participate', () => {
  const text = "=IF(A1=\"(\"\"x\"\")\",'Sheet (one)'!A1,0)";
  const quoted = text.indexOf('(', text.indexOf('"'));
  assert.equal(context.getFormulaBracketMatch(text, quoted + 1), null);
  assert.equal(context.getFormulaBracketMatch(text, text.indexOf('(one)') + 1), null);
  assert.equal(context.getFormulaBracketMatch(text, text.length).partner, text.indexOf('('));
});

test('unmatched brackets warn without blocking edits, and selections have no active pair', () => {
  const pair = context.getFormulaBracketMatch('=SUM(A1', 5);
  assert.equal(pair.partner, -1);
  assert.match(context.highlightFormulaSource('=SUM(A1', pair), /fz-formula-bracket-unmatched/);
  assert.equal(context.getFormulaBracketMatch('=SUM(A1)', 4, 8), null);
});

test('formula editor retains a native textarea and an inaccessible display mirror', () => {
  const html = context.renderFormulaTypeEditor({ draft: '=SUM(A1)' });
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /textarea[^>]+aria-label="编辑公式源码"/);
  assert.match(html, /fz-formula-function/);
});
