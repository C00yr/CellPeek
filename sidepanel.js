(function () {
  "use strict";

  const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
  const MAX_DEBUG_LOGS = 20;
  const SEARCH_DEBOUNCE_MS = 90;
  const SEARCH_OPEN_DURATION_MS = 220;
  const SEARCH_CLOSE_DURATION_MS = 180;
  const SEARCH_BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE",
    "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "LI", "MAIN", "NAV", "OL", "P",
    "PRE", "SECTION", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"
  ]);
  const TARGET_MISMATCH_MESSAGE = "无法确认原单元格位置，可能因行列调整而发生变化。请重新点击目标单元格后再键入。";
  const WRITE_CONFLICT_MESSAGE = "原单元格已变化，请重新定位";
  const mathRenderCache = new Map();
  const markdownParser = createMarkdownParser();
  const MODE_LABELS = Object.freeze({ auto: "自动", md: "MD", json: "JSON", raw: "原文" });



  const state = {
    split: "single",
    splitRatio: 50,
    activePane: 0,
    scope: readPanelScopeFromUrl(),
    panes: [
      createPaneState("分栏 1"),
      createPaneState("分栏 2")
    ],
    debug: {
      open: false,
      alert: false,
      logs: []
    }
  };

  function createPaneState(source) {
    return {
      locked: false,
      mode: "auto",
      text: "",
      source,

      cellContext: null,
      cellAddress: "",
      cellTarget: null,
      cellAccessMode: "unknown",
      revealing: false,
      revealSelectionGuard: null,
      editing: false,
      editMode: "text",
      draft: "",
      draftBaseText: "",
      writing: false,
      editContext: null,
      editAddress: "",
      editTarget: null,
      relocationStatus: "idle",
      relocationCandidate: null,
      confirmDiscard: false,
      writeEchoGuard: null,
      searchOpen: false,
      searchQuery: "",
      searchCount: 0,
      searchIndex: -1,
      searchOffsets: [],
      searchTextLength: 0,
      jsonExpanded: {},
      jsonModel: null,
      jsonSearchExpansionSnapshot: null
    };
  }

  const panesEl = document.querySelector(".fz-panes");
  const titleEl = document.querySelector(".fz-title");
  const toastEl = document.querySelector(".fz-toast");
  const tooltipEl = document.querySelector(".fz-tooltip");
  if (tooltipEl && tooltipEl.parentElement !== document.body) document.body.appendChild(tooltipEl);
  const splitterEl = document.querySelector(".fz-splitter");
  const debugSectionEl = document.querySelector(".fz-debug");
  const debugToggleEl = document.querySelector(".fz-debug-toggle");
  const debugAlertDotEl = document.querySelector(".fz-debug-alert-dot");
  const debugPanelEl = document.querySelector(".fz-debug-panel");
  const debugCountEl = document.querySelector(".fz-debug-count");
  const debugContentEl = document.querySelector(".fz-debug-content");
  let tooltipTimer = 0;
  let tooltipTarget = null;
  const searchTimers = [0, 0];
  const searchMotionStates = [createSearchMotionState(), createSearchMotionState()];

  document.addEventListener("pointerover", handleTooltipPointerOver);
  document.addEventListener("pointerout", handleTooltipPointerOut);
  document.addEventListener("focusin", handlePaneFocusIn);
  document.addEventListener("focusin", handleTooltipFocusIn);
  document.addEventListener("focusout", handleTooltipFocusOut);
  document.addEventListener("scroll", hideTooltip, true);
  document.addEventListener("scroll", (event) => {
    const editor = event.target && typeof event.target.closest === "function"
      ? event.target.closest(".fz-json-type-editor")
      : null;
    if (editor) syncJsonEditorMirror(editor);
  }, true);
  window.addEventListener("resize", () => {
    hideTooltip();
    renderChrome();
  });


  document.addEventListener("click", (event) => {
    hideTooltip();
    const paneEl = event.target.closest(".fz-pane");
    const isPaneControlClick = Boolean(event.target.closest("[data-action],.fz-search-panel"));
    const isTextContentClick = Boolean(event.target.closest(".fz-rendered,.fz-json,.fz-raw,.fz-type-editor"));
    if (paneEl) {
      const paneIndex = Number(paneEl.dataset.pane);
      if (Number.isFinite(paneIndex)) {
        if (state.activePane !== paneIndex) {
          closeAllPaneSearch({ restoreFocus: false });
          state.activePane = paneIndex;
          renderChrome();
        }

        if (!isPaneControlClick && !isTextContentClick) {
          if (state.panes[paneIndex].locked) {
            showToast("该分栏已锁定");
          } else {
            requestInitialCapture();
          }
        }
      }
    }

    if (!event.target.closest(".fz-view-mode")) closeAllModeMenus();

    const actionBtn = event.target.closest("[data-action]");
    if (!actionBtn) return;
    const action = actionBtn.dataset.action;

    if (action === "toggle-search") {
      const searchPaneEl = actionBtn.closest(".fz-pane");
      if (!searchPaneEl) return;
      const paneIndex = Number(searchPaneEl.dataset.pane);
      const pane = state.panes[paneIndex];
      if (!pane) return;
      if (pane.searchOpen) {
        closePaneSearch(paneIndex, { restoreFocus: true });
      } else {
        openPaneSearch(paneIndex, { selectQuery: false });
      }
      return;
    }

    if (action === "search-prev" || action === "search-next") {
      const searchPaneEl = actionBtn.closest(".fz-pane");
      if (!searchPaneEl) return;
      navigatePaneSearch(Number(searchPaneEl.dataset.pane), action === "search-prev" ? -1 : 1);
      return;
    }

    if (action !== "type" && action !== "json-toggle" && action !== "json-copy-member") {
      closeAllPaneSearch({ restoreFocus: false });
    }
    if (action === "reveal-cell") {
      const revealPaneEl = actionBtn.closest(".fz-pane");
      if (!revealPaneEl) return;
      revealPaneCell(Number(revealPaneEl.dataset.pane));
      return;
    }
    if (action === "toggle-mode-menu") {
      const modePaneEl = actionBtn.closest(".fz-pane");
      if (!modePaneEl) return;
      const paneIndex = Number(modePaneEl.dataset.pane);
      const pane = state.panes[paneIndex];
      if (!pane) return;
      if (pane.editing) {
        showToast("请先完成或放弃当前草稿");
        return;
      }
      toggleModeMenu(modePaneEl, false);
      return;
    }

    if (action === "select-mode") {
      const modePaneEl = actionBtn.closest(".fz-pane");
      if (!modePaneEl) return;
      const paneIndex = Number(modePaneEl.dataset.pane);
      const pane = state.panes[paneIndex];
      const mode = String(actionBtn.dataset.mode || "");
      if (!pane || !Object.prototype.hasOwnProperty.call(MODE_LABELS, mode)) return;
      if (pane.editing) {
        closeModeMenu(modePaneEl, true);
        showToast("请先完成或放弃当前草稿");
        return;
      }
      pane.mode = mode;
      closeModeMenu(modePaneEl, true);
      renderPane(paneIndex, { preserveScroll: true });
      return;
    }

    if (action === "complete-typing") {
      const paneElForWrite = actionBtn.closest(".fz-pane");
      if (!paneElForWrite) return;
      completeTypingMode(Number(paneElForWrite.dataset.pane));
      return;
    }

    if (action === "discard-typing") {
      const paneElForDiscard = actionBtn.closest(".fz-pane");
      if (!paneElForDiscard) return;
      requestDiscardTyping(Number(paneElForDiscard.dataset.pane));
      return;
    }

    if (action === "keep-draft") {
      const paneElForKeep = actionBtn.closest(".fz-pane");
      if (!paneElForKeep) return;
      const paneIndex = Number(paneElForKeep.dataset.pane);
      state.panes[paneIndex].confirmDiscard = false;
      renderPane(paneIndex, { preserveScroll: true, focusEditor: true });
      return;
    }

    if (action === "confirm-discard") {
      const paneElForConfirmDiscard = actionBtn.closest(".fz-pane");
      if (!paneElForConfirmDiscard) return;
      discardTypingMode(Number(paneElForConfirmDiscard.dataset.pane));
      return;
    }

    if (action === "confirm-relocation") {
      const paneElForRelocation = actionBtn.closest(".fz-pane");
      if (!paneElForRelocation) return;
      confirmRelocationCandidate(Number(paneElForRelocation.dataset.pane));
      return;
    }

    if (action === "json-toggle") {
      const jsonPaneEl = actionBtn.closest(".fz-pane");
      if (!jsonPaneEl) return;
      toggleJsonNode(Number(jsonPaneEl.dataset.pane), actionBtn.dataset.jsonPath || "");
      return;
    }

    if (action === "json-copy-member") {
      const jsonPaneEl = actionBtn.closest(".fz-pane");
      if (!jsonPaneEl) return;
      copyJsonMember(Number(jsonPaneEl.dataset.pane), actionBtn.dataset.jsonPath || "");
      return;
    }

    if (action === "type") {
      const typePaneEl = actionBtn.closest(".fz-pane");
      if (!typePaneEl) return;
      const paneIndex = Number(typePaneEl.dataset.pane);
      if (state.panes[paneIndex] && state.panes[paneIndex].editing) {
        requestDiscardTyping(paneIndex);
      } else {
        beginTypingMode(paneIndex);
      }
      return;
    }

    if (action === "copy") {
      const copyPaneEl = actionBtn.closest(".fz-pane");
      if (!copyPaneEl) return;
      copyPaneContent(Number(copyPaneEl.dataset.pane));
      return;
    }

    if (action === "lock") {
      const lockPaneEl = actionBtn.closest(".fz-pane");
      if (!lockPaneEl) return;
      const paneIndex = Number(lockPaneEl.dataset.pane);
      if (state.panes[paneIndex] && state.panes[paneIndex].editing) {
        requestDiscardTyping(paneIndex);
        return;
      }
      const wasLocked = state.panes[paneIndex].locked;
      state.panes[paneIndex].locked = !state.panes[paneIndex].locked;
      state.activePane = paneIndex;
      renderPane(paneIndex, { preserveScroll: true });
      renderChrome();
      if (wasLocked) requestInitialCapture();
      showToast(state.panes[paneIndex].locked ? "已锁定当前分栏" : "已解锁当前分栏");
      return;
    }

    if (action === "split-single") {
      if (hasActiveDraft()) {
        showToast("请先完成或放弃当前草稿");
        return;
      }
      state.split = "single";
      state.activePane = 0;
      closeAllModeMenus();
      renderAll();
      return;
    }

    if (action === "split-vertical") {
      if (hasActiveDraft()) {
        showToast("请先完成或放弃当前草稿");
        return;
      }
      state.split = "vertical";
      closeAllModeMenus();
      renderAll();
      return;
    }

    if (action === "split-horizontal") {
      if (hasActiveDraft()) {
        showToast("请先完成或放弃当前草稿");
        return;
      }
      state.split = "horizontal";
      closeAllModeMenus();
      renderAll();
      return;
    }

    if (action === "toggle-debug") {
      state.debug.open = !state.debug.open;
      if (state.debug.open) state.debug.alert = false;
      renderDebug();
      return;
    }

    if (action === "copy-debug") {
      copyLatestDebug();
      return;
    }

    if (action === "clear-debug") {
      state.debug.logs = [];
      state.debug.alert = false;
      renderDebug();
      showToast("已清空调试记录");
    }
  });
  document.addEventListener("input", (event) => {
    const searchInput = event.target.closest(".fz-search-input");
    if (searchInput) {
      const paneEl = searchInput.closest(".fz-pane");
      if (!paneEl) return;
      queuePaneSearch(Number(paneEl.dataset.pane), searchInput.value);
      return;
    }

    const editor = event.target.closest(".fz-type-editor");
    if (!editor) return;
    const paneEl = editor.closest(".fz-pane");
    if (!paneEl) return;
    const paneIndex = Number(paneEl.dataset.pane);
    const pane = state.panes[paneIndex];
    if (!pane) return;
    pane.draft = editor.value;
    updateTypingCount(paneEl, pane.draft);
    if (pane.editMode === "json") updateJsonTypingUI(paneEl, pane);

  });

  document.addEventListener("keydown", (event) => {
    if (handlePaneSearchKeydown(event)) return;
    if (handleModeMenuKeydown(event)) return;
    if (event.target === splitterEl && handleSplitterKeydown(event)) return;

    const editor = event.target.closest(".fz-type-editor");
    if (!editor) return;
    const paneEl = editor.closest(".fz-pane");
    if (!paneEl) return;
    const paneIndex = Number(paneEl.dataset.pane);
    if (editor.dataset.jsonEditor === "true") {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault();
        completeTypingMode(paneIndex);
      }
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.isComposing) return;
    event.preventDefault();
    completeTypingMode(paneIndex);
  });

  function canSearchPane(pane) {
    return Boolean(pane && !pane.editing && String(pane.text == null ? "" : pane.text).length);
  }

  function createSearchMotionState() {
    return {
      phase: "closed",
      closeTimer: 0,
      closeToken: 0,
      restoreFocus: false,
      ghost: null,
      animation: null,
      ghostTimer: 0
    };
  }

  function prefersReducedSearchMotion() {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function copyMotionRect(rect) {
    if (!rect) return null;
    return {
      left: Number(rect.left) || 0,
      top: Number(rect.top) || 0,
      width: Math.max(1, Number(rect.width) || 22),
      height: Math.max(1, Number(rect.height) || 22)
    };
  }

  function takeSearchMotionStartRect(paneIndex, fallbackElement) {
    const motion = searchMotionStates[paneIndex];
    let rect = null;
    if (motion && motion.ghost && motion.ghost.isConnected) {
      rect = copyMotionRect(motion.ghost.getBoundingClientRect());
    }
    if (!rect && fallbackElement) rect = copyMotionRect(fallbackElement.getBoundingClientRect());
    if (motion && motion.ghostTimer) window.clearTimeout(motion.ghostTimer);
    if (motion) motion.ghostTimer = 0;
    if (motion && motion.animation) {
      try {
        motion.animation.cancel();
      } catch (_) {}
    }
    if (motion && motion.ghost) motion.ghost.remove();
    if (motion) {
      motion.animation = null;
      motion.ghost = null;
    }
    return rect;
  }

  function getSearchMotionTargetRect(paneEl, opening) {
    if (!paneEl) return null;
    if (!opening) {
      const trigger = paneEl.querySelector(".fz-search-trigger");
      return trigger ? copyMotionRect(trigger.getBoundingClientRect()) : null;
    }

    const panel = paneEl.querySelector(".fz-search-panel");
    const meta = paneEl.querySelector(".fz-cell-meta");
    if (!panel || !meta) return null;
    const panelRect = panel.getBoundingClientRect();
    const metaRect = meta.getBoundingClientRect();
    return {
      left: panelRect.left + 3,
      top: metaRect.bottom + 5,
      width: 22,
      height: 22
    };
  }

  function startSearchIconMotion(paneIndex, opening, startRect) {
    const motion = searchMotionStates[paneIndex];
    const paneEl = document.querySelector('[data-pane="' + paneIndex + '"]');
    if (!motion || !paneEl) return;
    if (prefersReducedSearchMotion() || typeof Element === "undefined" || !Element.prototype.animate) {
      motion.phase = opening ? "open" : motion.phase;
      return;
    }

    const targetRect = getSearchMotionTargetRect(paneEl, opening);
    const iconSource = paneEl.querySelector(opening ? ".fz-search-trigger" : ".fz-search-panel-toggle");
    const icon = iconSource && iconSource.querySelector(".fz-search-icon");
    if (!startRect || !targetRect || !icon) {
      motion.phase = opening ? "open" : motion.phase;
      return;
    }

    const ghost = document.createElement("span");
    ghost.className = "fz-search-motion-icon";
    ghost.setAttribute("aria-hidden", "true");
    ghost.appendChild(icon.cloneNode(true));

    const startLeft = startRect.left + (startRect.width - 22) / 2;
    const startTop = startRect.top + (startRect.height - 22) / 2;
    const targetLeft = targetRect.left + (targetRect.width - 22) / 2;
    const targetTop = targetRect.top + (targetRect.height - 22) / 2;
    ghost.style.left = startLeft + "px";
    ghost.style.top = startTop + "px";
    document.body.appendChild(ghost);

    const deltaX = targetLeft - startLeft;
    const deltaY = targetTop - startTop;
    const duration = opening ? SEARCH_OPEN_DURATION_MS : SEARCH_CLOSE_DURATION_MS;
    const animation = ghost.animate([
      { transform: "translate(0, 0) scale(1)", opacity: 1, offset: 0 },
      { transform: "translate(" + (deltaX * 0.78) + "px, " + (deltaY * 0.78) + "px) scale(1)", opacity: 1, offset: 0.72 },
      { transform: "translate(" + deltaX + "px, " + deltaY + "px) scale(0.94)", opacity: 0, offset: 1 }
    ], {
      duration,
      easing: opening ? "cubic-bezier(0.2, 0.8, 0.2, 1)" : "cubic-bezier(0.4, 0, 0.2, 1)",
      fill: "forwards"
    });

    motion.ghost = ghost;
    motion.animation = animation;
    const finish = () => {
      if (motion.ghost !== ghost) return;
      if (motion.ghostTimer) window.clearTimeout(motion.ghostTimer);
      motion.ghostTimer = 0;
      ghost.remove();
      motion.ghost = null;
      motion.animation = null;
      if (opening && state.panes[paneIndex] && state.panes[paneIndex].searchOpen) motion.phase = "open";
    };
    motion.ghostTimer = window.setTimeout(finish, duration + 60);
    animation.onfinish = finish;
    animation.oncancel = () => {
      if (motion.ghost === ghost) {
        if (motion.ghostTimer) window.clearTimeout(motion.ghostTimer);
        motion.ghostTimer = 0;
        ghost.remove();
        motion.ghost = null;
        motion.animation = null;
      }
    };
  }

  function cancelSearchCloseFinalize(paneIndex) {
    const motion = searchMotionStates[paneIndex];
    if (!motion) return;
    if (motion.closeTimer) window.clearTimeout(motion.closeTimer);
    motion.closeTimer = 0;
    motion.closeToken += 1;
    motion.restoreFocus = false;
  }

  function finalizePaneSearchClose(paneIndex, closeToken) {
    const pane = state.panes[paneIndex];
    const motion = searchMotionStates[paneIndex];
    const paneEl = document.querySelector('[data-pane="' + paneIndex + '"]');
    if (!pane || !motion || pane.searchOpen || closeToken !== motion.closeToken) return;

    motion.closeTimer = 0;
    takeSearchMotionStartRect(paneIndex, null);
    pane.searchQuery = "";
    pane.searchCount = 0;
    pane.searchIndex = -1;
    pane.searchOffsets = [];
    pane.searchTextLength = 0;
    motion.phase = "closed";
    if (paneEl) updatePaneSearchUI(paneEl, pane);

    if (motion.restoreFocus && paneEl) {
      const trigger = paneEl.querySelector(".fz-search-trigger");
      if (trigger && !trigger.disabled) {
        try {
          trigger.focus({ preventScroll: true });
        } catch (_) {
          trigger.focus();
        }
      }
    }
    motion.restoreFocus = false;
  }

  function openPaneSearch(paneIndex, options) {
    const pane = state.panes[paneIndex];
    const paneEl = document.querySelector('[data-pane="' + paneIndex + '"]');
    if (!pane || !paneEl || !canSearchPane(pane)) return false;

    closeAllPaneSearch({ exceptPaneIndex: paneIndex, restoreFocus: false });
    closeAllModeMenus();
    const motion = searchMotionStates[paneIndex];
    const trigger = paneEl.querySelector(".fz-search-trigger");
    const startRect = takeSearchMotionStartRect(paneIndex, trigger);
    cancelSearchCloseFinalize(paneIndex);
    motion.phase = "opening";
    pane.searchOpen = true;
    state.activePane = paneIndex;
    updatePaneSearchUI(paneEl, pane);
    renderChrome();
    startSearchIconMotion(paneIndex, true, startRect);
    if (String(pane.searchQuery || "").trim()) {
      applyPaneSearch(paneIndex, { resetIndex: pane.searchIndex < 0, scroll: false });
    }

    window.requestAnimationFrame(() => {
      const input = paneEl.querySelector(".fz-search-input");
      if (!input || input.disabled) return;
      try {
        input.focus({ preventScroll: true });
      } catch (_) {
        input.focus();
      }
      if (options && options.selectQuery) input.select();
    });
    return true;
  }

  function closePaneSearch(paneIndex, options) {
    const pane = state.panes[paneIndex];
    const paneEl = document.querySelector('[data-pane="' + paneIndex + '"]');
    const motion = searchMotionStates[paneIndex];
    if (!pane || !motion) return;
    if (!pane.searchOpen && motion.phase === "closing") {
      motion.restoreFocus = motion.restoreFocus || Boolean(options && options.restoreFocus);
      return;
    }
    if (!pane.searchOpen && !pane.searchQuery && !pane.searchCount) return;

    const panelToggle = paneEl && paneEl.querySelector(".fz-search-panel-toggle");
    const startRect = takeSearchMotionStartRect(paneIndex, panelToggle);
    if (searchTimers[paneIndex]) window.clearTimeout(searchTimers[paneIndex]);
    searchTimers[paneIndex] = 0;
    if (paneEl) clearSearchHighlights(paneEl.querySelector(".fz-content"));
    const shouldRestoreJsonExpansion = restoreJsonSearchExpansion(pane);
    pane.searchOpen = false;
    if (shouldRestoreJsonExpansion && paneEl) renderPane(paneIndex, { preserveScroll: true });
    motion.phase = "closing";
    motion.restoreFocus = Boolean(options && options.restoreFocus);
    motion.closeToken += 1;
    const closeToken = motion.closeToken;
    if (paneEl) updatePaneSearchUI(paneEl, pane);
    startSearchIconMotion(paneIndex, false, startRect);

    if (prefersReducedSearchMotion()) {
      finalizePaneSearchClose(paneIndex, closeToken);
      return;
    }
    motion.closeTimer = window.setTimeout(() => {
      finalizePaneSearchClose(paneIndex, closeToken);
    }, SEARCH_CLOSE_DURATION_MS);
  }
  function closeAllPaneSearch(options) {
    const exceptPaneIndex = options && Number.isFinite(options.exceptPaneIndex)
      ? options.exceptPaneIndex
      : -1;
    state.panes.forEach((pane, paneIndex) => {
      if (paneIndex === exceptPaneIndex) return;
      if (!pane.searchOpen && !pane.searchQuery && !pane.searchCount && searchMotionStates[paneIndex].phase !== "closing") return;
      closePaneSearch(paneIndex, { restoreFocus: Boolean(options && options.restoreFocus) });
    });
  }

  function updatePaneSearchUI(paneEl, pane) {
    if (!paneEl || !pane) return;
    const paneIndex = Number(paneEl.dataset.pane);
    const motion = searchMotionStates[paneIndex] || createSearchMotionState();
    const available = canSearchPane(pane);
    const open = Boolean(pane.searchOpen && available);
    const closing = !open && motion.phase === "closing";
    const interactivePanel = open || closing;
    const trigger = paneEl.querySelector(".fz-search-trigger");
    const panel = paneEl.querySelector(".fz-search-panel");
    const panelToggle = paneEl.querySelector(".fz-search-panel-toggle");
    const input = paneEl.querySelector(".fz-search-input");
    const count = paneEl.querySelector(".fz-search-count");
    const navButtons = paneEl.querySelectorAll(".fz-search-nav");
    const hasQuery = Boolean(String(pane.searchQuery || "").trim());

    paneEl.classList.toggle("fz-search-open", open);
    paneEl.classList.toggle("fz-search-closing", closing);
    if (trigger) {
      trigger.disabled = !available || closing;
      trigger.setAttribute("aria-expanded", String(open));
    }
    if (panel) {
      panel.setAttribute("aria-hidden", String(!interactivePanel));
      panel.classList.toggle("fz-search-no-results", open && hasQuery && pane.searchCount === 0);
    }
    if (panelToggle) {
      panelToggle.disabled = !interactivePanel;
      panelToggle.tabIndex = interactivePanel ? 0 : -1;
    }
    if (input) {
      input.disabled = !open;
      input.tabIndex = open ? 0 : -1;
      if (input.value !== pane.searchQuery) input.value = pane.searchQuery;
    }
    if (count) {
      count.textContent = hasQuery
        ? (pane.searchCount ? (pane.searchIndex + 1) + "/" + pane.searchCount : "0/0")
        : "";
    }
    navButtons.forEach((button) => {
      button.disabled = !open || pane.searchCount === 0;
      button.tabIndex = open ? 0 : -1;
    });
  }

  function queuePaneSearch(paneIndex, query) {
    const pane = state.panes[paneIndex];
    if (!pane || !pane.searchOpen) return;
    pane.searchQuery = String(query == null ? "" : query);
    if (searchTimers[paneIndex]) window.clearTimeout(searchTimers[paneIndex]);
    searchTimers[paneIndex] = 0;
    if (!pane.searchQuery.trim()) {
      applyPaneSearch(paneIndex, { resetIndex: true, scroll: false });
      return;
    }
    searchTimers[paneIndex] = window.setTimeout(() => {
      searchTimers[paneIndex] = 0;
      applyPaneSearch(paneIndex, { resetIndex: true, scroll: true });
    }, SEARCH_DEBOUNCE_MS);
  }

  function applyPaneSearch(paneIndex, options) {
    const pane = state.panes[paneIndex];
    const paneEl = document.querySelector('[data-pane="' + paneIndex + '"]');
    if (!pane || !paneEl) return;
    if (searchTimers[paneIndex]) window.clearTimeout(searchTimers[paneIndex]);
    searchTimers[paneIndex] = 0;

    const contentEl = paneEl.querySelector(".fz-content");
    clearSearchHighlights(contentEl);
    const query = String(pane.searchQuery || "");
    let root = contentEl && contentEl.querySelector(".fz-rendered,.fz-json,.fz-raw");
    if (root && root.classList.contains("fz-json-tree") && query.trim() && revealJsonSearchMatches(pane, query)) {
      const scrollTop = contentEl.scrollTop;
      const scrollLeft = contentEl.scrollLeft;
      contentEl.innerHTML = renderPaneContent(pane);
      root = contentEl.querySelector(".fz-json-tree");
      contentEl.scrollTop = scrollTop;
      contentEl.scrollLeft = scrollLeft;
    }
    if (!pane.searchOpen || !query.trim() || !root) {
      pane.searchCount = 0;
      pane.searchIndex = -1;
      pane.searchOffsets = [];
      pane.searchTextLength = 0;
      updatePaneSearchUI(paneEl, pane);
      return;
    }

    const textMap = createPaneSearchTextMap(root);
    const matches = findLiteralMatches(textMap.text, query);
    pane.searchCount = matches.length;
    pane.searchOffsets = matches.map((match) => {
      const mathSegment = textMap.segments.find((segment) =>
        segment.atomic && match.end > segment.start && match.start < segment.end
      );
      return {
        start: match.start,
        end: match.end,
        mathSource: mathSegment ? mathSegment.mathSource : ""
      };
    });
    pane.searchTextLength = textMap.text.length;
    if (!matches.length) {
      pane.searchIndex = -1;
    } else if (options && options.resetIndex) {
      pane.searchIndex = 0;
    } else {
      pane.searchIndex = Math.max(0, Math.min(matches.length - 1, pane.searchIndex));
    }

    wrapPaneSearchMatches(matches, textMap.segments);
    updateCurrentSearchMatch(paneIndex);
    updatePaneSearchUI(paneEl, pane);
    if (matches.length && options && options.scroll) {
      window.requestAnimationFrame(() => scrollCurrentSearchMatch(paneIndex));
    }
  }

  function createPaneSearchTextMap(root) {
    let text = "";
    const segments = [];

    function appendSeparator() {
      if (!text || /\s$/.test(text)) return;
      text += "\n";
    }

    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = String(node.nodeValue || "");
        if (!value) return;
        const start = text.length;
        text += value;
        segments.push({ node, start, end: text.length, atomic: false, mathSource: "" });
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.classList.contains("fz-math")) {
        const block = node.classList.contains("fz-math-display");
        if (block) appendSeparator();
        const value = String(node.dataset.mathSearch || "");
        if (value) {
          const start = text.length;
          text += value;
          let mathSource = "";
          try {
            mathSource = decodeURIComponent(String(node.dataset.mathSource || ""));
          } catch (_) {}
          segments.push({ element: node, start, end: text.length, atomic: true, mathSource });
        }
        if (block) appendSeparator();
        return;
      }

      const tagName = node.tagName;
      if (["SCRIPT", "STYLE", "NOSCRIPT", "SVG"].includes(tagName)) return;
      if (tagName === "BR") {
        text += "\n";
        return;
      }
      const block = SEARCH_BLOCK_TAGS.has(tagName);
      if (block) appendSeparator();
      Array.from(node.childNodes).forEach(visit);
      if (block) appendSeparator();
    }

    visit(root);
    return { text, segments };
  }

  function findLiteralMatches(text, query) {
    const source = String(text == null ? "" : text);
    const needleSource = String(query == null ? "" : query);
    if (!needleSource.length) return [];
    const haystack = source.toLocaleLowerCase();
    const needle = needleSource.toLocaleLowerCase();
    if (!needle.length) return [];

    const matches = [];
    let offset = 0;
    while (offset <= haystack.length - needle.length) {
      const start = haystack.indexOf(needle, offset);
      if (start === -1) break;
      matches.push({ start, end: start + needle.length });
      offset = start + Math.max(1, needle.length);
    }
    return matches;
  }

  function findRawSourceMatches(rawText, sourceText) {
    const raw = String(rawText == null ? "" : rawText);
    const source = String(sourceText == null ? "" : sourceText);
    const direct = findLiteralMatches(raw, source);
    if (direct.length || !source) return direct;

    let normalized = "";
    const rawStarts = [];
    const rawEnds = [];
    for (let index = 0; index < raw.length;) {
      if (raw[index] === "\r" && raw[index + 1] === "\n") {
        normalized += "\n";
        rawStarts.push(index);
        rawEnds.push(index + 2);
        index += 2;
        continue;
      }
      if (raw[index] === "\r") {
        normalized += "\n";
        rawStarts.push(index);
        rawEnds.push(index + 1);
        index += 1;
        continue;
      }
      normalized += raw[index];
      rawStarts.push(index);
      rawEnds.push(index + 1);
      index += 1;
    }

    const normalizedSource = source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    return findLiteralMatches(normalized, normalizedSource).map((match) => ({
      start: rawStarts[match.start],
      end: rawEnds[Math.max(match.start, match.end - 1)]
    })).filter((match) => Number.isFinite(match.start) && Number.isFinite(match.end));
  }
  function wrapPaneSearchMatches(matches, segments) {
    const partsByNode = new Map();
    const matchesByMath = new Map();
    segments.forEach((segment) => {
      matches.forEach((match, matchIndex) => {
        if (match.end <= segment.start || match.start >= segment.end) return;
        if (segment.atomic) {
          if (!matchesByMath.has(segment.element)) matchesByMath.set(segment.element, new Set());
          matchesByMath.get(segment.element).add(matchIndex);
          return;
        }
        const start = Math.max(match.start, segment.start) - segment.start;
        const end = Math.min(match.end, segment.end) - segment.start;
        if (end <= start) return;
        if (!partsByNode.has(segment.node)) partsByNode.set(segment.node, []);
        partsByNode.get(segment.node).push({ start, end, matchIndex });
      });
    });

    partsByNode.forEach((parts, textNode) => {
      parts.sort((left, right) => right.start - left.start);
      parts.forEach((part) => {
        if (!textNode.parentNode || part.end > textNode.length) return;
        const matchingNode = textNode.splitText(part.start);
        matchingNode.splitText(part.end - part.start);
        const mark = document.createElement("mark");
        mark.className = "fz-search-hit";
        mark.dataset.searchMatch = String(part.matchIndex);
        matchingNode.parentNode.insertBefore(mark, matchingNode);
        mark.appendChild(matchingNode);
      });
    });

    matchesByMath.forEach((matchIndexes, element) => {
      element.classList.add("fz-search-hit");
      element.dataset.searchMatches = Array.from(matchIndexes).join(",");
    });
  }

  function clearSearchHighlights(contentEl) {
    if (!contentEl) return;
    const parents = new Set();
    contentEl.querySelectorAll("mark.fz-search-hit").forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parents.add(parent);
      const fragment = document.createDocumentFragment();
      while (mark.firstChild) fragment.appendChild(mark.firstChild);
      parent.replaceChild(fragment, mark);
    });
    parents.forEach((parent) => parent.normalize());
    contentEl.querySelectorAll(".fz-math.fz-search-hit").forEach((formula) => {
      formula.classList.remove("fz-search-hit", "fz-search-hit-current");
      formula.removeAttribute("data-search-matches");
    });
  }

  function navigatePaneSearch(paneIndex, direction) {
    const pane = state.panes[paneIndex];
    if (!pane || !pane.searchOpen) return;
    if (searchTimers[paneIndex]) {
      applyPaneSearch(paneIndex, { resetIndex: true, scroll: false });
    }
    if (!pane.searchCount) return;
    pane.searchIndex = (pane.searchIndex + direction + pane.searchCount) % pane.searchCount;
    updateCurrentSearchMatch(paneIndex);
    const paneEl = document.querySelector('[data-pane="' + paneIndex + '"]');
    if (paneEl) updatePaneSearchUI(paneEl, pane);
    scrollCurrentSearchMatch(paneIndex);
  }

  function updateCurrentSearchMatch(paneIndex) {
    const pane = state.panes[paneIndex];
    const paneEl = document.querySelector('[data-pane="' + paneIndex + '"]');
    if (!pane || !paneEl) return;
    paneEl.querySelectorAll("mark.fz-search-hit,.fz-math.fz-search-hit").forEach((node) => {
      node.classList.toggle("fz-search-hit-current", searchNodeHasMatch(node, pane.searchIndex));
    });
  }

  function searchNodeHasMatch(node, matchIndex) {
    if (node.matches("mark.fz-search-hit")) return Number(node.dataset.searchMatch) === matchIndex;
    return String(node.dataset.searchMatches || "")
      .split(",")
      .some((value) => Number(value) === matchIndex);
  }

  function scrollCurrentSearchMatch(paneIndex) {
    const pane = state.panes[paneIndex];
    const paneEl = document.querySelector('[data-pane="' + paneIndex + '"]');
    if (!pane || !paneEl || pane.searchIndex < 0) return;
    const contentEl = paneEl.querySelector(".fz-content");
    const marks = Array.from(
      paneEl.querySelectorAll("mark.fz-search-hit,.fz-math.fz-search-hit")
    ).filter((node) => searchNodeHasMatch(node, pane.searchIndex));
    if (!contentEl || !marks.length) return;

    const contentRect = contentEl.getBoundingClientRect();
    const rects = marks.map((mark) => mark.getBoundingClientRect()).filter((rect) => rect.width || rect.height);
    if (!rects.length) return;
    const top = Math.min(...rects.map((rect) => rect.top));
    const bottom = Math.max(...rects.map((rect) => rect.bottom));
    const fullyVisible = top >= contentRect.top + 2 && bottom <= contentRect.bottom - 2;
    if (fullyVisible) return;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    marks[0].scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "center",
      inline: "nearest"
    });
  }

  function handlePaneSearchKeydown(event) {
    const isFindShortcut = (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      String(event.key || "").toLowerCase() === "f";
    if (isFindShortcut) {
      if (event.target.closest(".fz-type-editor")) return false;
      const pane = state.panes[state.activePane];
      if (!canSearchPane(pane)) return false;
      event.preventDefault();
      event.stopPropagation();
      openPaneSearch(state.activePane, { selectQuery: true });
      return true;
    }

    const input = event.target.closest(".fz-search-input");
    if (input && event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      const paneEl = input.closest(".fz-pane");
      if (paneEl) navigatePaneSearch(Number(paneEl.dataset.pane), event.shiftKey ? -1 : 1);
      return true;
    }

    if (event.key === "Escape" && state.panes.some((pane) => pane.searchOpen)) {
      event.preventDefault();
      closeAllPaneSearch({ restoreFocus: true });
      return true;
    }
    return false;
  }

  function captureTypingPosition(paneIndex) {
    if (searchTimers[paneIndex]) applyPaneSearch(paneIndex, { resetIndex: true, scroll: false });
    const pane = state.panes[paneIndex];
    const paneEl = document.querySelector('[data-pane="' + paneIndex + '"]');
    const contentEl = paneEl && paneEl.querySelector(".fz-content");
    const maximumScroll = contentEl ? Math.max(0, contentEl.scrollHeight - contentEl.clientHeight) : 0;
    const scrollRatio = maximumScroll > 0 ? contentEl.scrollTop / maximumScroll : 0;
    const anchor = {
      query: "",
      rawOffset: null,
      rawLength: 0,
      scrollRatio: Math.max(0, Math.min(1, scrollRatio))
    };
    if (!pane || !pane.searchOpen || !pane.searchQuery || pane.searchIndex < 0) return anchor;

    const selectedMatch = pane.searchOffsets[pane.searchIndex];
    const visibleOffset = Number.isFinite(selectedMatch)
      ? selectedMatch
      : selectedMatch && Number(selectedMatch.start);
    const visibleRatio = Number.isFinite(visibleOffset) && pane.searchTextLength > 0
      ? visibleOffset / pane.searchTextLength
      : anchor.scrollRatio;
    const rawText = String(pane.text == null ? "" : pane.text);
    const mathSource = selectedMatch && typeof selectedMatch === "object"
      ? String(selectedMatch.mathSource || "")
      : "";
    const rawNeedle = mathSource || pane.searchQuery;
    const rawMatches = mathSource ? findRawSourceMatches(rawText, rawNeedle) : findLiteralMatches(rawText, rawNeedle);
    if (rawMatches.length) {
      const nearest = rawMatches.reduce((best, match) => {
        const distance = Math.abs(match.start / Math.max(1, rawText.length) - visibleRatio);
        return !best || distance < best.distance ? { match, distance } : best;
      }, null);
      if (nearest) {
        anchor.query = mathSource ? "" : pane.searchQuery;
        anchor.rawOffset = normalizeTextareaText(rawText.slice(0, nearest.match.start)).length;
        anchor.rawLength = normalizeTextareaText(rawText.slice(nearest.match.start, nearest.match.end)).length;
      }
    }
    return anchor;
  }

  function normalizeTextareaText(value) {
    return String(value == null ? "" : value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }
  function restoreTypingEditorPosition(editor, anchor) {
    if (!editor || !anchor) return;
    const value = String(editor.value || "");
    const hasRawOffset = Number.isFinite(anchor.rawOffset);
    let caret = hasRawOffset
      ? anchor.rawOffset + (Number(anchor.rawLength) || String(anchor.query || "").length)
      : Math.round(value.length * Math.max(0, Math.min(1, Number(anchor.scrollRatio) || 0)));
    caret = Math.max(0, Math.min(value.length, caret));
    if (caret > 0 && /[\uDC00-\uDFFF]/.test(value.charAt(caret))) caret -= 1;

    try {
      editor.focus({ preventScroll: true });
    } catch (_) {
      editor.focus();
    }
    editor.setSelectionRange(caret, caret);

    window.requestAnimationFrame(() => {
      const maximumScroll = Math.max(0, editor.scrollHeight - editor.clientHeight);
      if (!maximumScroll) return;
      if (hasRawOffset) {
        const caretTop = measureTextareaCaretTop(editor, caret);
        editor.scrollTop = Math.max(0, Math.min(maximumScroll, caretTop - editor.clientHeight * 0.38));
      } else {
        editor.scrollTop = Math.max(0, Math.min(maximumScroll, maximumScroll * (Number(anchor.scrollRatio) || 0)));
      }
    });
  }

  function measureTextareaCaretTop(editor, offset) {
    const styles = window.getComputedStyle(editor);
    const mirror = document.createElement("div");
    const marker = document.createElement("span");
    Object.assign(mirror.style, {
      position: "fixed",
      top: "0",
      left: "-100000px",
      visibility: "hidden",
      boxSizing: styles.boxSizing,
      width: editor.clientWidth + "px",
      minHeight: "0",
      paddingTop: styles.paddingTop,
      paddingRight: styles.paddingRight,
      paddingBottom: styles.paddingBottom,
      paddingLeft: styles.paddingLeft,
      borderTopWidth: styles.borderTopWidth,
      borderRightWidth: styles.borderRightWidth,
      borderBottomWidth: styles.borderBottomWidth,
      borderLeftWidth: styles.borderLeftWidth,
      borderStyle: "solid",
      fontFamily: styles.fontFamily,
      fontSize: styles.fontSize,
      fontWeight: styles.fontWeight,
      fontStyle: styles.fontStyle,
      lineHeight: styles.lineHeight,
      letterSpacing: styles.letterSpacing,
      whiteSpace: "pre-wrap",
      overflowWrap: styles.overflowWrap,
      wordBreak: styles.wordBreak,
      tabSize: styles.tabSize
    });
    mirror.appendChild(document.createTextNode(String(editor.value || "").slice(0, offset)));
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const top = marker.offsetTop;
    mirror.remove();
    return top;
  }
  function handlePaneFocusIn(event) {
    const paneEl = event.target.closest && event.target.closest(".fz-pane");
    if (!paneEl) return;
    const paneIndex = Number(paneEl.dataset.pane);
    if (!Number.isFinite(paneIndex) || paneIndex === state.activePane) return;
    closeAllPaneSearch({ restoreFocus: false });
    state.activePane = paneIndex;
    renderChrome();
  }
  function handleTooltipPointerOver(event) {
    const target = event.target.closest && event.target.closest("[data-tooltip]");
    if (!target || target.disabled || (event.relatedTarget && target.contains(event.relatedTarget))) return;
    scheduleTooltip(target, 250);
  }

  function handleTooltipPointerOut(event) {
    const target = event.target.closest && event.target.closest("[data-tooltip]");
    if (!target || (event.relatedTarget && target.contains(event.relatedTarget))) return;
    if (target === tooltipTarget) hideTooltip();
  }

  function handleTooltipFocusIn(event) {
    const target = event.target.closest && event.target.closest("[data-tooltip]");
    if (target && !target.disabled) scheduleTooltip(target, 80);
  }

  function handleTooltipFocusOut(event) {
    const target = event.target.closest && event.target.closest("[data-tooltip]");
    if (target && target === tooltipTarget) hideTooltip();
  }

  function scheduleTooltip(target, delay) {
    hideTooltip();
    const label = String(target.dataset.tooltip || "").trim();
    if (!label) return;
    tooltipTarget = target;
    tooltipTimer = window.setTimeout(() => showTooltip(target, label), delay);
  }

  function showTooltip(target, label) {
    if (!target.isConnected || target.disabled || target !== tooltipTarget) return;
    tooltipEl.textContent = label;
    tooltipEl.hidden = false;
    tooltipEl.style.visibility = "hidden";
    tooltipEl.style.left = "0";
    tooltipEl.style.top = "0";

    const targetRect = target.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();
    const viewportPadding = 6;
    const gap = 8;
    const canShowBelow = targetRect.bottom + gap + tooltipRect.height <= window.innerHeight - viewportPadding;
    const showBelow = canShowBelow || targetRect.top < tooltipRect.height + gap + viewportPadding;
    const targetCenter = targetRect.left + targetRect.width / 2;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - tooltipRect.width - viewportPadding);
    const left = Math.min(maxLeft, Math.max(viewportPadding, targetCenter - tooltipRect.width / 2));
    const rawTop = showBelow ? targetRect.bottom + gap : targetRect.top - tooltipRect.height - gap;
    const top = Math.min(
      Math.max(viewportPadding, rawTop),
      Math.max(viewportPadding, window.innerHeight - tooltipRect.height - viewportPadding)
    );
    const arrowX = Math.min(tooltipRect.width - 10, Math.max(10, targetCenter - left));

    tooltipEl.dataset.placement = showBelow ? "bottom" : "top";
    tooltipEl.style.left = `${Math.round(left)}px`;
    tooltipEl.style.top = `${Math.round(top)}px`;
    tooltipEl.style.setProperty("--fz-tooltip-arrow-x", `${Math.round(arrowX)}px`);
    tooltipEl.style.visibility = "visible";
  }

  function hideTooltip() {
    if (tooltipTimer) window.clearTimeout(tooltipTimer);
    tooltipTimer = 0;
    tooltipTarget = null;
    tooltipEl.hidden = true;
    tooltipEl.style.visibility = "hidden";
  }
  function toggleModeMenu(paneEl, focusSelected) {
    const menu = paneEl && paneEl.querySelector("[data-mode-menu]");
    if (!menu) return;
    if (menu.hidden) {
      openModeMenu(paneEl, focusSelected);
    } else {
      closeModeMenu(paneEl, false);
    }
  }

  function openModeMenu(paneEl, focusSelected) {
    const trigger = paneEl && paneEl.querySelector("[data-mode-trigger]");
    const menu = paneEl && paneEl.querySelector("[data-mode-menu]");
    if (!trigger || !menu || trigger.disabled) return;
    closeAllModeMenus(paneEl);
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    paneEl.querySelector(".fz-view-mode")?.classList.add("fz-open");
    if (focusSelected) {
      const selected = menu.querySelector('[role="option"][aria-selected="true"]') || menu.querySelector('[role="option"]');
      selected?.focus();
    }
  }

  function closeModeMenu(paneEl, restoreFocus) {
    const trigger = paneEl && paneEl.querySelector("[data-mode-trigger]");
    const menu = paneEl && paneEl.querySelector("[data-mode-menu]");
    if (!trigger || !menu) return;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    paneEl.querySelector(".fz-view-mode")?.classList.remove("fz-open");
    if (restoreFocus) trigger.focus();
  }

  function closeAllModeMenus(exceptPaneEl) {
    document.querySelectorAll(".fz-pane").forEach((paneEl) => {
      if (paneEl !== exceptPaneEl) closeModeMenu(paneEl, false);
    });
  }

  function handleModeMenuKeydown(event) {
    const trigger = event.target.closest("[data-mode-trigger]");
    if (trigger) {
      const paneEl = trigger.closest(".fz-pane");
      if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        openModeMenu(paneEl, true);
        return true;
      }
      if (event.key === "Escape") {
        closeModeMenu(paneEl, false);
        return true;
      }
      return false;
    }

    const option = event.target.closest('[data-mode-menu] [role="option"]');
    if (!option) {
      if (event.key === "Escape") closeAllModeMenus();
      return false;
    }
    const paneEl = option.closest(".fz-pane");
    const options = Array.from(paneEl.querySelectorAll('[data-mode-menu] [role="option"]'));
    const currentIndex = options.indexOf(option);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      let nextIndex = currentIndex;
      if (event.key === "ArrowDown") nextIndex = (currentIndex + 1) % options.length;
      if (event.key === "ArrowUp") nextIndex = (currentIndex - 1 + options.length) % options.length;
      if (event.key === "Home") nextIndex = 0;
      if (event.key === "End") nextIndex = options.length - 1;
      options[nextIndex]?.focus();
      return true;
    }
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      option.click();
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeModeMenu(paneEl, true);
      return true;
    }
    if (event.key === "Tab") closeModeMenu(paneEl, false);
    return false;
  }

  function handleSplitterKeydown(event) {
    if (state.split === "single") return false;
    const decreasingKey = state.split === "vertical" ? "ArrowLeft" : "ArrowUp";
    const increasingKey = state.split === "vertical" ? "ArrowRight" : "ArrowDown";
    if (![decreasingKey, increasingKey, "Home", "End"].includes(event.key)) return false;
    closeAllPaneSearch({ restoreFocus: false });
    event.preventDefault();
    const [minimum, maximum] = getSplitRatioBounds();
    if (event.key === "Home") state.splitRatio = minimum;
    else if (event.key === "End") state.splitRatio = maximum;
    else state.splitRatio = clampSplitRatio(state.splitRatio + (event.key === increasingKey ? 5 : -5));
    renderChrome();
    return true;
  }

  function getSplitRatioBounds() {
    if (state.split === "single") return [50, 50];
    const styles = window.getComputedStyle(panesEl);
    const vertical = state.split === "vertical";
    const axisSize = vertical ? panesEl.clientWidth : panesEl.clientHeight;
    const paddingStart = Number.parseFloat(vertical ? styles.paddingLeft : styles.paddingTop) || 0;
    const paddingEnd = Number.parseFloat(vertical ? styles.paddingRight : styles.paddingBottom) || 0;
    const splitterSize = 6;
    const available = Math.max(1, axisSize - paddingStart - paddingEnd - splitterSize);
    const desiredPaneSize = vertical
      ? (window.matchMedia("(max-width: 380px)").matches ? 156 : 162)
      : 72;
    const minimum = Math.min(50, Math.max(10, (desiredPaneSize / available) * 100));
    return [minimum, 100 - minimum];
  }

  function clampSplitRatio(value) {
    const [minimum, maximum] = getSplitRatioBounds();
    return Math.max(minimum, Math.min(maximum, Number(value) || 50));
  }
  splitterEl.addEventListener("pointerdown", startSplitResize);

  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (!isRoutedForThisPanel(message)) return;

    if (message.type === "FZ_PANEL_SCOPE_CHANGED") {
      updatePanelScope(message);
      return;
    }

    if (message.type === "FZ_CAPTURE_DEBUG") {
      pushDebugLog(message.debug || {});
      return;
    }

    if (message.type === "FZ_CAPTURE_EMPTY") {
      showToast(message.reason || "本次点击未读取到单元格内容。");
      return;
    }

    if (message.type === "FZ_CAPTURE_ERROR") {
      const errText = message.error && message.error.message ? message.error.message : "未知错误";
      showToast(`读取出错：${errText}`);
      return;
    }

    if (message.type === "FZ_CAPTURE_BLOCKED") {
      showToast("当前页面返回了权限提示文本，已忽略该结果。");
      return;
    }

    if (message.type !== "FZ_CELL_SELECTED") return;
    handleCellSelection(message);
  });

  renderAll();
  initPanelScope().then(() => requestInitialCapture()).catch(() => requestInitialCapture());

  function pushDebugLog(log) {
    const normalized = normalizeDebugLog(log);
    state.debug.logs.unshift(normalized);
    if (state.debug.logs.length > MAX_DEBUG_LOGS) {
      state.debug.logs.length = MAX_DEBUG_LOGS;
    }

    const isWriteFailure = normalized.debugType === "write" &&
      normalized.finalResult &&
      normalized.finalResult.status === "error";
    if (isWriteFailure) {
      state.debug.alert = true;
    }
    renderDebug();
  }

  function normalizeDebugLog(log) {
    const attempts = Array.isArray(log.attempts) ? log.attempts : [];
    return {
      sessionId: log.sessionId || "",
      url: log.url || "",
      clickTarget: log.clickTarget || {},
      startedAt: log.startedAt || "",
      endedAt: log.endedAt || "",
      durationMs: Number.isFinite(log.durationMs) ? log.durationMs : 0,
      writeRequest: log.writeRequest && typeof log.writeRequest === "object" ? log.writeRequest : null,
      attempts: attempts.map((item) => ({
        step: Number(item.step || 0),
        stage: item.stage || "",
        source: item.source || "",
        elapsedMs: Number(item.elapsedMs || 0),
        hit: Boolean(item.hit),
        reason: item.reason || "",
        candidateLength: Number(item.candidateLength || 0),
        candidateSample: item.candidateSample || "",
        details: item.details == null ? null : item.details
      })),
      finalResult: {
        status: log.finalResult && log.finalResult.status ? log.finalResult.status : "unknown",
        chosenSource: log.finalResult && log.finalResult.chosenSource ? log.finalResult.chosenSource : "",
        reason: log.finalResult && log.finalResult.reason ? log.finalResult.reason : ""
      },
      writePerformance: log.writePerformance && typeof log.writePerformance === "object" ? log.writePerformance : null,
      debugType: log.writeRequest ? "write" : "capture"
    };
  }

  function copyLatestDebug() {
    const log = getPreferredDebugLog();
    if (!log) {
      showToast("暂无可复制的调试信息");
      return;
    }

    const payload = JSON.stringify(buildDebugReport(log), null, 2);
    navigator.clipboard.writeText(payload).then(() => {
      showToast("已复制本次键入调试报告");
    }).catch(() => {
      showToast("复制失败，请检查浏览器剪贴板权限");
    });
  }

  function getPreferredDebugLog() {
    const latestWrite = state.debug.logs.find((log) => log && log.debugType === "write");
    return latestWrite || state.debug.logs[0] || null;
  }

  function buildDebugReport(log) {
    const attempts = Array.isArray(log && log.attempts) ? log.attempts : [];
    const failedAttempt = attempts.slice().reverse().find((attempt) => attempt && !attempt.hit) || null;
    const manifest = chrome.runtime && typeof chrome.runtime.getManifest === "function"
      ? chrome.runtime.getManifest()
      : {};
    return {
      reportType: "CellPeek write diagnostic",
      reportVersion: 2,
      extensionVersion: manifest.version || "",
      generatedAt: new Date().toISOString(),
      diagnosis: {
        finalReason: log && log.finalResult ? log.finalResult.reason : "",
        failedStage: failedAttempt ? failedAttempt.stage : "",
        failedStageReason: failedAttempt ? failedAttempt.reason : "",
        instruction: "请将此 JSON 完整粘贴给 Codex"
      },
      log
    };
  }

  async function copyPaneContent(paneIndex) {
    const pane = state.panes[paneIndex];
    if (!pane) return;

    const text = pane.editing ? pane.draft : pane.text;
    if (!String(text == null ? "" : text).length) {
      showToast("暂无可复制的展示内容");
      return;
    }

    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      showToast("复制失败，当前浏览器不支持剪贴板");
      return;
    }

    try {
      await navigator.clipboard.writeText(String(text));
      showToast("已复制");
    } catch (_) {
      showToast("复制失败，请检查浏览器剪贴板权限");
    }
  }

  function canRevealPaneCell(pane) {
    if (!pane || pane.revealing || pane.writing) return false;
    if (pane.editing && ["waiting", "confirming"].includes(pane.relocationStatus)) return false;
    const target = pane.cellTarget;
    const address = normalizeCellAddress(pane.cellAddress || target && target.address);
    const tabId = toFiniteNumber(target && target.tabId != null ? target.tabId : pane.cellTabId);
    return Boolean(target && address && tabId);
  }

  async function revealPaneCell(paneIndex) {
    const pane = state.panes[paneIndex];
    const paneEl = document.querySelector(`[data-pane="${paneIndex}"]`);
    if (!pane || !paneEl || !canRevealPaneCell(pane)) return;

    state.activePane = paneIndex;
    renderChrome();

    const target = cloneCellTarget(pane.cellTarget);
    target.address = normalizeCellAddress(pane.cellAddress || target.address);
    target.tabId = toFiniteNumber(target.tabId != null ? target.tabId : pane.cellTabId);
    target.windowId = toFiniteNumber(target.windowId != null ? target.windowId : pane.cellWindowId);
    target.frameId = toFiniteNumber(target.frameId != null ? target.frameId : pane.cellFrameId);

    pane.revealing = true;
    pane.revealSelectionGuard = {
      expiresAt: Date.now() + 5000,
      address: target.address,
      tabId: target.tabId,
      sheetId: String(target.sheetId || ""),
      spreadsheetToken: String(target.spreadsheetToken || "")
    };
    updatePaneMeta(paneEl, pane);

    const response = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({
          type: "FZ_REVEAL_CELL",
          tabId: target.tabId,
          windowId: target.windowId,
          frameId: target.frameId,
          cellAddress: target.address,
          targetSnapshot: target
        }, (value) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, reason: "REVEAL_MESSAGE_FAILED" });
            return;
          }
          resolve(value || { ok: false, reason: "REVEAL_EMPTY_RESPONSE" });
        });
      } catch (_) {
        resolve({ ok: false, reason: "REVEAL_MESSAGE_FAILED" });
      }
    });

    pane.revealing = false;
    if (!response || !response.ok) {
      if (pane.revealSelectionGuard) pane.revealSelectionGuard.expiresAt = Date.now() + 900;
      showToast(formatRevealCellFailure(response && response.reason, target.address));
    }
    updatePaneMeta(paneEl, pane);
  }

  function formatRevealCellFailure(reason, address) {
    switch (String(reason || "")) {
      case "SOURCE_TAB_UNAVAILABLE": return "来源标签页已关闭";
      case "SOURCE_TAB_NAVIGATED": return "来源标签页已跳转";
      case "SOURCE_SHEET_UNAVAILABLE": return "来源工作表不可用";
      case "CONTENT_SCRIPT_NOT_READY": return "表格页面尚未准备好";
      case "INVALID_TARGET_ADDRESS":
      case "invalid_target_address": return "单元格地址无效";
      case "address_control_not_found": return "未找到飞书地址定位框";
      case "address_control_not_editable": return "飞书地址定位框不可用";
      default: return `无法定位到 ${address || "该单元格"}`;
    }
  }

  function isRecentRevealSelectionEcho(message) {
    const now = Date.now();
    const messageAddress = normalizeCellAddress(message && message.cellAddress);
    const messageTabId = toFiniteNumber(message && message.tabId);
    const messageSheetId = String(message && message.sheetId || "");
    const messageSpreadsheetToken = String(message && message.spreadsheetToken || "");

    return state.panes.some((pane) => {
      const guard = pane && pane.revealSelectionGuard;
      if (!guard) return false;
      if (guard.expiresAt <= now) {
        pane.revealSelectionGuard = null;
        return false;
      }
      if (!guard.address || guard.address !== messageAddress) return false;
      if (guard.tabId && messageTabId && guard.tabId !== messageTabId) return false;
      if (guard.sheetId && messageSheetId && guard.sheetId !== messageSheetId) return false;
      if (guard.spreadsheetToken && messageSpreadsheetToken &&
        guard.spreadsheetToken !== messageSpreadsheetToken) return false;
      return true;
    });
  }
  function handleCellSelection(message) {
    if (state.panes.some((pane) => pane && pane.writing)) return;
    if (isRecentWriteEcho(message)) return;
    if (isRecentRevealSelectionEcho(message)) return;
    state.panes.forEach((pane) => {
      if (pane) pane.revealSelectionGuard = null;
    });
    closeAllPaneSearch({ restoreFocus: false });

    const relocationPaneIndex = findRelocationPaneIndex(message);
    if (relocationPaneIndex !== -1) {
      setRelocationCandidate(relocationPaneIndex, message);
      return;
    }

    writeToActivePane(
      message.text || "",
      message.source || "点击的单元格",
      message.cellContext || null,
      message.cellAddress || "",
      {
        tabId: message.tabId,
        windowId: message.windowId,
        frameId: message.frameId,
        tabUrl: message.tabUrl || "",
        pageUrl: message.pageUrl || "",
        sheetId: message.sheetId || "",
        cellAccessMode: message.cellAccessMode || "unknown",
        spreadsheetToken: message.spreadsheetToken || "",
        targetSnapshot: message.targetSnapshot || null
      }
    );
  }

  function isRecentWriteEcho(message) {
    const now = Date.now();
    const messageAddress = normalizeCellAddress(message && message.cellAddress);
    const messageText = normalizeWriteText(message && message.text);
    const messageTabId = toFiniteNumber(message && message.tabId);
    const messageSheetId = String(message && message.sheetId || "");
    const messageSpreadsheetToken = String(message && message.spreadsheetToken || "");

    return state.panes.some((pane) => {
      const guard = pane && pane.writeEchoGuard;
      if (!guard) return false;
      if (guard.expiresAt <= now) {
        pane.writeEchoGuard = null;
        return false;
      }
      if (!guard.address || messageAddress !== guard.address || messageText !== guard.text) return false;
      if (guard.tabId && messageTabId && guard.tabId !== messageTabId) return false;
      if (guard.sheetId && messageSheetId && guard.sheetId !== messageSheetId) return false;
      if (guard.spreadsheetToken && messageSpreadsheetToken &&
        guard.spreadsheetToken !== messageSpreadsheetToken) return false;
      return true;
    });
  }

  function rememberWriteEcho(pane, target, text) {
    if (!pane || !target) return;
    pane.writeEchoGuard = {
      expiresAt: Date.now() + 3000,
      text: normalizeWriteText(text),
      address: normalizeCellAddress(target.address),
      tabId: toFiniteNumber(target.tabId),
      sheetId: String(target.sheetId || ""),
      spreadsheetToken: String(target.spreadsheetToken || "")
    };
  }

  function findRelocationPaneIndex(message) {
    const candidates = state.panes
      .map((pane, index) => ({ pane, index }))
      .filter(({ pane }) => pane && pane.editing && ["waiting", "confirming"].includes(pane.relocationStatus));
    const active = candidates.find(({ index }) => index === state.activePane);
    return active ? active.index : (candidates.length ? candidates[0].index : -1);
  }

  function setRelocationCandidate(paneIndex, message) {
    const pane = state.panes[paneIndex];
    if (!pane || !pane.editing) return;
    const target = createCellTarget(
      message.text || "",
      message.cellContext || null,
      message.cellAddress || "",
      {
        tabId: message.tabId,
        windowId: message.windowId,
        frameId: message.frameId,
        tabUrl: message.tabUrl || "",
        pageUrl: message.pageUrl || "",
        sheetId: message.sheetId || "",
        spreadsheetToken: message.spreadsheetToken || "",
        targetSnapshot: message.targetSnapshot || null
      }
    );
    if (!target.address) return;
    const expectedTarget = pane.editTarget || pane.cellTarget;
    if (expectedTarget && expectedTarget.spreadsheetToken && target.spreadsheetToken &&
      expectedTarget.spreadsheetToken !== target.spreadsheetToken) {
      return;
    }
    if (expectedTarget && expectedTarget.tabUrl && target.tabUrl &&
      !isSameSourceDocument(expectedTarget.tabUrl, target.tabUrl)) {
      return;
    }
    if (expectedTarget && expectedTarget.sheetId && target.sheetId &&
      expectedTarget.sheetId !== target.sheetId) {
      return;
    }
    pane.relocationCandidate = target;
    pane.relocationStatus = "confirming";
    state.activePane = paneIndex;
    renderChrome();
    renderPane(paneIndex, { preserveScroll: true });
  }

  function writeToActivePane(text, source, cellContext, cellAddress, scope) {
    const paneIndex = getWritablePaneIndex();
    if (paneIndex === -1) {
      if (state.panes.some((pane) => pane && pane.editing)) return;
      showToast("两个分栏都已锁定");
      return;
    }

    state.activePane = paneIndex;
    const pane = state.panes[paneIndex];
    if (pane.editing) exitTypingMode(paneIndex);
    pane.writeEchoGuard = null;
    pane.text = text;
    pane.source = source;
    pane.cellContext = normalizePanelCellContext(cellContext);
    pane.cellAddress = normalizeCellAddress(cellAddress);
    pane.cellTabId = toFiniteNumber(scope && scope.tabId);
    pane.cellWindowId = toFiniteNumber(scope && scope.windowId);
    pane.cellFrameId = toFiniteNumber(scope && scope.frameId);
    pane.cellTarget = createCellTarget(text, cellContext, cellAddress, scope);
    pane.cellAccessMode = normalizeCellAccessMode(pane.cellTarget && pane.cellTarget.cellAccessMode);
    updatePanelScope(scope);
    renderChrome();
    renderPane(paneIndex, { preserveScroll: false });
    renderDebug();
  }

  function beginTypingMode(paneIndex) {
    const pane = state.panes[paneIndex];
    if (!pane) return;
    if (normalizeCellAccessMode(pane.cellAccessMode) === "read-only") {
      showToast("当前单元格为只读，无法键入");
      return;
    }
    const typingAnchor = captureTypingPosition(paneIndex);
    closeAllPaneSearch({ restoreFocus: false });
    const context = normalizePanelCellContext(pane.cellContext);
    const address = normalizeCellAddress(pane.cellAddress || pane.cellTarget && pane.cellTarget.address);
    if (!isValidFrameId(pane.cellFrameId) || !pane.cellTarget || !address) {
      showToast("请先展示一个具有明确地址的单元格后再键入");
      return;
    }

    const editMode = resolveDisplayKind(pane.text || "", pane.mode);
    pane.editing = true;
    pane.writing = false;
    pane.editMode = editMode;
    pane.draft = editMode === "json" ? formatJsonDraft(pane.text || "") : (pane.text || "");
    pane.draftBaseText = pane.text || "";
    pane.editContext = context;
    pane.editAddress = address;
    pane.editTabId = pane.cellTabId;
    pane.editWindowId = pane.cellWindowId;
    pane.editFrameId = pane.cellFrameId;
    pane.editTarget = cloneCellTarget(pane.cellTarget);
    pane.relocationStatus = "idle";
    pane.relocationCandidate = null;
    pane.confirmDiscard = false;
    state.activePane = paneIndex;
    renderChrome();
    renderPane(paneIndex, { preserveScroll: false, focusEditor: true, typingAnchor });
  }

  function exitTypingMode(paneIndex) {
    const pane = state.panes[paneIndex];
    if (!pane || !pane.editing) return;
    pane.editing = false;
    pane.writing = false;
    pane.editMode = "text";
    pane.mode = "auto";
    pane.draft = "";
    pane.draftBaseText = "";
    pane.editContext = null;
    pane.editAddress = "";
    pane.editTabId = null;
    pane.editWindowId = null;
    pane.editFrameId = null;
    pane.editTarget = null;
    pane.relocationStatus = "idle";
    pane.relocationCandidate = null;
    pane.confirmDiscard = false;
  }

  function requestDiscardTyping(paneIndex) {
    const pane = state.panes[paneIndex];
    if (!pane || !pane.editing) return;
    if (normalizeWriteText(pane.draft) === normalizeWriteText(pane.draftBaseText)) {
      discardTypingMode(paneIndex);
      return;
    }
    pane.confirmDiscard = true;
    renderPane(paneIndex, { preserveScroll: true });
  }

  function discardTypingMode(paneIndex) {
    const pane = state.panes[paneIndex];
    if (!pane || !pane.editing) return;
    exitTypingMode(paneIndex);
    state.activePane = paneIndex;
    renderChrome();
    renderPane(paneIndex, { preserveScroll: false });
    showToast("已放弃草稿");
  }

  function hasActiveDraft() {
    return state.panes.some((pane) => pane && pane.editing);
  }


  function confirmRelocationCandidate(paneIndex) {
    const pane = state.panes[paneIndex];
    const candidate = pane && pane.relocationCandidate;
    if (!pane || !pane.editing || !candidate) return;
    if (normalizeCellAccessMode(candidate.cellAccessMode) === "read-only") {
      showToast("候选单元格为只读，无法设为写回目标");
      return;
    }
    pane.editTarget = cloneCellTarget(candidate);
    pane.editContext = normalizePanelCellContext(candidate.context);
    pane.editAddress = candidate.address || "";
    pane.editTabId = candidate.tabId;
    pane.editWindowId = candidate.windowId;
    pane.editFrameId = candidate.frameId;
    pane.draftBaseText = candidate.text || "";
    pane.relocationCandidate = null;
    pane.relocationStatus = "idle";
    completeTypingMode(paneIndex);
  }

  async function completeTypingMode(paneIndex) {
    const pane = state.panes[paneIndex];
    if (!pane || !pane.editing || pane.writing) return;
    if (normalizeCellAccessMode(pane.editTarget && pane.editTarget.cellAccessMode) === "read-only") {
      showToast("当前写回目标为只读，无法完成键入");
      return;
    }
    if (pane.confirmDiscard) {
      showToast("请先处理放弃草稿确认");
      return;
    }
    if (pane.relocationStatus !== "idle") {
      showToast(pane.relocationStatus === "confirming" ? "请先确认重新定位的单元格" : "请重新点击目标单元格定位");
      return;
    }
    if (!pane.editTarget || !normalizeCellAddress(pane.editAddress || pane.editTarget.address) ||
      !isValidFrameId(pane.editFrameId)) {
      showToast("缺少明确的单元格地址，请重新展示目标单元格");
      return;
    }

    if (pane.editMode === "json") {
      const jsonDraft = getJsonDraftValidation(pane.draft);
      if (!jsonDraft.ok) {
        renderPane(paneIndex, { preserveScroll: true, focusEditor: true });
        showToast("JSON 无效，请修正后再完成");
        return;
      }
      pane.draft = jsonDraft.formatted;
    }
    pane.writing = true;
    renderPane(paneIndex, { preserveScroll: true });

    const shouldPrimeClipboard = normalizeWriteText(pane.draft) !== "";
    const clipboardPrime = shouldPrimeClipboard
      ? await prepareClipboardForWrite(pane.draft)
      : { ok: false, reason: "skip_empty_write", textLength: 0 };
    const payload = {
      type: "FZ_WRITE_CELL",
      text: pane.draft,
      cellContext: pane.editContext,
      cellAddress: pane.editAddress,
      targetSnapshot: cloneCellTarget(pane.editTarget),
      expectedText: pane.draftBaseText,
      writeTargetMode: "typing_snapshot",
      displayContext: pane.cellContext || null,
      displayCellAddress: pane.cellAddress || "",
      typingSnapshotContext: pane.editContext || null,
      typingSnapshotAddress: pane.editAddress || "",
      paneLocked: Boolean(pane.locked),
      tabId: pane.editTarget.tabId || pane.editTabId || null,
      windowId: pane.editTarget.windowId || pane.editWindowId || null,
      frameId: pane.editFrameId == null ? null : pane.editFrameId,
      paneIndex,
      clipboardPrimed: shouldPrimeClipboard && Boolean(clipboardPrime.ok),
      clipboardPrime
    };

    let result;
    try {
      result = chrome.runtime.sendMessage(payload, (response) => {
        const error = chrome.runtime.lastError;
        handleWriteResponse(paneIndex, error ? { ok: false, reason: error.message } : response);
      });
      if (result && typeof result.catch === "function") {
        result.then((response) => handleWriteResponse(paneIndex, response)).catch((error) => {
          handleWriteResponse(paneIndex, { ok: false, reason: error && error.message ? error.message : "WRITE_MESSAGE_FAILED" });
        });
      }
    } catch (error) {
      handleWriteResponse(paneIndex, { ok: false, reason: error && error.message ? error.message : "WRITE_MESSAGE_FAILED" });
    }
  }

  function handleWriteResponse(paneIndex, response) {
    const pane = state.panes[paneIndex];
    if (!pane) return;
    if (!pane.editing && !pane.writing) return;
    if (!response || !response.ok) {
      pane.writing = false;
      const reason = response && response.reason ? response.reason : "UNKNOWN";
      if ([
        "TARGET_MISMATCH",
        "TARGET_NOT_FOUND",
        "TARGET_ADDRESS_UNAVAILABLE",
        "TARGET_SELECTION_UNVERIFIED",
        "FORMULA_EDITOR_NOT_FOUND",
        "FORMULA_EDITOR_WRITE_FAILED",
        "FORMULA_EDITOR_COMMIT_FAILED",
        "WRITE_NOT_PERSISTED"
      ].includes(reason)) {
        pane.relocationStatus = "waiting";
        pane.relocationCandidate = null;
        renderPane(paneIndex, { preserveScroll: true, focusEditor: true });
        showToast(reason === "WRITE_NOT_PERSISTED"
          ? "未能确认内容已写回，草稿已保留。请重新点击目标单元格定位。"
          : TARGET_MISMATCH_MESSAGE);
        return;
      }
      if (reason === "WRITE_CONFLICT") {
        pane.relocationStatus = "waiting";
        pane.relocationCandidate = null;
        renderPane(paneIndex, { preserveScroll: true, focusEditor: true });
        showToast(WRITE_CONFLICT_MESSAGE);
        return;
      }
      if (reason === "SOURCE_SHEET_UNAVAILABLE") {
        pane.relocationStatus = "waiting";
        pane.relocationCandidate = null;
        renderPane(paneIndex, { preserveScroll: true, focusEditor: true });
        showToast("无法自动切回来源工作表，请打开来源工作表并点击目标单元格定位。");
        return;
      }
      if (["SOURCE_TAB_UNAVAILABLE", "SOURCE_TAB_NAVIGATED"].includes(reason)) {
        pane.relocationStatus = "waiting";
        pane.relocationCandidate = null;
        renderPane(paneIndex, { preserveScroll: true, focusEditor: true });
        showToast("原表格标签页已关闭或发生跳转，请重新打开表格并点击目标单元格定位。");
        return;
      }
      renderPane(paneIndex, { preserveScroll: true, focusEditor: true });
      showToast(`写入失败：${reason}`);
      return;
    }

    pane.text = pane.draft;
    pane.jsonExpanded = {};
    pane.jsonModel = null;
    pane.jsonSearchExpansionSnapshot = null;
    pane.mode = "auto";
    const resolvedTarget = response.targetSnapshot
      ? createCellTarget(pane.draft, response.targetSnapshot.context, response.targetSnapshot.address, response.targetSnapshot)
      : {
        ...cloneCellTarget(pane.editTarget),
        text: pane.draft,
        address: response.cellAddress || pane.editAddress || "",
        context: normalizePanelCellContext(response.cellContext) || pane.editContext
      };
    pane.cellTarget = resolvedTarget;
    pane.cellContext = normalizePanelCellContext(resolvedTarget.context) || pane.editContext || pane.cellContext;
    pane.cellAddress = resolvedTarget.address || pane.editAddress || pane.cellAddress;
    pane.cellTabId = resolvedTarget.tabId || pane.editTabId || pane.cellTabId;
    pane.cellWindowId = resolvedTarget.windowId || pane.editWindowId || pane.cellWindowId;
    pane.cellFrameId = resolvedTarget.frameId == null ? pane.editFrameId : resolvedTarget.frameId;
    pane.cellAccessMode = normalizeCellAccessMode(resolvedTarget.cellAccessMode);
    rememberWriteEcho(pane, resolvedTarget, pane.draft);
    exitTypingMode(paneIndex);
    renderPane(paneIndex, { preserveScroll: false });
    showToast("回写完成");
  }

  async function prepareClipboardForWrite(text) {
    const clipboardText = makeSingleCellClipboardText(text);
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      return {
        ok: false,
        reason: "clipboard_api_missing",
        textLength: clipboardText.length
      };
    }

    try {
      await navigator.clipboard.writeText(clipboardText);
      return {
        ok: true,
        reason: "clipboard_prepared",
        textLength: clipboardText.length
      };
    } catch (error) {
      return {
        ok: false,
        reason: error && error.message ? error.message : "clipboard_prepare_failed",
        textLength: clipboardText.length
      };
    }
  }

  function makeSingleCellClipboardText(text) {
    const normalized = normalizeWriteText(text);
    if (!/[\t\n"]/.test(normalized)) return normalized;
    return `"${normalized.replace(/"/g, '""')}"`;
  }

  function normalizeWriteText(text) {
    return String(text == null ? "" : text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }

  function normalizeDisplayText(text) {
    return String(text == null ? "" : text)
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n(?![A-Za-z])/g, "\n")
      .replace(/\\r(?![A-Za-z])/g, "\n")
      .replace(/\\t(?![A-Za-z])/g, "\t");
  }

  function requestInitialCapture() {
    try {
      const result = chrome.runtime.sendMessage({
        type: "FZ_PANEL_READY",
        tabId: state.scope.tabId || null,
        windowId: state.scope.windowId || null
      });
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {}
  }

  async function initPanelScope() {
    if (state.scope.windowId) return;
    if (!chrome.windows || typeof chrome.windows.getCurrent !== "function") return;
    try {
      const currentWindow = await chrome.windows.getCurrent();
      if (currentWindow && typeof currentWindow.id === "number") {
        state.scope.windowId = currentWindow.id;
      }
    } catch (_) {}
  }

  function readPanelScopeFromUrl() {
    const params = new URLSearchParams(location.search || "");
    const tabId = toFiniteNumber(params.get("tabId"));
    return {
      tabId,
      activeTabId: tabId,
      windowId: toFiniteNumber(params.get("windowId"))
    };
  }

  function isRoutedForThisPanel(message) {
    if (!message || !message.fzRouted) return false;
    const messageWindowId = toFiniteNumber(message.windowId);
    if (!state.scope.windowId || !messageWindowId) return true;
    return state.scope.windowId === messageWindowId;
  }

  function updatePanelScope(scope) {
    const tabId = toFiniteNumber(scope && scope.tabId);
    const windowId = toFiniteNumber(scope && scope.windowId);
    if (tabId) {
      state.scope.activeTabId = tabId;
      state.scope.tabId = tabId;
    }
    if (windowId) state.scope.windowId = windowId;

  }

  function getWritablePaneIndex() {
    if (state.split === "single") {
      return state.panes[0].locked || state.panes[0].editing ? -1 : 0;
    }
    const activePane = state.panes[state.activePane];
    if (activePane.editing) return -1;
    if (!activePane.locked) return state.activePane;
    const other = state.activePane === 0 ? 1 : 0;
    if (!state.panes[other].locked && !state.panes[other].editing) return other;
    return -1;
  }

  function renderAll() {
    renderChrome();
    renderPane(0, { preserveScroll: true });
    renderPane(1, { preserveScroll: true });
    renderDebug();

  }

  function renderChrome() {
    panesEl.className = `fz-panes fz-${state.split === "single" ? "single" : `split-${state.split}`}`;
    state.splitRatio = clampSplitRatio(state.splitRatio);
    titleEl.textContent = state.split === "single" ? "单元格详情" : `分栏 ${state.activePane + 1}`;
    panesEl.style.setProperty("--split-a", `${state.splitRatio}fr`);
    panesEl.style.setProperty("--split-b", `${100 - state.splitRatio}fr`);

    [
      ["split-single", state.split === "single"],
      ["split-vertical", state.split === "vertical"],
      ["split-horizontal", state.split === "horizontal"]
    ].forEach(([action, active]) => {
      const button = document.querySelector(`[data-action="${action}"]`);
      if (!button) return;
      button.classList.toggle("fz-active", active);
      button.setAttribute("aria-pressed", String(active));
    });

    document.querySelectorAll(".fz-pane").forEach((paneEl) => {
      const paneIndex = Number(paneEl.dataset.pane);
      paneEl.classList.toggle("fz-pane-active", paneIndex === state.activePane);
    });

    splitterEl.setAttribute("aria-orientation", state.split === "horizontal" ? "horizontal" : "vertical");
    const [splitMinimum, splitMaximum] = getSplitRatioBounds();
    splitterEl.setAttribute("aria-valuemin", String(Math.round(splitMinimum)));
    splitterEl.setAttribute("aria-valuemax", String(Math.round(splitMaximum)));
    splitterEl.setAttribute("aria-valuenow", String(Math.round(state.splitRatio)));
    splitterEl.tabIndex = state.split === "single" ? -1 : 0;
  }
  function renderPane(index, options) {
    const pane = state.panes[index];
    const paneEl = document.querySelector(`[data-pane="${index}"]`);
    const contentEl = paneEl.querySelector(".fz-content");
    const lockBtn = paneEl.querySelector('[data-action="lock"]');
    const typeBtn = paneEl.querySelector('[data-action="type"]');
    const preserveScroll = Boolean(options && options.preserveScroll);
    const focusEditor = Boolean(options && options.focusEditor);
    const typingAnchor = options && options.typingAnchor ? options.typingAnchor : null;
    const scrollTop = contentEl.scrollTop;
    const scrollLeft = contentEl.scrollLeft;

    lockBtn.classList.toggle("fz-active", pane.locked);
    lockBtn.dataset.tooltip = pane.locked ? "解锁" : "锁定";
    lockBtn.setAttribute("aria-label", pane.locked ? "解除锁定当前分栏" : "锁定当前分栏");
    lockBtn.setAttribute("aria-pressed", String(Boolean(pane.locked)));
    if (typeBtn) {
      const isReadOnly = normalizeCellAccessMode(pane.cellAccessMode) === "read-only";
      typeBtn.classList.toggle("fz-active", pane.editing);
      typeBtn.disabled = pane.writing || isReadOnly;
      typeBtn.dataset.tooltip = isReadOnly ? "当前单元格只读" : "键入";
      typeBtn.setAttribute("aria-label", isReadOnly ? "当前单元格为只读" : "键入当前单元格内容");
      typeBtn.setAttribute("aria-pressed", String(Boolean(pane.editing)));
    }

    updateModeControl(paneEl, pane);
    updatePaneMeta(paneEl, pane);
    contentEl.classList.toggle("fz-content-typing", pane.editing);
    contentEl.innerHTML = renderPaneContent(pane);
    if (pane.editing && pane.editMode === "json") updateJsonTypingUI(paneEl, pane);
    contentEl.querySelectorAll("a").forEach((link) => {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    });
    if (pane.searchOpen && pane.searchQuery && !pane.editing) {
      applyPaneSearch(index, { resetIndex: false, scroll: false });
    } else {
      updatePaneSearchUI(paneEl, pane);
    }
    if (preserveScroll) {
      contentEl.scrollTop = scrollTop;
      contentEl.scrollLeft = scrollLeft;
    } else {
      contentEl.scrollTop = 0;
      contentEl.scrollLeft = 0;
    }
    if (focusEditor) {
      const editor = contentEl.querySelector(".fz-type-editor");
      if (editor && typingAnchor) {
        restoreTypingEditorPosition(editor, typingAnchor);
      } else if (editor) {
        try {
          editor.focus({ preventScroll: true });
        } catch (_) {
          editor.focus();
        }
        editor.selectionStart = editor.value.length;
        editor.selectionEnd = editor.value.length;
      }
    }

  }

  function updateModeControl(paneEl, pane) {
    const trigger = paneEl.querySelector("[data-mode-trigger]");
    const label = paneEl.querySelector("[data-mode-label]");
    const options = paneEl.querySelectorAll('[data-mode-menu] [role="option"]');
    if (!trigger || !label) return;
    label.textContent = MODE_LABELS[pane.mode] || MODE_LABELS.auto;
    trigger.disabled = Boolean(pane.editing);
    trigger.setAttribute("aria-label", `展示格式：${MODE_LABELS[pane.mode] || MODE_LABELS.auto}`);
    options.forEach((option) => {
      const selected = option.dataset.mode === pane.mode;
      option.setAttribute("aria-selected", String(selected));
      option.classList.toggle("fz-selected", selected);
    });
    if (trigger.disabled) closeModeMenu(paneEl, false);
  }
  function updatePaneMeta(paneEl, pane) {
    const addressEl = paneEl.querySelector(".fz-cell-address");
    const countEl = paneEl.querySelector(".fz-cell-count");
    const displayText = pane.editing ? pane.draft : pane.text;
    const countSource = pane.editing ? displayText : normalizeDisplayText(displayText || "");
    if (addressEl) {
      const address = normalizeCellAddress(
        pane.cellAddress || pane.cellTarget && pane.cellTarget.address
      );
      const available = canRevealPaneCell(pane);
      addressEl.textContent = address;
      addressEl.disabled = !available;
      addressEl.dataset.tooltip = available ? `定位到 ${address}` : "";
      addressEl.setAttribute("aria-label", address ? `定位到 ${address}` : "暂无可定位单元格");
      addressEl.setAttribute("aria-busy", String(Boolean(pane.revealing)));
      addressEl.classList.toggle("fz-revealing", Boolean(pane.revealing));
    }
    if (countEl) countEl.textContent = `${countCellText(countSource || "")} 字`;
  }

  function renderPaneContent(pane) {
    if (pane.editing) {
      return renderTypingEditor(pane);
    }

    if (!pane.cellTarget || !pane.text) {
      return '<div class="fz-empty">单击单元格展示内容</div>';
    }

    return renderContent(pane.text, pane.mode, pane);
  }
  function renderTypingEditor(pane) {
    const status = renderTypingStatus(pane);
    const confirmDiscard = pane.confirmDiscard
      ? [
        '<div class="fz-inline-confirm" role="alert">',
        '<div class="fz-inline-confirm-title">放弃当前草稿？</div>',
        '<div class="fz-inline-confirm-copy">未保存的修改将丢失。</div>',
        '<div class="fz-inline-confirm-actions">',
        '<button class="fz-btn fz-inline-secondary" data-action="keep-draft">继续编辑</button>',
        '<button class="fz-btn fz-inline-danger" data-action="confirm-discard">放弃草稿</button>',
        "</div>",
        "</div>"
      ].join("")
      : "";
    const editor = pane.editMode === "json"
      ? renderJsonTypeEditor(pane)
      : `<textarea class="fz-type-editor" spellcheck="false">${escapeHtml(pane.draft || "")}</textarea>`;
    return [
      '<div class="fz-type-wrap">',
      '<div class="fz-type-main">',
      status,
      editor,
      confirmDiscard,
      "</div>",
      renderTypingActions(pane),
      "</div>"
    ].join("");
  }

  function renderTypingStatus(pane) {
    const parts = [];
    if (pane.relocationStatus === "waiting") {
      parts.push('<div class="fz-type-status fz-type-status-warning">等待重新定位：请在来源工作表中点击目标单元格</div>');
    }
    if (pane.editMode === "json") {
      const validation = getJsonDraftValidation(pane.draft);
      parts.push(`<div class="fz-json-validation ${validation.ok ? "fz-json-validation-ok" : "fz-json-validation-error"}" data-json-validation role="status">${escapeHtml(validation.ok ? "JSON 有效" : validation.error)}</div>`);
    }
    return parts.join("");
  }

  function renderTypingActions(pane) {
    const jsonBlocked = pane.editMode === "json" && !getJsonDraftValidation(pane.draft).ok;
    if (pane.confirmDiscard) return "";
    if (pane.relocationStatus === "confirming" && pane.relocationCandidate) {
      return [
        '<div class="fz-type-actions fz-relocation-actions" role="alert">',
        `<span class="fz-relocation-prompt">写回到 <strong class="fz-relocation-address">${escapeHtml(pane.relocationCandidate.address || "该单元格")}</strong>？</span>`,
        '<button class="fz-btn fz-complete-btn" data-action="confirm-relocation"${jsonBlocked ? " disabled" : ""}>确认</button>',
        "</div>"
      ].join("");
    }
    if (pane.relocationStatus === "waiting") {
      return [
        '<div class="fz-type-actions fz-type-actions-waiting">',
        `<button class="fz-btn fz-discard-btn" data-action="discard-typing"${pane.writing ? " disabled" : ""}>放弃草稿</button>`,
        "</div>"
      ].join("");
    }
    return [
      '<div class="fz-type-actions">',
      `<button class="fz-btn fz-complete-btn" data-action="complete-typing"${pane.writing || jsonBlocked ? " disabled" : ""}>${pane.writing ? "写入中" : "完成"}</button>`,
      `<button class="fz-btn fz-discard-btn" data-action="discard-typing"${pane.writing ? " disabled" : ""}>放弃草稿</button>`,
      "</div>"
    ].join("");
  }

  function updateTypingCount(paneEl, text) {
    const countEl = paneEl.querySelector(".fz-cell-count");
    if (countEl) countEl.textContent = `${countCellText(text || "")} 字`;
  }

  function renderDebug() {
    debugToggleEl.setAttribute("aria-expanded", state.debug.open ? "true" : "false");
    debugPanelEl.hidden = !state.debug.open;
    debugSectionEl.classList.toggle("fz-open", state.debug.open);
    const latest = getPreferredDebugLog();
    const latestIsWriteFailure = Boolean(
      latest &&
      latest.debugType === "write" &&
      latest.finalResult &&
      latest.finalResult.status === "error"
    );
    debugAlertDotEl.hidden = !state.debug.alert || state.debug.open;
    debugSectionEl.classList.toggle("fz-debug-alert", latestIsWriteFailure);
    debugCountEl.textContent = latestIsWriteFailure
      ? `键入失败 · ${latest.finalResult.reason || "未知原因"}`
      : `最近 ${state.debug.logs.length} 条`;

    if (!state.debug.logs.length) {
      debugContentEl.textContent = "暂无调试记录";
      return;
    }

    debugContentEl.textContent = JSON.stringify(latest, null, 2);
  }

  function startSplitResize(event) {
    if (state.split === "single") return;
    event.preventDefault();
    splitterEl.setPointerCapture(event.pointerId);
    splitterEl.classList.add("fz-dragging");

    function move(moveEvent) {
      const rect = panesEl.getBoundingClientRect();
      const styles = window.getComputedStyle(panesEl);
      const vertical = state.split === "vertical";
      const paddingStart = Number.parseFloat(vertical ? styles.paddingLeft : styles.paddingTop) || 0;
      const paddingEnd = Number.parseFloat(vertical ? styles.paddingRight : styles.paddingBottom) || 0;
      const axisSize = vertical ? rect.width : rect.height;
      const pointerPosition = vertical ? moveEvent.clientX - rect.left : moveEvent.clientY - rect.top;
      const splitterSize = 6;
      const paneSpace = Math.max(1, axisSize - paddingStart - paddingEnd - splitterSize);
      const rawRatio = ((pointerPosition - paddingStart - splitterSize / 2) / paneSpace) * 100;
      state.splitRatio = clampSplitRatio(rawRatio);
      renderChrome();
    }

    function end(endEvent) {
      splitterEl.releasePointerCapture(endEvent.pointerId);
      splitterEl.classList.remove("fz-dragging");
      splitterEl.removeEventListener("pointermove", move);
      splitterEl.removeEventListener("pointerup", end);
      splitterEl.removeEventListener("pointercancel", end);
    }

    splitterEl.addEventListener("pointermove", move);
    splitterEl.addEventListener("pointerup", end);
    splitterEl.addEventListener("pointercancel", end);
  }
  function countCellText(text) {
    const plain = stripMarkdownSyntax(String(text || ""));
    let count = 0;
    let index = 0;
    const tokenRe = /[A-Za-z]+(?:['-][A-Za-z]+)*|\d+(?:[.,]\d+)*/gu;

    while (index < plain.length) {
      const char = plain[index];
      if (/\s/u.test(char)) {
        index += 1;
        continue;
      }

      tokenRe.lastIndex = index;
      const token = tokenRe.exec(plain);
      if (token && token.index === index) {
        count += 1;
        index = tokenRe.lastIndex;
        continue;
      }

      count += 1;
      index += 1;
    }

    return count;
  }

  function stripMarkdownSyntax(markdown) {
    let text = replaceMathWithReadableText(String(markdown || ""));
    text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    text = text.replace(/!\[[^\]]*]\([^)]*\)/g, "");
    text = text.replace(/\[([^\]]+)]\([^)]*\)/g, "$1");
    text = text.replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1");
    text = text.replace(/`([^`]*)`/g, "$1");
    text = text.replace(/^\s{0,3}#{1,6}\s+/gm, "");
    text = text.replace(/^\s{0,3}>\s?/gm, "");
    text = text.replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/gm, "");
    text = text.replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, "");
    text = text.replace(/^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/gm, "");
    text = text.replace(/[*_~]/g, "");
    text = text.replace(/\\([\\`*{}\[\]()#+\-.!_>])/g, "$1");
    return text;
  }

  function normalizeCellAddress(value) {
    const text = String(value || "").trim().toUpperCase();
    const match = text.match(/^\$?([A-Z]{1,4})\$?(\d{1,7})$/);
    return match ? `${match[1]}${match[2]}` : "";
  }

  function normalizeCellAccessMode(value) {
    const mode = String(value || "").toLowerCase();
    return ["editable", "read-only", "unknown"].includes(mode) ? mode : "unknown";
  }

  function createCellTarget(text, cellContext, cellAddress, scope) {
    const snapshot = scope && scope.targetSnapshot && typeof scope.targetSnapshot === "object"
      ? scope.targetSnapshot
      : scope || {};
    const tabUrl = String(snapshot.tabUrl || (scope && scope.tabUrl) || "");
    const pageUrl = String(snapshot.pageUrl || (scope && scope.pageUrl) || "");
    return {
      text: String(text == null ? (snapshot.text || "") : text),
      address: normalizeCellAddress(cellAddress || snapshot.address),
      context: normalizePanelCellContext(cellContext || snapshot.context),
      tabId: toFiniteNumber(snapshot.tabId != null ? snapshot.tabId : scope && scope.tabId),
      windowId: toFiniteNumber(snapshot.windowId != null ? snapshot.windowId : scope && scope.windowId),
      frameId: toFiniteNumber(snapshot.frameId != null ? snapshot.frameId : scope && scope.frameId),
      tabUrl,
      pageUrl,
      sheetId: String(snapshot.sheetId || (scope && scope.sheetId) || extractSheetIdFromUrl(pageUrl) || extractSheetIdFromUrl(tabUrl)),
      spreadsheetToken: String(snapshot.spreadsheetToken || (scope && scope.spreadsheetToken) || extractSpreadsheetToken(pageUrl) || extractSpreadsheetToken(tabUrl)),
      fingerprint: normalizeTargetFingerprint(snapshot.fingerprint),
      cellAccessMode: normalizeCellAccessMode(snapshot.cellAccessMode || (scope && scope.cellAccessMode)),
      selectionConfirmed: Boolean(snapshot.selectionConfirmed),
      captureOrigin: String(snapshot.captureOrigin || "unspecified"),
      capturedAt: Number(snapshot.capturedAt) || 0
    };
  }

  function extractSheetIdFromUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return String(url.searchParams.get("sheet") || url.searchParams.get("sheetId") || "");
    } catch (_) {
      return "";
    }
  }

  function extractSpreadsheetToken(value) {
    try {
      const url = new URL(String(value || ""));
      const match = url.pathname.match(/\/sheets\/([^/?#]+)/i);
      return match ? decodeURIComponent(match[1]) : "";
    } catch (_) {
      return "";
    }
  }

  function isSameSourceDocument(leftValue, rightValue) {
    try {
      const left = new URL(String(leftValue || ""));
      const right = new URL(String(rightValue || ""));
      return left.origin.toLowerCase() === right.origin.toLowerCase() &&
        left.pathname.replace(/\/+$/, "") === right.pathname.replace(/\/+$/, "");
    } catch (_) {
      return false;
    }
  }

  function cloneCellTarget(target) {
    if (!target || typeof target !== "object") return null;
    return createCellTarget(target.text, target.context, target.address, target);
  }

  function normalizeTargetFingerprint(fingerprint) {
    if (!fingerprint || typeof fingerprint !== "object") return null;
    return {
      text: String(fingerprint.text == null ? "" : fingerprint.text),
      address: normalizeCellAddress(fingerprint.address),
      neighbors: Array.isArray(fingerprint.neighbors)
        ? fingerprint.neighbors.slice(0, 12).map((item) => ({
          rowOffset: Number(item && item.rowOffset) || 0,
          columnOffset: Number(item && item.columnOffset) || 0,
          text: String(item && item.text != null ? item.text : "")
        }))
        : []
    };
  }

  function normalizePanelCellContext(context) {
    if (!context || typeof context !== "object") return null;
    const x = Number(context.x);
    const y = Number(context.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }

  function isValidFrameId(frameId) {
    return Number.isFinite(Number(frameId));
  }

  function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  const JSON_NODE_LIMIT = 10000;
  const JSON_DEPTH_LIMIT = 64;

  function resolveDisplayKind(rawText, mode) {
    const selected = String(mode || "auto");
    if (selected === "json") return "json";
    if (selected === "raw") return "raw";
    if (selected === "md") return "md";
    const source = String(rawText == null ? "" : rawText);
    if (parseJson(source.trim()).ok || parseJson(normalizeDisplayText(source).trim()).ok) return "json";
    return detectContentKind(normalizeDisplayText(source));
  }

  function formatJsonDraft(text) {
    const source = String(text == null ? "" : text);
    const parsed = parseJson(source.trim());
    if (parsed.ok) return JSON.stringify(parsed.value, null, 2);
    const normalized = parseJson(normalizeDisplayText(source).trim());
    return normalized.ok ? JSON.stringify(normalized.value, null, 2) : source;
  }

  function getJsonDraftValidation(text) {
    const source = String(text == null ? "" : text);
    const parsed = parseJson(source.trim());
    if (parsed.ok) {
      return { ok: true, formatted: JSON.stringify(parsed.value, null, 2), error: "" };
    }
    return {
      ok: false,
      formatted: source,
      error: formatJsonParseError(source, parsed.error)
    };
  }

  function formatJsonParseError(source, error) {
    const text = String(source == null ? "" : source);
    const message = String(error || "JSON 解析失败");
    const positionMatch = message.match(/position\s+(\d+)/i);
    if (!positionMatch) return "JSON 无效";
    const position = Math.max(0, Math.min(text.length, Number(positionMatch[1])));
    const before = text.slice(0, position);
    const line = before.split("\n").length;
    const lastBreak = before.lastIndexOf("\n");
    const column = position - lastBreak;
    return `JSON 无效 · 第 ${line} 行第 ${column} 列`;
  }

  function buildJsonModel(value) {
    const stats = { totalNodes: 0, maxDepth: 0, truncated: false };

    function build(current, path, depth, parentKind, key) {
      stats.maxDepth = Math.max(stats.maxDepth, depth);
      if (stats.totalNodes >= JSON_NODE_LIMIT || depth > JSON_DEPTH_LIMIT) {
        stats.truncated = true;
        return { kind: "truncated", value: null, path, depth, parentKind, key };
      }
      stats.totalNodes += 1;
      if (current === null) return { kind: "null", value: null, path, depth, parentKind, key };
      if (Array.isArray(current)) {
        const children = [];
        current.some((item, index) => {
          if (stats.totalNodes >= JSON_NODE_LIMIT) {
            stats.truncated = true;
            children.push({ kind: "truncated", value: null, path: path.concat(index), depth: depth + 1, parentKind: "array", key: index });
            return true;
          }
          children.push(build(item, path.concat(index), depth + 1, "array", index));
          return false;
        });
        return {
          kind: "array",
          value: current,
          children,
          path,
          depth,
          parentKind,
          key
        };
      }
      if (typeof current === "object") {
        const children = [];
        Object.keys(current).some((childKey) => {
          if (stats.totalNodes >= JSON_NODE_LIMIT) {
            stats.truncated = true;
            children.push({ kind: "truncated", value: null, path: path.concat(childKey), depth: depth + 1, parentKind: "object", key: childKey });
            return true;
          }
          children.push(build(current[childKey], path.concat(childKey), depth + 1, "object", childKey));
          return false;
        });
        return {
          kind: "object",
          value: current,
          children,
          path,
          depth,
          parentKind,
          key
        };
      }
      if (typeof current === "string") {
        const nested = parseJson(current.trim());
        if ((nested.ok && nested.value && typeof nested.value === "object") && depth < JSON_DEPTH_LIMIT) {
          return {
            kind: "embedded",
            value: current,
            inner: build(nested.value, path.concat({ embedded: true }), depth + 1, "embedded", null),
            path,
            depth,
            parentKind,
            key
          };
        }
        return { kind: "string", value: current, path, depth, parentKind, key };
      }
      if (typeof current === "number") return { kind: "number", value: current, path, depth, parentKind, key };
      if (typeof current === "boolean") return { kind: "boolean", value: current, path, depth, parentKind, key };
      return { kind: "null", value: null, path, depth, parentKind, key };
    }

    const root = build(value, [], 0, "root", null);
    return { root, stats };
  }

  function jsonPathKey(path) {
    return JSON.stringify(Array.isArray(path) ? path : []);
  }

  function encodeJsonPath(path) {
    return encodeURIComponent(jsonPathKey(path));
  }

  function decodeJsonPath(value) {
    try {
      const path = JSON.parse(decodeURIComponent(String(value || "")));
      return Array.isArray(path) ? path : [];
    } catch (_) {
      return [];
    }
  }

  function findJsonNode(model, path) {
    if (!model || !model.root) return null;
    const target = jsonPathKey(path);
    let found = null;
    function visit(node) {
      if (!node || found) return;
      if (jsonPathKey(node.path) === target) {
        found = node;
        return;
      }
      if (node.inner) visit(node.inner);
      if (node.children) node.children.forEach(visit);
    }
    visit(model.root);
    return found;
  }

  function isJsonExpandableNode(node) {
    return Boolean(node && (node.kind === "object" || node.kind === "array" || node.kind === "embedded"));
  }

  function isJsonNodeExpanded(pane, node, stats) {
    const key = jsonPathKey(node.path);
    if (Object.prototype.hasOwnProperty.call(pane.jsonExpanded || {}, key)) return Boolean(pane.jsonExpanded[key]);
    if (node.depth === 0) return true;
    return stats.totalNodes <= 80 && node.depth <= 2;
  }

  function jsonNodeSummary(node) {
    if (!node) return "";
    if (node.kind === "object") return `{${node.children.length}}`;
    if (node.kind === "array") return `[${node.children.length}]`;
    if (node.kind === "embedded" && node.inner) return jsonNodeSummary(node.inner);
    return "";
  }

  function renderJsonTree(value, pane) {
    const model = buildJsonModel(value);
    pane.jsonModel = model;
    return `<div class="fz-json fz-json-tree" data-json-root>${renderJsonNode(model.root, pane, model, true)}</div>`;
  }

  function renderJsonNode(node, pane, model, isRoot) {
    if (!node) return "";
    const expandable = isJsonExpandableNode(node) && (node.kind !== "embedded" || node.inner);
    const expanded = expandable ? isJsonNodeExpanded(pane, node, model.stats) : false;
    const pathAttr = encodeJsonPath(node.path);
    const keyHtml = isRoot ? "" : renderJsonNodeKey(node);
    const copyHtml = isRoot ? "" : `<button class="fz-json-copy" data-action="json-copy-member" data-json-path="${escapeHtml(pathAttr)}" data-tooltip="复制键值对" aria-label="复制 JSON 成员"><svg class="fz-json-copy-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.25" y="2.75" width="7.5" height="8" rx="1.2"></rect><path d="M3.25 5.25v7a1 1 0 0 0 1 1h6"></path></svg></button>`;
    const toggleHtml = expandable
      ? `<button class="fz-json-toggle" data-action="json-toggle" data-json-path="${escapeHtml(pathAttr)}" aria-label="${expanded ? "折叠" : "展开"}" aria-expanded="${String(expanded)}"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 6 2.5 2.5L10.5 6"></path></svg></button>`
      : '<span class="fz-json-toggle-placeholder" aria-hidden="true"></span>';
    const rowValue = renderJsonNodeValue(node, expanded);
    const children = expanded ? renderJsonNodeChildren(node, pane, model) : "";
    return [
      `<div class="fz-json-node fz-json-node-${node.kind}" data-json-path="${escapeHtml(pathAttr)}">`,
      `<div class="fz-json-row" tabindex="-1">`,
      toggleHtml,
      keyHtml,
      rowValue,
      copyHtml,
      "</div>",
      children,
      "</div>"
    ].join("");
  }

  function renderJsonNodeChildren(node, pane, model) {
    if (node.kind === "embedded" && node.inner) {
      return `<div class="fz-json-children fz-json-embedded-children">${renderJsonNode(node.inner, pane, model, false)}</div>`;
    }
    if (!node.children || !node.children.length) {
      return `<div class="fz-json-children"><div class="fz-json-close"><span class="fz-json-punctuation">${node.kind === "array" ? "]" : "}"}</span></div></div>`;
    }
    const content = node.children.map((child) => renderJsonNode(child, pane, model, false)).join("");
    return `<div class="fz-json-children">${content}<div class="fz-json-close"><span class="fz-json-punctuation">${node.kind === "array" ? "]" : "}"}</span></div></div>`;
  }

  function renderJsonNodeKey(node) {
    if (node.parentKind === "array") {
      return `<span class="fz-json-index">[${escapeHtml(node.key)}]</span><span class="fz-json-punctuation">:</span>`;
    }
    if (node.parentKind === "object") {
      return `<span class="fz-json-key">${escapeHtml(JSON.stringify(String(node.key)))}</span><span class="fz-json-punctuation">:</span>`;
    }
    return "";
  }

  function renderJsonNodeValue(node, expanded) {
    if (node.kind === "object" || node.kind === "array") {
      return `<span class="fz-json-container-value"><span class="fz-json-punctuation">${node.kind === "array" ? "[" : "{"}</span><span class="fz-json-summary">${jsonNodeSummary(node)}</span>${expanded ? "" : `<span class="fz-json-punctuation">${node.kind === "array" ? "]" : "}"}</span>`}</span>`;
    }
    if (node.kind === "embedded") {
      return `<span class="fz-json-embedded-value"><span class="fz-json-embedded-badge">JSON 字符串</span><span class="fz-json-summary">${jsonNodeSummary(node)}</span></span>`;
    }
    if (node.kind === "truncated") {
      return '<span class="fz-json-truncated">内容过深，未继续展开</span>';
    }
    return `<span class="fz-json-scalar fz-json-scalar-${node.kind}">${renderJsonScalar(node.value, node.kind)}</span>`;
  }

  function renderJsonScalar(value, kind) {
    if (kind === "null") return "null";
    if (kind === "boolean") return String(value);
    if (kind === "number") return escapeHtml(JSON.stringify(value));
    const literal = JSON.stringify(String(value == null ? "" : value)).slice(1, -1);
    const visual = literal.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    return `"${escapeHtml(visual)}"`;
  }

  function serializeJsonMember(node) {
    if (!node) return "";
    const value = JSON.stringify(node.value, null, 2);
    if (node.parentKind === "object") return `${JSON.stringify(String(node.key))}: ${value}`;
    return value;
  }

  async function copyJsonMember(paneIndex, encodedPath) {
    const pane = state.panes[paneIndex];
    const node = pane && findJsonNode(pane.jsonModel, decodeJsonPath(encodedPath));
    const text = serializeJsonMember(node);
    if (!text) return;
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      showToast("复制失败，当前浏览器不支持剪贴板");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast("已复制");
    } catch (_) {
      showToast("复制失败，请检查浏览器剪贴板权限");
    }
  }

  function toggleJsonNode(paneIndex, encodedPath) {
    const pane = state.panes[paneIndex];
    const node = pane && findJsonNode(pane.jsonModel, decodeJsonPath(encodedPath));
    if (!pane || !node || !isJsonExpandableNode(node)) return;
    const key = jsonPathKey(node.path);
    pane.jsonExpanded = pane.jsonExpanded || {};
    pane.jsonExpanded[key] = !isJsonNodeExpanded(pane, node, pane.jsonModel.stats);
    renderPane(paneIndex, { preserveScroll: true });
  }

  function renderJsonTypeEditor(pane) {
    return [
      '<div class="fz-json-editor-shell">',
      `<pre class="fz-json-editor-highlight" data-json-highlight aria-hidden="true"></pre>`,
      `<textarea class="fz-type-editor fz-json-type-editor" data-json-editor="true" spellcheck="false" wrap="soft">${escapeHtml(pane.draft || "")}</textarea>`,
      "</div>"
    ].join("");
  }

  function renderJsonSyntaxHighlight(text) {
    const source = String(text == null ? "" : text);
    let html = "";
    let index = 0;
    while (index < source.length) {
      const character = source[index];
      if (character === '"') {
        const start = index;
        index += 1;
        while (index < source.length) {
          if (source[index] === "\\") {
            index += 2;
            continue;
          }
          if (source[index] === '"') {
            index += 1;
            break;
          }
          index += 1;
        }
        const token = source.slice(start, index);
        let lookahead = index;
        while (/\s/.test(source[lookahead] || "")) lookahead += 1;
        const className = source[lookahead] === ":" ? "fz-json-token-key" : "fz-json-token-string";
        html += `<span class="${className}">${escapeHtml(token)}</span>`;
        continue;
      }
      if (/[{}[\],:]/.test(character)) {
        html += `<span class="fz-json-token-punctuation">${escapeHtml(character)}</span>`;
        index += 1;
        continue;
      }
      const remainder = source.slice(index);
      const number = remainder.match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (number) {
        html += `<span class="fz-json-token-number">${escapeHtml(number[0])}</span>`;
        index += number[0].length;
        continue;
      }
      const literal = remainder.match(/^(?:true|false|null)\b/);
      if (literal) {
        html += `<span class="fz-json-token-${literal[0]}">${literal[0]}</span>`;
        index += literal[0].length;
        continue;
      }
      html += escapeHtml(character);
      index += 1;
    }
    return html || "\n";
  }

  function syncJsonEditorMirror(editor) {
    if (!editor) return;
    const shell = editor.closest(".fz-json-editor-shell");
    const highlight = shell && shell.querySelector("[data-json-highlight]");
    if (!highlight) return;
    highlight.innerHTML = renderJsonSyntaxHighlight(editor.value);
    highlight.scrollTop = editor.scrollTop;
    highlight.scrollLeft = editor.scrollLeft;
  }

  function updateJsonTypingUI(paneEl, pane) {
    if (!paneEl || !pane || pane.editMode !== "json") return;
    const validation = getJsonDraftValidation(pane.draft);
    const status = paneEl.querySelector("[data-json-validation]");
    if (status) {
      status.textContent = validation.ok ? "JSON 有效" : validation.error;
      status.classList.toggle("fz-json-validation-error", !validation.ok);
      status.classList.toggle("fz-json-validation-ok", validation.ok);
    }
    const complete = paneEl.querySelector('[data-action="complete-typing"]');
    if (complete) complete.disabled = Boolean(pane.writing || !validation.ok);
    const editor = paneEl.querySelector(".fz-json-type-editor");
    if (editor) syncJsonEditorMirror(editor);
  }

  function revealJsonSearchMatches(pane, query) {
    if (!pane || !pane.jsonModel || !String(query || "").trim()) return false;
    if (!pane.jsonSearchExpansionSnapshot) pane.jsonSearchExpansionSnapshot = { ...(pane.jsonExpanded || {}) };
    const needle = String(query).toLocaleLowerCase();
    let changed = false;
    function visit(node, ancestors) {
      if (!node) return;
      const own = [node.key, node.kind === "embedded" ? "JSON 字符串" : "", node.kind === "string" ? node.value : node.kind === "number" || node.kind === "boolean" ? String(node.value) : ""].join(" ").toLocaleLowerCase();
      if (own.includes(needle)) {
        ancestors.forEach((ancestor) => {
          const key = jsonPathKey(ancestor.path);
          if (!pane.jsonExpanded[key]) {
            pane.jsonExpanded[key] = true;
            changed = true;
          }
        });
      }
      const nextAncestors = isJsonExpandableNode(node) ? ancestors.concat(node) : ancestors;
      if (node.inner) visit(node.inner, nextAncestors);
      if (node.children) node.children.forEach((child) => visit(child, nextAncestors));
    }
    visit(pane.jsonModel.root, []);
    return changed;
  }

  function restoreJsonSearchExpansion(pane) {
    if (!pane || !pane.jsonSearchExpansionSnapshot) return false;
    pane.jsonExpanded = { ...pane.jsonSearchExpansionSnapshot };
    pane.jsonSearchExpansionSnapshot = null;
    return true;
  }
  function renderContent(text, mode, pane) {
    const rawText = String(text == null ? "" : text);
    const displayText = normalizeDisplayText(rawText);
    const rawJson = parseJson(rawText.trim());
    let kind = mode;
    if (mode === "auto") {
      kind = rawJson.ok || parseJson(displayText.trim()).ok ? "json" : detectContentKind(displayText);
    }

    if (kind === "json") {
      const parsed = rawJson.ok ? rawJson : parseJson(displayText.trim());
      if (!parsed.ok) {
        if (pane) pane.jsonModel = null;
        return renderInvalidJson(rawText, parsed.error);
      }
      return renderJsonTree(parsed.value, pane || { jsonExpanded: {} });
    }

    if (pane) pane.jsonModel = null;
    if (kind === "raw") {
      return `<pre class="fz-raw">${linkify(escapeHtml(rawText))}</pre>`;
    }

    return `<div class="fz-rendered">${renderMarkdown(displayText)}</div>`;
  }

  function renderInvalidJson(text, error) {
    return [
      `<div class="fz-json-invalid" role="status">${escapeHtml(formatJsonParseError(text, error))}</div>`,
      `<pre class="fz-json fz-json-invalid-source">${linkify(escapeHtml(String(text == null ? "" : text)))}</pre>`
    ].join("");
  }

  function detectContentKind(text) {
    const trimmed = text.trim();
    if (parseJson(trimmed).ok) return "json";
    // A leading equals sign identifies spreadsheet formula source for display.
    // This is deliberately not a completeness check: capture is responsible for
    // supplying a structurally complete value before the panel receives it.
    if (String(text == null ? "" : text).trimStart().startsWith("=")) return "raw";
    return "md";
  }

  function parseJson(text) {
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (error) {
      return { ok: false, value: null, error: error && error.message ? error.message : "JSON parse failed" };
    }
  }

  function protectMathExpressions(markdown) {
    const source = String(markdown == null ? "" : markdown);
    const expressions = [];
    let tokenPrefix = "CELLPEEKMATHSEGMENT";
    while (source.includes(tokenPrefix)) tokenPrefix += "X";
    let protectedSource = "";
    let index = 0;

    while (index < source.length) {
      const fence = readMarkdownFence(source, index);
      if (fence) {
        protectedSource += source.slice(index, fence.end);
        index = fence.end;
        continue;
      }

      if (source[index] === "`") {
        const runLength = countCharacterRun(source, index, "`");
        const marker = "`".repeat(runLength);
        const closing = source.indexOf(marker, index + runLength);
        const end = closing === -1 ? index + runLength : closing + runLength;
        protectedSource += source.slice(index, end);
        index = end;
        continue;
      }

      const expression = readMathExpression(source, index);
      if (!expression) {
        protectedSource += source[index];
        index += 1;
        continue;
      }

      const token = `${tokenPrefix}${expressions.length}END`;
      expression.token = token;
      expressions.push(expression);
      protectedSource += token;
      index = expression.end;
    }

    return { markdown: protectedSource, expressions };
  }

  function readMarkdownFence(source, index) {
    if (index > 0 && source[index - 1] !== "\n") return null;
    const lineEnd = source.indexOf("\n", index);
    const openingEnd = lineEnd === -1 ? source.length : lineEnd;
    const opening = source.slice(index, openingEnd).match(/^ {0,3}(`{3,}|~{3,})/);
    if (!opening) return null;
    const fenceMarker = opening[1];
    const fenceCharacter = fenceMarker[0];
    let cursor = lineEnd === -1 ? source.length : lineEnd + 1;

    while (cursor < source.length) {
      const nextLineEnd = source.indexOf("\n", cursor);
      const contentEnd = nextLineEnd === -1 ? source.length : nextLineEnd;
      const line = source.slice(cursor, contentEnd);
      const closing = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closing && closing[1][0] === fenceCharacter && closing[1].length >= fenceMarker.length) {
        return { end: nextLineEnd === -1 ? source.length : nextLineEnd + 1 };
      }
      cursor = nextLineEnd === -1 ? source.length : nextLineEnd + 1;
    }
    return { end: source.length };
  }

  function countCharacterRun(source, index, character) {
    let end = index;
    while (source[end] === character) end += 1;
    return end - index;
  }

  function readMathExpression(source, index) {
    const candidates = [
      { left: "$$", right: "$$", display: true, singleDollar: false },
      { left: "\\[", right: "\\]", display: true, singleDollar: false },
      { left: "\\(", right: "\\)", display: false, singleDollar: false },
      { left: "$", right: "$", display: false, singleDollar: true }
    ];

    for (const candidate of candidates) {
      if (!source.startsWith(candidate.left, index) || isEscapedCharacter(source, index)) continue;
      if (candidate.singleDollar && (source[index + 1] === "$" || source[index - 1] === "$")) continue;
      const contentStart = index + candidate.left.length;
      const closing = findMathClosingDelimiter(source, contentStart, candidate);
      if (closing < 0) continue;
      const tex = source.slice(contentStart, closing);
      if (!tex.trim()) continue;
      if (candidate.singleDollar && !looksLikeInlineDollarMath(tex)) continue;
      const end = closing + candidate.right.length;
      return {
        source: source.slice(index, end),
        tex,
        display: candidate.display,
        start: index,
        end
      };
    }
    return null;
  }

  function findMathClosingDelimiter(source, start, candidate) {
    let cursor = start;
    while (cursor < source.length) {
      if (candidate.singleDollar && source[cursor] === "\n") return -1;
      if (source[cursor] === "`") return -1;
      if (source.startsWith(candidate.right, cursor) && !isEscapedCharacter(source, cursor)) {
        if (!candidate.singleDollar || (source[cursor + 1] !== "$" && source[cursor - 1] !== "$")) return cursor;
      }
      cursor += 1;
    }
    return -1;
  }

  function isEscapedCharacter(source, index) {
    let slashes = 0;
    for (let cursor = index - 1; cursor >= 0 && source[cursor] === "\\"; cursor -= 1) slashes += 1;
    return slashes % 2 === 1;
  }

  function looksLikeInlineDollarMath(tex) {
    const value = String(tex || "").trim();
    if (!value || /[\r\n]/.test(value)) return false;
    if (/^[\d\s.,，。:：]+$/u.test(value)) return false;
    if (/[\u3400-\u9fff]/u.test(value) && !/[\\_^{}=+\-*/<>≤≥≠≈]/u.test(value)) return false;
    return /\\[A-Za-z]+|[_^{}=+\-*/<>()[\]≤≥≠≈±×÷∑∏∫√∞]|[A-Za-zΑ-ω]/u.test(value);
  }

  function renderMathExpressionData(expression) {
    const cacheKey = `${expression.display ? "display" : "inline"}\u0000${expression.tex}`;
    if (mathRenderCache.has(cacheKey)) return mathRenderCache.get(cacheKey);
    let result = { ok: false, markup: "", visibleText: expression.source };

    if (window.katex && typeof window.katex.renderToString === "function") {
      try {
        const markup = window.katex.renderToString(expression.tex, {
          displayMode: expression.display,
          output: "htmlAndMathml",
          throwOnError: true,
          strict: "ignore",
          trust: false,
          maxSize: 24,
          maxExpand: 1000
        });
        const template = document.createElement("template");
        template.innerHTML = markup;
        const visual = template.content.querySelector(".katex-html");
        const visibleText = normalizeMathVisibleText(visual ? visual.textContent : expression.tex) || expression.tex.trim();
        result = { ok: true, markup, visibleText };
      } catch (_) {}
    }

    mathRenderCache.set(cacheKey, result);
    if (mathRenderCache.size > 400) mathRenderCache.delete(mathRenderCache.keys().next().value);
    return result;
  }

  function normalizeMathVisibleText(value) {
    return String(value == null ? "" : value)
      .replace(/[\u200b-\u200d\u2060\ufeff]/giu, "")
      .replace(/\s+/gu, " ")
      .trim();
  }

  function renderProtectedMath(markdownHtml, expressions) {
    let html = String(markdownHtml || "");
    expressions.forEach((expression) => {
      const rendered = renderMathExpressionData(expression);
      const replacement = rendered.ok
        ? [
          `<span class="fz-math ${expression.display ? "fz-math-display" : "fz-math-inline"}"`,
          ` data-math-search="${escapeHtml(rendered.visibleText)}"`,
          ` data-math-source="${escapeHtml(encodeURIComponent(expression.source))}"`,
          ` data-math-source-start="${expression.start}" data-math-source-end="${expression.end}">`,
          rendered.markup,
          "</span>"
        ].join("")
        : `<span class="fz-math-fallback ${expression.display ? "fz-math-fallback-display" : ""}">${escapeHtml(expression.source)}</span>`;
      html = html.split(expression.token).join(replacement);
    });
    return html;
  }

  function replaceMathWithReadableText(markdown) {
    const protectedMath = protectMathExpressions(markdown);
    let readable = protectedMath.markdown;
    protectedMath.expressions.forEach((expression) => {
      const rendered = renderMathExpressionData(expression);
      readable = readable.split(expression.token).join(rendered.ok ? rendered.visibleText : expression.source);
    });
    return readable;
  }
  function createMarkdownParser() {
    if (typeof window.markdownit !== "function") return null;
    const parser = window.markdownit({
      html: false,
      breaks: true,
      linkify: true,
      typographer: false
    });

    parser.renderer.rules.link_open = (tokens, index, options, environment, renderer) => {
      tokens[index].attrSet("target", "_blank");
      tokens[index].attrSet("rel", "noopener noreferrer");
      return renderer.renderToken(tokens, index, options);
    };
    parser.renderer.rules.image = (tokens, index) => {
      const token = tokens[index];
      const alt = escapeHtml(token.content || "图片");
      const source = String(token.attrGet("src") || "");
      const safeSource = escapeHtml(source);
      const sourceDisplay = /^https?:\/\//i.test(source)
        ? `<a href="${safeSource}" target="_blank" rel="noopener noreferrer">${safeSource}</a>`
        : safeSource;
      return `<span class="fz-md-image-placeholder">图片：${alt}${sourceDisplay ? `（${sourceDisplay}）` : ""}</span>`;
    };
    parser.renderer.rules.table_open = () => '<div class="fz-table-scroll" role="region" aria-label="Markdown 表格" tabindex="0"><table class="fz-md-table">\n';
    parser.renderer.rules.table_close = () => "</table></div>\n";
    return parser;
  }

  function renderMarkdown(markdown) {
    const source = String(markdown == null ? "" : markdown);
    const protectedMath = protectMathExpressions(source);
    const html = markdownParser
      ? markdownParser.render(protectedMath.markdown)
      : `<p>${escapeHtml(protectedMath.markdown).replace(/\n/g, "<br>")}</p>`;
    return renderProtectedMath(html, protectedMath.expressions);
  }
  function linkify(html) {
    return html.replace(URL_RE, (url, offset) => {
      if (html.slice(Math.max(0, offset - 6), offset) === 'href="') return url;
      const cleanUrl = url.replace(/(&quot;|&#39;|&gt;|&lt;|[),.;])+$/, "");
      const tail = url.slice(cleanUrl.length);
      return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${tail}`;
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  let toastTimer = 0;
  function showToast(message) {
    window.clearTimeout(toastTimer);
    toastEl.textContent = message;
    toastEl.classList.add("fz-show");
    toastTimer = window.setTimeout(() => toastEl.classList.remove("fz-show"), 1800);
  }
})();
