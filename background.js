let lastFeishuTabId = null;
const lastFeishuTabIdByWindow = new Map();
const lastFeishuFrameIdByTab = new Map();
const cellFrameHintsByTab = new Map();
const AUTO_CAPTURE_DELAY_MS = 60;
const INJECT_DEBOUNCE_MS = 300;
const injectedAtByTab = new Map();
const autoCaptureSuppressedUntilByTab = new Map();

if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  rememberFeishuTab(tab);
  notifyPanelScope(tab);

  if (chrome.sidePanel && chrome.sidePanel.open) {
    try {
      await chrome.sidePanel.open(getSidePanelOpenOptions(tab));
    } catch (error) {
      console.warn("Open side panel failed:", error);
    }
  }

  await ensureContentScript(tab.id, { force: true });

  requestCurrentCellCapture(tab.id);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  if (!activeInfo || typeof activeInfo.tabId !== "number") return;
  if (typeof activeInfo.windowId === "number") {
    lastFeishuTabIdByWindow.set(activeInfo.windowId, activeInfo.tabId);
  }
  lastFeishuTabId = activeInfo.tabId;
  notifyPanelScope({
    id: activeInfo.tabId,
    windowId: activeInfo.windowId
  });
  ensureContentScript(activeInfo.tabId).then((ok) => {
    if (ok) requestCurrentCellCapture(activeInfo.tabId);
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof tabId !== "number") return;
  if (!changeInfo || (!changeInfo.url && changeInfo.status !== "complete")) return;
  if (changeInfo.url) {
    lastFeishuFrameIdByTab.delete(tabId);
    cellFrameHintsByTab.delete(tabId);
  }
  chrome.tabs.get(tabId).then((tab) => {
    if (!tab || !tab.active) return null;
    rememberFeishuTab(tab);
    notifyPanelScope(tab);
    return tab;
  }).then((tab) => {
    if (!tab) return null;
    return ensureContentScript(tabId, { force: Boolean(changeInfo.url) }).then((ok) => {
      if (ok) requestCurrentCellCapture(tabId);
    });
  }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastFeishuFrameIdByTab.delete(tabId);
  cellFrameHintsByTab.delete(tabId);
  injectedAtByTab.delete(tabId);
  autoCaptureSuppressedUntilByTab.delete(tabId);
  if (lastFeishuTabId === tabId) lastFeishuTabId = null;
  for (const [windowId, rememberedTabId] of lastFeishuTabIdByWindow.entries()) {
    if (rememberedTabId === tabId) lastFeishuTabIdByWindow.delete(windowId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;
  if (message.fzRouted) return;

  if (message.type === "FZ_REVEAL_CELL") {
    forwardRevealCell(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, reason: error && error.message ? error.message : "REVEAL_FORWARD_FAILED" });
    });
    return true;
  }

  if (message.type === "FZ_WRITE_CELL") {
    forwardWriteCell(message).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, reason: error && error.message ? error.message : "WRITE_FORWARD_FAILED" });
    });
    return true;
  }

  if (message.type === "FZ_PANEL_READY") {
    const tabId = resolvePanelCaptureTabId(message);
    if (typeof tabId === "number") {
      notifyPanelScope({
        id: tabId,
        windowId: toFiniteNumber(message.windowId)
      });
      ensureContentScript(tabId).then((ok) => {
        if (ok) requestCurrentCellCapture(tabId);
      });
    }
    return;
  }

  if (!sender || !sender.tab || typeof sender.tab.id !== "number") return;
  if (message.type.startsWith("FZ_")) {
    rememberFeishuTab(sender.tab);
  }
  if (message.type === "FZ_CELL_SELECTED") {
    rememberCellFrame(sender.tab.id, sender.frameId, message);
  }
  if (isPanelRoutedMessage(message.type)) {
    relayToPanels(message, sender);
  }
});

