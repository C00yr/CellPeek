"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
const sidepanel = fs.readFileSync(path.join(root, "sidepanel.js"), "utf8");

function count(source, token) {
  return source.split(token).length - 1;
}

test("business address decisions share the native name-box discovery chain", () => {
  assert.match(
    content,
    /function readVisibleCellAddressEvidence\([^)]*\)\s*{\s*return readVisibleCellAddressEvidenceDetailed\(context\)\.address;\s*}/
  );
  assert.match(
    content,
    /function readVisibleCellAddressEvidenceDetailed\([^)]*\)[\s\S]*?readExactFeishuFormulaAddress\(\)[\s\S]*?findCellAddressControl\(\)[\s\S]*?findCellAddressDisplay\(\)/
  );
  assert.match(
    content,
    /function resolveCellAddress\([^)]*\)\s*{\s*return readVisibleCellAddressEvidence\(context\);\s*}/
  );
  assert.match(content, /function findCellAddressDisplay\([^)]*\)[\s\S]*?FEISHU_NAME_BOX_SELECTOR/);
  assert.equal(
    count(content, "findCellAddressFromVisibleUi("),
    1,
    "the broad scanner may remain defined for diagnostics but must have no callers"
  );
  assert.equal(
    count(content, "buildNearbyCellAddresses("),
    1,
    "nearby-cell guessing must remain disconnected from writeback decisions"
  );
});

test("post-write success is based on persisted content, not selection address", () => {
  const start = content.indexOf("const writePersisted = Boolean(");
  const end = content.indexOf("pushWriteAttempt", start);
  assert.ok(start >= 0 && end > start);
  const successRule = content.slice(start, end);
  assert.match(successRule, /verification\.ok/);
  assert.match(successRule, /verification\.text/);
  assert.doesNotMatch(successRule, /selectionVerified/);
  assert.doesNotMatch(content, /selected_address_changed_after_write/);
});

test("only changed content enters relocation", () => {
  assert.equal(count(sidepanel, 'relocationStatus = "waiting"'), 1);
  assert.match(
    sidepanel,
    /if \(reason === "CONTENT_CHANGED"\)[\s\S]*?relocationStatus = "waiting"/
  );
  assert.doesNotMatch(sidepanel, /TARGET_MISMATCH|WRITE_CONFLICT/);
  assert.doesNotMatch(content, /TARGET_MISMATCH|WRITE_CONFLICT/);
  assert.match(content, /if \(!original\.ok\)[\s\S]*?reason: "TARGET_SELECTION_UNVERIFIED"/);
});

test("relocation keeps the reason above and updates the candidate below", () => {
  assert.match(
    sidepanel,
    /\["waiting", "confirming"\]\.includes\(pane\.relocationStatus\)[\s\S]*?单元格内容已发生变化，请在来源工作表中重新点击写入单元格/
  );
  assert.match(
    sidepanel,
    /是否确认写回到 <strong[^>]*>\$\{escapeHtml\(pane\.relocationCandidate\.address \|\| "该单元格"\)}/
  );
  assert.match(
    sidepanel,
    /function setRelocationCandidate[\s\S]*?pane\.relocationCandidate = target;[\s\S]*?pane\.relocationStatus = "confirming"/
  );
});

test("confirming a relocation writes the selected candidate without a second content prompt", () => {
  assert.match(sidepanel, /completeTypingMode\(paneIndex, { relocationConfirmed: true }\)/);
  assert.match(content, /!originalTextMatches && !\(message && message\.relocationConfirmed\)/);
  assert.doesNotMatch(sidepanel, /writeConflictPending|confirm-write-conflict|cancel-write-conflict/);
});

test("invalid JSON remains writable as the current draft", () => {
  assert.match(sidepanel, /if \(jsonDraft\.ok\) pane\.draft = jsonDraft\.formatted;/);
  assert.doesNotMatch(sidepanel, /JSON 无效，请修正后再完成/);
  assert.doesNotMatch(sidepanel, /pane\.writing \|\| !validation\.ok/);
  assert.doesNotMatch(sidepanel, /jsonBlocked/);
});

test("generic write failures keep the draft and use the agreed fallback copy", () => {
  assert.match(sidepanel, /showToast\("写入失败"\)/);
  assert.doesNotMatch(sidepanel, /showToast\(`写入失败：\$\{reason}/);
  const handlerStart = sidepanel.indexOf("function handleWriteResponse(");
  const failureStart = sidepanel.indexOf("if (!response || !response.ok)", handlerStart);
  const successStart = sidepanel.indexOf("pane.text = pane.draft", failureStart);
  assert.ok(failureStart >= 0 && successStart > failureStart);
  assert.doesNotMatch(sidepanel.slice(failureStart, successStart), /exitTypingMode\(/);
});
