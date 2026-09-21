/**
 * 课件运行时「分数变量监视器」脚本。
 *
 * 归属：本脚本由 **插件拥有**，通过平台新增的「课件运行时脚本扩展点」
 * （`ICoursewareRuntimeScriptRegistry`，注册后由宿主 `injectLmsSdk()` 在渲染课件 HTML 时拼接）
 * 注入到互动课件 iframe 内部，而不是写死在宿主的 `bridge-sdk.ts` 模板字符串里。
 *
 * 为什么必须由平台注入：互动课件跑在
 * `<iframe credentialless sandbox="allow-scripts allow-forms allow-downloads">`
 * （没有 `allow-same-origin`）里，是 opaque origin —— 父窗口读不到它内部的任何状态，
 * 服务端拼接 HTML 是平台唯一能向课件投递代码的位置。
 *
 * 前置条件（顺序由平台保证）：注入位置为 `body-end`，排在 Bridge SDK 之后，
 * 因此 `window.LMS` 已就绪；本脚本刻意自包含，只使用 `window.LMS` 这个公开 API，
 * 不引用 Bridge SDK IIFE 内部的私有变量。
 *
 * 采集三层：
 *   1) `window.__LMS_WATCH__` 显式声明的变量名 / 点路径（课件作者或 AI 补刀写入；置 false 可整体退出）
 *   2) 自动发现 window 上名字匹配 score|point|grade|mark|correct|right 的有限数值属性
 *   3) DOM 兜底：分数类元素的「可见」文本（键名形如 dom__score），覆盖完全不调用 LMS.* 的静态课件
 *
 * 上报语义：任一变量变化后进入静默窗口，静默 `__LMS_WATCH_SILENCE_MS` 后以
 * `LMS.saveProgress({ score, watch })` 上报一次样本（附带完整快照）；
 * `saveProgress` 落库为 `status='inprogress'`，不会提前把 attempt 置为已完成，
 * 但同样写 `submission_result` / `submission_raw` 并发出 `courseware.attempt_submitted` —— 已进成绩管道。
 * 快照随 `extra` 落到 `submission_result.extra_json.watch` 与 `submission_raw.payload_json.watch`，
 * 成为插件侧按 `score_policy`（MAX / AVERAGE / LATEST）聚合的样本历史。
 */