async function forwardRevealCell(message) {
  const tabId = resolveWriteTabId(message);
  if (typeof tabId !== "number") return { ok: false, reason: "NO_FEISHU_TAB" };
  const target = message && message.targetSnapshot && typeof message.targetSnapshot === "object"
    ? message.targetSnapshot
    : {};
  const address = normalizeCellAddress(message && message.cellAddress || target.address);
  if (!address) return { ok: false, reason: "INVALID_TARGET_ADDRESS" };

  suppressAutoCapture(tabId, 20000);
  try {
    const activation = await activateSourceTab(tabId, target);
    if (!activation.ok) return activation;

    const injected = await ensureContentScript(tabId, { force: Boolean(activation.navigated) });
    if (!injected) return { ok: false, reason: "CONTENT_SCRIPT_NOT_READY" };
    const discoveredFrameId = await discoverWriteFrameId(tabId, target);
    const frameId = typeof discoveredFrameId === "number"
      ? discoveredFrameId
      : resolveWriteFrameId(tabId, message);
    const options = typeof frameId === "number" ? { frameId } : undefined;
    try {
      return await chrome.tabs.sendMessage(tabId, {
        ...message,
        type: "FZ_REVEAL_CELL",
        cellAddress: address,
        sourceTabActivated: true,
        sourceTabUrl: activation.tabUrl || ""
      }, options);
    } catch (error) {
      return { ok: false, reason: error && error.message ? error.message : "REVEAL_MESSAGE_FAILED" };
    }
  } finally {
    autoCaptureSuppressedUntilByTab.delete(tabId);
    suppressAutoCapture(tabId, 1500);
  }
}
async function forwardWriteCell(message) {
  const tabId = resolveWriteTabId(message);
  if (typeof tabId !== "number") return { ok: false, reason: "NO_FEISHU_TAB" };
  const target = message && message.targetSnapshot && typeof message.targetSnapshot === "object"
    ? message.targetSnapshot
    : {};
  const activation = await activateSourceTab(tabId, target);
  if (!activation.ok) return activation;

  const injected = await ensureContentScript(tabId, { force: Boolean(activation.navigated) });
  if (!injected) return { ok: false, reason: "CONTENT_SCRIPT_NOT_READY" };
  const discoveredFrameId = await discoverWriteFrameId(tabId, target);
  const frameId = typeof discoveredFrameId === "number"
    ? discoveredFrameId
    : resolveWriteFrameId(tabId, message);
  const options = typeof frameId === "number" ? { frameId } : undefined;
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      ...message,
      sourceTabActivated: true,
      sourceTabUrl: activation.tabUrl || ""
    }, options);
    return response;
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : "WRITE_MESSAGE_FAILED" };
  }
}

async function activateSourceTab(tabId, target) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    return { ok: false, reason: "SOURCE_TAB_UNAVAILABLE" };
  }
  if (!tab || typeof tab.id !== "number") {
    return { ok: false, reason: "SOURCE_TAB_UNAVAILABLE" };
  }

  const expectedTabUrl = String(target && target.tabUrl || "");
  if (expectedTabUrl && tab.url && !isSameSourceDocument(tab.url, expectedTabUrl)) {
    return { ok: false, reason: "SOURCE_TAB_NAVIGATED" };
  }

  try {
    const windowId = tab.windowId;
    if (typeof windowId === "number" && chrome.windows && chrome.windows.update) {
      await chrome.windows.update(windowId, { focused: true });
    }
    tab = await chrome.tabs.update(tabId, { active: true });
  } catch (_) {
    return { ok: false, reason: "SOURCE_TAB_UNAVAILABLE" };
  }

  const targetSheetId = String(target && target.sheetId || "");
  const currentSheetId = getSheetIdFromUrl(tab && tab.url);
  const targetTabSheetId = getSheetIdFromUrl(expectedTabUrl);
  const shouldNavigateSheet = Boolean(
    expectedTabUrl &&
    targetSheetId &&
    targetTabSheetId &&
    currentSheetId !== targetSheetId &&
    targetTabSheetId === targetSheetId
  );

  if (shouldNavigateSheet) {
    try {
      await chrome.tabs.update(tabId, { url: expectedTabUrl, active: true });
      tab = await waitForTabReady(tabId, 12000);
    } catch (_) {
      return { ok: false, reason: "SOURCE_SHEET_UNAVAILABLE" };
    }
  }

  await delay(90);
  return {
    ok: true,
    navigated: shouldNavigateSheet,
    tabUrl: tab && tab.url ? tab.url : ""
  };
}

