// dsh-core-patch-keeper: 模板提取器（一次性工具，开发期运行）。
// 从「当前已打补丁的核心文件」与「未打备份」自动提取各补丁的 old/new 精确文本，
// 输出 lib/templates.json 供宿主插件运行时使用。杜绝手写缩进/转义错误：
// 升级 DSH 后核心文件行文变化 → 锚点不匹配 → 恢复跳过（安全），本文件重跑即可再提取。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.DSH_DESKTOP_APP_DIR || 'D:\\dsh\\resources\\app';
const read = (rel) => {
  const abs = path.join(APP, rel);
  try { return readFileSync(abs, 'utf8'); } catch (e) { throw new Error(`无法读取 ${abs}: ${e.message}`); }
};
const must = (idx, what) => { if (idx < 0) throw new Error(`模板提取失败：未找到 "${what}"`); return idx; };
// [startMarker, endMarker) 段，endMarker 可能重复，取 start 之后第一处
function segment(src, startMarker, endMarker, label) {
  const s = must(src.indexOf(startMarker), `${label} 起始标记`);
  const e = must(src.indexOf(endMarker, s), `${label} 结束标记`);
  if (e <= s) throw new Error(`模板提取失败：${label} 起止错位`);
  return src.slice(s, e);
}
// 行首回退：找 offset 之前最近一次 \n 之后的位置（保留行首缩进）
const lineStart = (src, off) => { const nl = src.lastIndexOf('\n', off - 1); return nl < 0 ? 0 : nl + 1; };

// ---------- 1. preload.js：require 行 + 桥块（从实际已打文件提取，与手工 patch 逐字一致） ----------
const preloadSrc = read('preload.js');
const preloadOld = "const { contextBridge, ipcRenderer } = require('electron');";
const preloadNew = "const { contextBridge, ipcRenderer, webUtils } = require('electron');";
const BRIDGE_MARKER = '// dsh-drop-in path bridge: Electron >= 32';
const bridgeBlockStart = must(preloadSrc.lastIndexOf('// ---------------------------------------------------------------------------', must(preloadSrc.indexOf(BRIDGE_MARKER), 'preload 桥标记')), 'preload 桥注释块首');
const PRELOAD_BRIDGE = preloadSrc.slice(bridgeBlockStart); // 注释块 + IIFE + 尾部（桥是文件最后内容）

// ---------- 2. main.js：函数定义（append）+ 4 个调用点（6 空格×2 / 4 空格×2） ----------
const mainSrc = read('main.js');
const mainFuncDef = segment(mainSrc, 'function applyDropInBridgeFix() {', 'function applyProfilePatchGuard() {', 'main.js applyDropInBridgeFix 函数');
const mainCalls = [
  { kind: 'insertLineAfter', line: '      applyVisionKeyFix();', insertLine: '      applyDropInBridgeFix();', expect: 2 },
  { kind: 'insertLineAfter', line: '    applyVisionKeyFix();', insertLine: '    applyDropInBridgeFix();', expect: 2 },
];

// ---------- 2b. main.js syncCompanionPlugins manifest BOM 剥离（防 Desktop 覆盖用户插件清单） ----------
// 出厂形态为单行 JSON.parse(fs.readFileSync(...))；已打形态为 raw 变量 + BOM 剥离。
// 从当前已打文件提取「已打段」作为 new，old 为出厂单行。
const BOM_OLD = "manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));";
const bomRawLine = 'let raw = fs.readFileSync(manifestFile, \'utf8\');';
const bomParseLine = 'manifest = JSON.parse(raw);';
const bomNew = (() => {
  const idx = must(mainSrc.indexOf(bomRawLine), 'BOM raw 行（现场必须先手工打过 BOM 修复）');
  const end = must(mainSrc.indexOf(bomParseLine, idx), 'BOM parse 行');
  const start = lineStart(mainSrc, idx);
  return mainSrc.slice(start, end + bomParseLine.length);
})();

// ---------- 3. models client.js：4 段（css / persist / drag / li 头），old 取自未打备份 ----------
const MODELS_REL = 'node_modules/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js';
const MODELS_BAK = MODELS_REL + '.dpo-bak';
const modelsCur = read(MODELS_REL);
const modelsBak = read(MODELS_BAK);

// 4a. css 注入扩展段：anchor=未打的 css 注入块尾（tag.textContent=css$3 ... 到 var Models... 前）
const CSS_START = 'tag.textContent = css$3;';
const CSS_END = 'var ModelsSection_module_css_default';
const cssOld = segment(modelsBak, CSS_START, CSS_END, 'css 未打锚');
const cssNew = segment(modelsCur, CSS_START, CSS_END, 'css 已打段');

// 4b. persistProviderOrder：insertAfter anchor=removeProviderProfile 尾（needsSetup 注释前）
const NEEDS = '/**\n\t\t* Whether a whole-section provider still needs its first key';
const PERSIST_START = '/**\n\t\t* Persist one provider ordering';
const bakNeedsIdx = must(modelsBak.indexOf(NEEDS), 'bak needsSetup');
const curNeedsIdx = must(modelsCur.indexOf(NEEDS), 'cur needsSetup');
const persistAnchorStart = must(modelsBak.lastIndexOf('\t\t\tawait controller.load();\n\t\t}', bakNeedsIdx), 'persist anchor 起点');
const persistAnchor = modelsBak.slice(persistAnchorStart, bakNeedsIdx);
const persistInsert = modelsCur.slice(must(modelsCur.indexOf(PERSIST_START), 'persist 段'), curNeedsIdx);