export const SCORE_MONITOR_SCRIPT = `(function () {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__LMS_WATCH__ === false) return;

  // 用 [0-9] / [^0-9] 代替 \\d / \\s，规避转义陷阱
  var __LMS_NUM_RE = /[0-9]+(?:[.][0-9]+)?/;
  var __LMS_RATIO_RE = /([0-9]+(?:[.][0-9]+)?)[^0-9]*[/／|之][^0-9]*([0-9]+)/;

  // 仅采「可见」元素的文本，避免读到结算页尚未展开时隐藏的初始值 0
  function __lmsIsShown(el) {
    try {
      if (!el || !el.getBoundingClientRect) return false;
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 && rect.height <= 0) return false;
      var node = el;
      while (node && node.nodeType === 1) {
        var st = window.getComputedStyle ? window.getComputedStyle(node) : null;
        if (st && (st.display === 'none' || st.visibility === 'hidden')) return false;
        node = node.parentElement;
      }
      return true;
    } catch (e) { return false; }
  }

    // --- SCORE VARIABLE MONITOR -----------------------------------------
    // 监视「代表分数的变量」，变量变化时按静默窗口去抖后上报一次样本，
    // 供插件侧按成绩配置里的 score_policy 对样本历史聚合（MAX / AVERAGE / LATEST）。
    // 采集源三层：
    //   1) window.__LMS_WATCH__ 显式声明的变量名 / 点路径（课件作者或 AI 补刀写入）
    //   2) 自动发现 window 上名字像分数的数值属性
    //   3) DOM 兜底：分数类元素的可见文本（覆盖把分数只写进 #score 的静态课件）
    // 上报用 saveProgress（lms-bridge 以 status='inprogress' 落库）：不会提前把 attempt
    // 置为已完成，但同样会写 submission_result 并发出 courseware.attempt_submitted —— 已进管道。
    // watch 快照会随 extra 落到 submission_result.extra_json 与 submission_raw.payload_json。
    var __LMS_WATCH_INTERVAL_MS = 800;
    var __LMS_WATCH_SILENCE_MS = 1200;
    var __LMS_WATCH_MAX_SUBMITS = 60;
    var __LMS_WATCH_KEY_RE = /score|point|grade|mark|correct|right/i;
    var __LMS_WATCH_SKIP_RE = /^_|^on[A-Z]|^webkit|^moz|^ms/;
    var __LMS_WATCH_DOM_SELECTORS = [
      '#score', '#points', '#grade', '#finalScore', '#totalScore', '#scoreDisplay', '#score-num',
      '.score', '.points', '.grade', '.final-score',
      '[id*="score" i]', '[id*="point" i]', '[id*="grade" i]'
    ];
    var __lmsWatchState = { snapshot: {}, pendingChanged: [], pendingTimer: null, submitted: 0 };

    function __lmsWatchNumber(value) {
      if (typeof value === 'number') return isFinite(value) ? value : null;
      if (typeof value === 'string') {
        var text = value.trim();
        if (!text) return null;
        var m = text.match(__LMS_NUM_RE);
        if (!m) return null;
        var n = parseFloat(m[0]);
        return isFinite(n) ? n : null;
      }
      return null;
    }

    function __lmsWatchResolve(path) {
      var segs = String(path).split('.');
      var node = window;
      for (var i = 0; i < segs.length; i++) {
        if (node === null || node === undefined) return undefined;
        try { node = node[segs[i]]; } catch (e) { return undefined; }
      }
      return node;
    }

    function __lmsWatchSnapshot() {
      var snap = {};

      // 1) 显式声明的变量
      var declared = window.__LMS_WATCH__;
      if (typeof declared === 'string') declared = [declared];
      if (Array.isArray(declared)) {
        for (var d = 0; d < declared.length; d++) {
          if (typeof declared[d] !== 'string') continue;
          var declaredValue = __lmsWatchNumber(__lmsWatchResolve(declared[d]));
          if (declaredValue !== null) snap[declared[d]] = declaredValue;
        }
      }

      // 2) 自动发现 window 上的分数类数值变量
      try {
        for (var key in window) {
          if (typeof key !== 'string' || !key) continue;
          if (!__LMS_WATCH_KEY_RE.test(key) || __LMS_WATCH_SKIP_RE.test(key)) continue;
          var globalValue;
          try { globalValue = window[key]; } catch (e) { continue; }
          var globalNumber = __lmsWatchNumber(globalValue);
          if (globalNumber !== null) snap[key] = globalNumber;
        }
      } catch (e) {}

      // 3) DOM 兜底
      var seenElements = [];
      for (var s = 0; s < __LMS_WATCH_DOM_SELECTORS.length; s++) {
        var selector = __LMS_WATCH_DOM_SELECTORS[s];
        var el = null;
        try { el = document.querySelector(selector); } catch (e) { el = null; }
        // 同一个元素会被多个选择器命中（如 #score 同时命中 [id*="score" i]），去重避免快照里出现重复变量
        if (!el || seenElements.indexOf(el) >= 0) continue;
        if (!__lmsIsShown(el)) continue;
        seenElements.push(el);
        var text = (el.textContent || '').trim();
        if (!text) continue;
        var value = null;
        var frac = text.match(__LMS_RATIO_RE);
        if (frac) {
          var fracNum = parseFloat(frac[1]);
          var fracDen = parseFloat(frac[2]);
          if (fracDen > 0 && fracNum >= 0 && fracNum <= fracDen) {
            value = Math.round((fracNum / fracDen) * 10000) / 100;
          }
        }
        if (value === null) value = __lmsWatchNumber(text);
        if (value === null) continue;
        // 键名里不能出现 "."，否则插件侧 score_fields 的点路径解析会歧义
        snap['dom_' + selector.replace(/[^A-Za-z0-9_-]/g, '_')] = value;
      }

      return snap;
    }

    function __lmsWatchDiff(prev, next) {
      var changed = [];
      for (var k in next) {
        if (!Object.prototype.hasOwnProperty.call(next, k)) continue;
        if (!Object.prototype.hasOwnProperty.call(prev, k) || prev[k] !== next[k]) changed.push(k);
      }
      return changed;
    }

    function __lmsWatchTick() {
      if (__lmsWatchState.submitted >= __LMS_WATCH_MAX_SUBMITS) return;
      if (!window.__LMS_STUDENT__ || !window.__LMS_STUDENT__.attempt_id) return;
      var snap;
      try { snap = __lmsWatchSnapshot(); } catch (e) { return; }
      var changed = __lmsWatchDiff(__lmsWatchState.snapshot, snap);
      if (!changed.length) return;
      // 先更新基线，避免同一个变化被反复判定为「刚刚变化」
      __lmsWatchState.snapshot = snap;
      for (var i = 0; i < changed.length; i++) {
        if (__lmsWatchState.pendingChanged.indexOf(changed[i]) < 0) {
          __lmsWatchState.pendingChanged.push(changed[i]);
        }
      }
      if (__lmsWatchState.pendingTimer) clearTimeout(__lmsWatchState.pendingTimer);
      __lmsWatchState.pendingTimer = setTimeout(__lmsWatchFlush, __LMS_WATCH_SILENCE_MS);
    }

    function __lmsWatchFlush() {
      __lmsWatchState.pendingTimer = null;
      var changed = __lmsWatchState.pendingChanged;
      __lmsWatchState.pendingChanged = [];
      if (!changed.length) return;

      var snap;
      try { snap = __lmsWatchSnapshot(); } catch (e) { snap = __lmsWatchState.snapshot; }

      // 取变化变量中的最大值作为本次样本的 score（同一次变化里通常只有一个真实分数变量）
      var score = null;
      for (var i = 0; i < changed.length; i++) {
        var value = snap[changed[i]];
        if (typeof value !== 'number' || !isFinite(value)) continue;
        if (score === null || value > score) score = value;
      }
      if (score === null) return;

      snap._changed = changed.join(',');
      snap._at = Date.now();
      __lmsWatchState.submitted++;
      console.warn('Score variable changed (' + snap._changed + '), reporting sample: ' + score);
      window.LMS.saveProgress({
        score: score,
        watch: snap
      });
    }

    function initScoreWatcher() {
      try {
        // 课件可显式退出监视：window.__LMS_WATCH__ = false
        if (window.__LMS_WATCH__ === false) return;
        if (!window.__LMS_STUDENT__ || !window.__LMS_STUDENT__.attempt_id) return;
        __lmsWatchState.snapshot = __lmsWatchSnapshot();
        setInterval(__lmsWatchTick, __LMS_WATCH_INTERVAL_MS);
        var lastObservedAt = 0;
        var observer = new MutationObserver(function() {
          var now = Date.now();
          if (now - lastObservedAt < 300) return;
          lastObservedAt = now;
          __lmsWatchTick();
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      } catch (e) {
        console.warn('Error in initScoreWatcher: ' + e.message);
      }
    }

  // 引导：body-end 注入时 body 已存在
  try {
    if (document.body) initScoreWatcher();
    else document.addEventListener('DOMContentLoaded', initScoreWatcher);
  } catch (e) {
    console.warn('Score monitor bootstrap failed: ' + (e && e.message ? e.message : e));
  }
})();`;

export default SCORE_MONITOR_SCRIPT;
