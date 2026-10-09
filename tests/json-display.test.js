"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "..", "sidepanel.js"), "utf8");
const context = vm.createContext({});
for (const name of ["renderJsonNodeValue", "serializeJsonMember"]) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf("\n  }", start) + 4;
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
}

test("embedded JSON renders without synthetic labels or counts", () => {
  const node = { kind: "embedded", inner: { kind: "array", children: Array(268) } };
  assert.equal(context.renderJsonNodeValue(node, true), '<span class="fz-json-embedded-value"></span>');
  assert.equal(context.renderJsonNodeValue(node, false), '<span class="fz-json-embedded-value">…</span>');
});

test("copying embedded JSON preserves its original string type and escapes", () => {
  const value = '[\n {"role":"user","content":"你好"}\n]';
  const copied = context.serializeJsonMember({ kind: "embedded", parentKind: "object", key: "content", value });
  const parsed = JSON.parse(`{${copied}}`);
  assert.equal(typeof parsed.content, "string");
  assert.equal(parsed.content, value);
});