async function discoverWriteFrameId(tabId, target) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => ({
        installed: Boolean(window.__fzCellPreviewListenerInstalled),
        url: location.href,
        hasSheetCanvas: Boolean(document.querySelector("canvas.faster-single-canvas")),
        hasFormulaControl: Boolean(document.querySelector(
          "[data-testid*='formula' i],[class*='formula' i],[aria-label*='公式' i],[placeholder*='公式' i]"
        ))
      })
    });
    const targetPageUrl = String(target && target.pageUrl || "");
    const scored = (results || [])
      .filter((item) => item && item.result && item.result.installed)
      .map((item) => {
        let score = 0;
        if (item.result.hasSheetCanvas) score += 50;
        if (item.result.hasFormulaControl) score += 20;
        if (targetPageUrl && item.result.url === targetPageUrl) score += 40;
        if (typeof item.frameId === "number" && item.frameId === toFiniteNumber(target && target.frameId)) score += 10;
        return { frameId: item.frameId, score };
      })
      .sort((a, b) => b.score - a.score);
    return scored.length && scored[0].score > 0 ? scored[0].frameId : null;
  } catch (_) {
    return null;
  }
}

function isSameSourceDocument(currentUrl, expectedUrl) {
  const currentKey = getSourceDocumentKey(currentUrl);
  const expectedKey = getSourceDocumentKey(expectedUrl);
  return Boolean(currentKey && expectedKey && currentKey === expectedKey);
}

