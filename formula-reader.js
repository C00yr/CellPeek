// Runs in MAIN world: use the same read-only worksheet getters as Feishu.
(function () {
  "use strict";
  document.documentElement.setAttribute("data-cellpeek-formula-reader", "2026-10-13-v1");

  function normalizeFormula(value) {
    const text = String(value == null ? "" : value).replace(/\r\n?/g, "\n").trim();
    return text.startsWith("=") ? text.slice(1) : text;
  }

  function resolveBinding() {
    // Restrict discovery to the current formula bar, never a locked native preview.
    const nodes = document.querySelectorAll(".formulabar__inputarea, #t-formula-bar-input-container");
    for (const node of nodes) {
      if (!node.getBoundingClientRect().width) continue;
      let fiber = null;
      for (let host = node, depth = 0; host && depth < 8; host = host.parentElement, depth++) {
        const key = Object.keys(host).find(key => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"));
        if (key) { fiber = host[key]; break; }
      }
      for (let depth = 0; fiber && depth < 20; depth++, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (props && props.spread && props.coord && typeof props.spread.getActiveSheet === "function") {
          return { spread: props.spread, coord: props.coord };
        }
      }
    }
    return null;
  }

  function readResult(address, formula) {
    const match = /^([A-Z]+)([1-9]\d*)$/.exec(String(address || "").toUpperCase());
    if ((address && !match) || !String(formula || "").trimStart().startsWith("=")) {
      return { status: "unavailable", reason: "invalid_formula_target" };
    }
    const binding = resolveBinding();
    if (!binding) return { status: "unavailable", reason: "native_binding_missing" };
    const { spread, coord } = binding;
    const row = match ? Number(match[2]) - 1 : coord.row;
    const col = match ? [...match[1]].reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1 : coord.col;
    const sheet = spread.getActiveSheet();
    if (!sheet || !Number.isSafeInteger(row) || !Number.isSafeInteger(col) || row < 0 || col < 0 ||
        coord.row !== row || coord.col !== col ||
        sheet.getActiveRowIndex() !== row || sheet.getActiveColumnIndex() !== col) {
      return { status: "unavailable", reason: "native_selection_changed" };
    }
    const urlSheet = new URL(location.href).searchParams.get("sheet");
    if (urlSheet && spread.getSheetFromId(urlSheet) !== sheet) {
      return { status: "unavailable", reason: "native_sheet_changed" };
    }
    if (normalizeFormula(sheet.getFormula(row, col)) !== normalizeFormula(formula)) {
      return { status: "unavailable", reason: "native_formula_changed" };
    }
    // This getter preserves dates, percentages, error values and full long text.
    // In Show Formulas mode bypass getText's formula-source branch.
    const text = sheet.options?.showFormulaText
      ? sheet.getTextByTextWithValues(sheet.getTextWithValues(row, col))
      : sheet.getText(row, col);
    if (typeof text !== "string") return { status: "unavailable", reason: "native_text_not_ready" };
    const latest = resolveBinding();
    if (!latest || latest.spread !== spread || spread.getActiveSheet() !== sheet ||
        latest.coord.row !== row || latest.coord.col !== col ||
        sheet.getActiveRowIndex() !== row || sheet.getActiveColumnIndex() !== col ||
        normalizeFormula(sheet.getFormula(row, col)) !== normalizeFormula(formula)) {
      return { status: "unavailable", reason: "native_selection_changed" };
    }
    return { status: "ready", text };
  }

  window.__cellPeekReadFormulaResult = function (address, formula) {
    let result;
    try { result = readResult(address, formula); }
    catch (_) { result = { status: "unavailable", reason: "native_reader_failed" }; }
    // Only status/length, no cell contents or internal model, in diagnostics.
    document.documentElement.setAttribute("data-cellpeek-formula-status", JSON.stringify({
      status: result.status, reason: result.reason || "", length: result.text?.length ?? null
    }));
    return result;
  };
})();