// 4c. drag 状态块：insertAfter anchor=dismissedSetup 行（含行尾缩进，保证 anchor+insert 与文件逐字一致）
const DRAG_START = '// dsh-provider-order: provider row drag-to-reorder state.';
const ANNOUNCE = 'const announceSaved';
const DISMISSED = 'const [dismissedSetup, setDismissedSetup] = (0, react.useState)(() => /* @__PURE__ */ new Set());';
const dragAnchor = modelsBak.slice(must(modelsBak.indexOf(DISMISSED), 'dismissedSetup 行'), must(modelsBak.indexOf(DISMISSED), 'dismissedSetup 行') + DISMISSED.length) + '\n\t\t\t';
const dragInsert = modelsCur.slice(must(modelsCur.indexOf(DRAG_START), 'drag 段'), must(modelsCur.indexOf(ANNOUNCE, modelsCur.indexOf(DRAG_START)), 'announceSaved'));

// 4d. rowCard li 头：old=未打 return行+className 行，new=已打（多 6 事件属性）
const ROWCARD = 'className: ModelsSection_module_css_default["rowCard"]';
const CHILDREN = 'children: [(0, react_jsx_runtime.jsxs)("div", {';
const liOldStart = lineStart(modelsBak, must(modelsBak.indexOf(ROWCARD), 'bak rowCard')) ;
const liOldEnd = must(modelsBak.indexOf(CHILDREN, must(modelsBak.indexOf(ROWCARD), 'bak rowCard 2')) + CHILDREN.length, 'bak children');
const liNewStart = lineStart(modelsCur, must(modelsCur.indexOf(ROWCARD), 'cur rowCard'));
const liNewEnd = must(modelsCur.indexOf(CHILDREN, must(modelsCur.indexOf(ROWCARD), 'cur rowCard 2')) + CHILDREN.length, 'cur children');
const liOld = modelsBak.slice(liOldStart, liOldEnd);
const liNew = modelsCur.slice(liNewStart, liNewEnd);

// ---------- 校验提取结果自洽 ----------
const assert = (cond, msg) => { if (!cond) throw new Error('模板自检失败: ' + msg); };
assert(mainFuncDef.includes('window.__DSH_DROP_BRIDGE__'), 'mainFuncDef 缺少桥标记');
assert(cssNew !== cssOld, 'css 段未打/已打相同');
assert(persistInsert.includes('provider-order'), 'persist 段缺 ns');
assert(dragInsert.includes('finishDrag'), 'drag 段缺 finishDrag');
assert(liNew !== liOld && liNew.includes('zjMdl_'), 'li 段异常');
const countOf = (s, sub) => { let n = 0, i = 0; while ((i = s.indexOf(sub, i)) >= 0) { const before = s[i - 1]; if (before === '\n' || before === void 0) n++; i += sub.length; } return n; };
for (const call of mainCalls) assert(countOf(mainSrc, call.line) === call.expect, `main 调用点 ${JSON.stringify(call.line)} 数量!=${call.expect}`);

const modelsOps = [
  { kind: 'replace', old: cssOld, new: cssNew },
  { kind: 'insertAfter', anchor: persistAnchor, insert: persistInsert },
  { kind: 'insertAfter', anchor: dragAnchor, insert: dragInsert },
  { kind: 'replace', old: liOld, new: liNew },
];

const targets = {
  preload: {
    file: 'preload.js', check: '__DSH_DROP_BRIDGE__',
    ops: [
      { kind: 'replace', old: preloadOld, new: preloadNew },
      { kind: 'append', text: PRELOAD_BRIDGE },
    ],
  },
  main: {
    file: 'main.js', check: 'function applyDropInBridgeFix',
    // 函数定义插回原始位置（applyProfilePatchGuard 前），与手工 patch 位置一致，
    // 保证恢复产物逐字节等于原已打文件（函数声明 hoisting 不依赖位置，但位置一致最稳）。
    ops: [
      { kind: 'insertBefore', anchor: 'function applyProfilePatchGuard() {', insert: mainFuncDef },
      ...mainCalls,
    ],
  },
  models: {
    file: MODELS_REL, check: 'persistProviderOrder',
    ops: modelsOps,
  },
  'main-bom': {
    file: 'main.js', check: '0xfeff',
    ops: [
      { kind: 'replaceOnceIfMissing', check: '0xfeff', old: BOM_OLD, new: bomNew },
    ],
  },
};

// 干跑验证：把 ops 应用到未打语义上应得到已打语义（用 bak 模拟）
function dryRun(targets) {
  const results = {};
  for (const [name, t] of Object.entries(targets)) {
    let src = name === 'models' ? modelsBak : name === 'preload' ? preloadOld : null;
    if (src === null) src = name === 'main' ? mainCalls.reduce((acc, c) => acc.split(c.new).join(c.old), mainSrc) : null;
    if (src === null && name === 'main-bom') src = mainSrc.split(bomNew).join(BOM_OLD);
    // 仅校验 ops 结构可执行性由 index.js 负责，这里验证锚点存在性
    const probes = { models: [cssOld, persistAnchor, dragAnchor, liOld], preload: [preloadOld], main: mainCalls.map((c) => c.line), 'main-bom': [BOM_OLD] };
    const missing = probes[name].filter((p) => !src.includes(p));
    results[name] = missing.length === 0 ? '锚点完备' : `锚点缺失: ${missing.map((m) => m.slice(0, 40)).join(' | ')}`;
  }
  return results;
}

mkdirSync(path.join(__dirname, 'lib'), { recursive: true });
const out = { generatedFrom: APP, targets };
writeFileSync(path.join(__dirname, 'lib', 'templates.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('templates.json 已生成 ->', path.join(__dirname, 'lib', 'templates.json'));
console.log('dry-run:', JSON.stringify(dryRun(targets), null, 2));
console.log('mainFuncDef 长度:', mainFuncDef.length, '| persistInsert:', persistInsert.length, '| dragInsert:', dragInsert.length);