function getSourceDocumentKey(value) {
  try {
    const url = new URL(String(value || ""));
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin.toLowerCase()}${path}`;
  } catch (_) {
    return "";
  }
}

function getSheetIdFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return String(url.searchParams.get("sheet") || url.searchParams.get("sheetId") || "");
  } catch (_) {
    return "";
  }
}

function waitForTabReady(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const finish = (error, tab) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve(tab);
    };
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === "complete") finish(null, tab);
    };
    const timer = setTimeout(() => {
      chrome.tabs.get(tabId).then((tab) => finish(null, tab)).catch((error) => finish(error));
    }, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === "complete") finish(null, tab);
    }).catch((error) => finish(error));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rememberFeishuTab(tab) {
  if (!tab || typeof tab.id !== "number") return;
  lastFeishuTabId = tab.id;
  if (typeof tab.windowId === "number") {
    lastFeishuTabIdByWindow.set(tab.windowId, tab.id);
  }
}

function getSidePanelOpenOptions(tab) {
  return { tabId: tab.id };
}

function resolvePanelCaptureTabId(message) {
  const directTabId = toFiniteNumber(message && message.tabId);
  if (typeof directTabId === "number") return directTabId;

  const windowId = toFiniteNumber(message && message.windowId);
  if (typeof windowId === "number" && lastFeishuTabIdByWindow.has(windowId)) {
    return lastFeishuTabIdByWindow.get(windowId);
  }

  return lastFeishuTabId;
}

function resolveWriteTabId(message) {
  const directTabId = toFiniteNumber(message && message.tabId);
  if (typeof directTabId === "number") return directTabId;

  return resolvePanelCaptureTabId(message);
}

function isPanelRoutedMessage(type) {
  return type === "FZ_CELL_SELECTED" ||
    type === "FZ_CAPTURE_DEBUG" ||
    type === "FZ_CAPTURE_EMPTY" ||
    type === "FZ_CAPTURE_ERROR" ||
    type === "FZ_CAPTURE_BLOCKED";
}

function relayToPanels(message, sender) {
  const tab = sender && sender.tab ? sender.tab : null;
  if (!tab || typeof tab.id !== "number") return;
  const routed = {
    ...message,
    fzRouted: true,
    tabId: tab.id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : null,
    frameId: typeof sender.frameId === "number" ? sender.frameId : null,
    tabUrl: tab.url || ""
  };
  const result = chrome.runtime.sendMessage(routed);
  if (result && typeof result.catch === "function") result.catch(() => {});
}

function notifyPanelScope(tab) {
  if (!tab || typeof tab.id !== "number") return;
  const routed = {
    type: "FZ_PANEL_SCOPE_CHANGED",
    fzRouted: true,
    tabId: tab.id,
    windowId: typeof tab.windowId === "number" ? tab.windowId : null
  };
  const result = chrome.runtime.sendMessage(routed);
  if (result && typeof result.catch === "function") result.catch(() => {});
}

function rememberCellFrame(tabId, frameId, message) {
  if (typeof tabId !== "number" || typeof frameId !== "number") return;
  const keys = buildFrameHintKeys(message);
  if (!keys.length) return;

  lastFeishuFrameIdByTab.set(tabId, frameId);

  const hints = getFrameHints(tabId);
  keys.forEach((key) => {
    hints.set(key, frameId);
  });
}

function resolveWriteFrameId(tabId, message) {
  if (message && typeof message.frameId === "number") return message.frameId;

  const hints = cellFrameHintsByTab.get(tabId);
  if (hints) {
    const keys = buildFrameHintKeys(message);
    for (const key of keys) {
      if (hints.has(key)) return hints.get(key);
    }
  }

  return lastFeishuFrameIdByTab.get(tabId);
}

function getFrameHints(tabId) {
  let hints = cellFrameHintsByTab.get(tabId);
  if (!hints) {
    hints = new Map();
    cellFrameHintsByTab.set(tabId, hints);
  }
  return hints;
}

function buildFrameHintKeys(message) {
  const keys = [];
  const address = normalizeCellAddress(message && message.cellAddress);
  if (address) keys.push(`address:${address}`);

  const context = normalizeCellContext(message && message.cellContext);
  if (context) keys.push(`point:${context.x},${context.y}`);

  return keys;
}

function normalizeCellAddress(value) {
  const text = String(value || "").trim().toUpperCase();
  const match = text.match(/^\$?([A-Z]{1,4})\$?(\d{1,7})$/);
  return match ? `${match[1]}${match[2]}` : "";
}

function normalizeCellContext(context) {
  if (!context || typeof context !== "object") return null;
  const x = Number(context.x);
  const y = Number(context.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function ensureContentScript(tabId, options = {}) {
  if (typeof tabId !== "number") return false;

  const now = Date.now();
  const lastInjectedAt = injectedAtByTab.get(tabId) || 0;
  if (!options.force && now - lastInjectedAt < INJECT_DEBOUNCE_MS) return true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
    injectedAtByTab.set(tabId, now);
    return true;
  } catch (error) {
    injectedAtByTab.delete(tabId);
    return false;
  }
}

function suppressAutoCapture(tabId, durationMs) {
  if (typeof tabId !== "number") return;
  const until = Date.now() + Math.max(0, Number(durationMs) || 0);
  const current = autoCaptureSuppressedUntilByTab.get(tabId) || 0;
  autoCaptureSuppressedUntilByTab.set(tabId, Math.max(current, until));
}

function isAutoCaptureSuppressed(tabId) {
  const until = autoCaptureSuppressedUntilByTab.get(tabId) || 0;
  if (!until) return false;
  if (until <= Date.now()) {
    autoCaptureSuppressedUntilByTab.delete(tabId);
    return false;
  }
  return true;
}

function requestCurrentCellCapture(tabId) {
  if (typeof tabId !== "number" || isAutoCaptureSuppressed(tabId)) return;
  setTimeout(() => {
    if (isAutoCaptureSuppressed(tabId)) return;
    const result = chrome.tabs.sendMessage(tabId, { type: "FZ_CAPTURE_CURRENT_CELL" });
    if (result && typeof result.catch === "function") result.catch(() => {});
  }, AUTO_CAPTURE_DELAY_MS);
}
