"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const html = fs.readFileSync(path.join(__dirname, "..", "sidepanel.html"), "utf8");

// Check nesting as well as presence: browser error recovery can hide missing containers.
function readElements() {
  const stack = [];
  const elements = [];
  const voidTags = new Set(["meta", "link", "input", "br", "hr", "img"]);
  for (const match of html.matchAll(/<!--[^]*?-->|<![^>]*>|<\/?([a-z][\w-]*)\b[^>]*>/gi)) {
    if (!match[1]) continue;
    const tag = match[1].toLowerCase();
    if (match[0].startsWith("</")) {
      assert.equal(stack.pop()?.tag, tag, `unbalanced closing tag ${tag}`);
      continue;
    }
    const element = { tag, attributes: match[0], parent: stack.at(-1) };
    elements.push(element);
    if (!voidTags.has(tag) && !match[0].endsWith("/>")) stack.push(element);
  }
  assert.equal(stack.length, 0, "all containers must close");
  return elements;
}
const hasClass = (element, name) => Boolean(element && (element.attributes.match(/class="([^"]*)"/)?.[1] || "").split(/\s+/).includes(name));

test("sidepanel toolbar and both complete panes retain their containers", () => {
  const elements = readElements();
  const toolbar = elements.find(el => hasClass(el, "fz-toolbar"));
  const layouts = elements.find(el => hasClass(el, "fz-layout-switch"));
  assert.equal(layouts?.parent, toolbar);
  const panes = elements.filter(el => hasClass(el, "fz-pane"));
  assert.equal(panes.length, 2);
  for (const [index, pane] of panes.entries()) {
    assert.match(pane.attributes, new RegExp(`data-pane="${index}"`));
    assert.ok(hasClass(pane.parent, "fz-panes"));
    const children = elements.filter(el => el.parent === pane);
    for (const name of ["fz-pane-head", "fz-cell-meta", "fz-search-panel", "fz-content"]) {
      assert.equal(children.filter(el => hasClass(el, name)).length, 1, `pane ${index}: ${name}`);
    }
    assert.ok(elements.some(el => el.attributes.includes(`id="mode-menu-${index}"`)));
  }
});
