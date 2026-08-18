// dsh-core-patch-keeper — DSH Desktop 核心补丁守护（host 半，纯 ESM，零运行时依赖）。
//
// 职责：DSH Desktop 升级会整体覆盖 resources/app 下的核心文件（preload.js、
// main.js、@deepseek-ai/dsh-host-apiproxy、dsh-client-ui-settings-models），
// 使本地维护的 3 处功能补丁丢失（拖放路径桥、设置命名空间白名单、模型商拖拽排序）。
// 本插件在接入时校验这些补丁是否存在，缺失且模板锚点能精确匹配时自动恢复；
// 锚点不匹配（核心文件行文已随版本变化）则跳过并记录，绝不硬改。
//
// 模板由 extract-templates.mjs 从「已打补丁的文件 + 未打备份」精确提取而来
// （lib/templates.json），恢复产物与原补丁逐字节一致。
import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const name = 'dsh-core-patch-keeper';
const inject = [];
const Config = z.object({});

/** 探测 Desktop 的应用目录（resources/app）：env 覆盖 → 本机已知路径 → execPath 推导。 */
export function detectAppDir() {
  const candidates = [];
  if (process.env.DSH_DESKTOP_APP_DIR) candidates.push(process.env.DSH_DESKTOP_APP_DIR);
  candidates.push('D:\\dsh\\resources\\app');
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'dsh-desktop', 'resources', 'app'));
  try {
    const fromExe = path.resolve(path.dirname(process.execPath || ''), 'resources', 'app');
    if (fromExe) candidates.push(fromExe);
  } catch {}
  for (const c of candidates) {
    try {
      if (c && existsSync(path.join(c, 'main.js')) && existsSync(path.join(c, 'preload.js'))) return c;
    } catch {}
  }
  return null;
}

/** 行首计数：只统计 sub 出现在行首（前一字符是 \n 或文件起）的次数，避免子串串扰。 */
function lineCount(src, sub) {
  let n = 0, i = 0;
  while ((i = src.indexOf(sub, i)) >= 0) {
    const before = src.charCodeAt(i - 1);
    if (before === 10 || isNaN(before)) n++;
    i += sub.length;
  }
  return n;
}

function applyOp(src, op) {
  switch (op.kind) {
    case 'replace': {
      const count = src.split(op.old).length - 1;
      if (count === 0) throw new Error(`锚点缺失: ${op.old.slice(0, 60)}…`);
      if (count > 1) throw new Error(`锚点歧义（出现 ${count} 次）: ${op.old.slice(0, 60)}…`);
      return src.replace(op.old, op.new);
    }
    case 'insertAfter': {
      const count = src.split(op.anchor).length - 1;
      if (count !== 1) throw new Error(`insert 锚点 ${count !== 0 ? '歧义' : '缺失'}: ${op.anchor.slice(0, 60)}…`);
      return src.replace(op.anchor, op.anchor + op.insert);
    }
    case 'insertBefore': {
      const count = src.split(op.anchor).length - 1;
      if (count !== 1) throw new Error(`insertBefore 锚点 ${count !== 0 ? '歧义' : '缺失'}: ${op.anchor.slice(0, 60)}…`);
      return src.replace(op.anchor, op.insert + op.anchor);
    }
    case 'append':
      return src + op.text;
    case 'insertLineAfter': {
      // 整行精确匹配（行尾由目标文件决定），避免 4 空格缩进模板串扰 6 空格行。
      const eol = src.includes('\r\n') ? '\r\n' : '\n';
      const wantInsert = typeof op.insertLine === 'string' && op.insertLine.length > 0;
      const inserted = { probe: op.insertLine, count: 0 };
      const lines = src.split(eol);
      const cleaned = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (wantInsert && line === op.insertLine) { inserted.count++; continue; }
        cleaned.push(line);
      }
      let found = 0;
      for (const line of cleaned) if (line === op.line) found++;
      if (found === 0) throw new Error(`调用行缺失: ${op.line.trim()}`);
      if (found > op.expect) throw new Error(`调用行数(${found})超出预期(${op.expect})，中止`);
      const applied = [];
      for (const line of cleaned) {
        if (line === op.line) {
          applied.push(line);
          if (wantInsert) { applied.push(op.insertLine); inserted.count++; }
        } else applied.push(line);
      }
      if (inserted.count < op.expect && inserted.count !== found) {
        throw new Error(`调用插入后数量(${inserted.count})==预期(${op.expect})? 校验不过`);
      }
      return applied.join(eol);
    }
    case 'replaceOnceIfMissing': {
      if (src.includes(op.check)) return src;
      const count = src.split(op.old).length - 1;
      if (count !== 1) throw new Error(`按需插入锚点异常（${count} 次）`);
      return src.replace(op.old, op.new);
    }
    default:
      throw new Error(`未知操作: ${op.kind}`);
  }
}

/** 语法校验：写临时文件跑 node --check；无法校验（非 node 环境）视为失败以保住安全。 */
function syntaxErrorOf(absPath) {
  try {
    const r = spawnSync(process.execPath, ['--check', absPath], { encoding: 'utf8', timeout: 20000 });
    if (r.error) return `无法运行 node --check: ${r.error.message}`;
    if (r.status !== 0) return (r.stderr || r.stdout || '').split('\n').slice(0, 6).join(' | ');
    return null;
  } catch (e) { return `node --check 异常: ${e.message}`; }
}

/** 恢复单个目标文件；返回 'ok' | 'skipped' | 'failed'。全部操作在内存完成，写盘前语法校验。 */
function repairTarget(appDir, target, log) {
  const abs = path.join(appDir, target.file);
  let src;
  try { src = readFileSync(abs, 'utf8'); } catch (e) {
    log(`✗ ${target.file}: 读取失败（${e.message}）`);
    return 'failed';
  }
  // 行尾统一：模板按目标文件的行尾（CRLF/LF）重写，兼容 Windows 核心文件与 npm 包文件。
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const norm = (s) => (s == null ? s : s.replace(/\r\n/g, '\n').replace(/\n/g, nl));
  const ops = target.ops.map((op) => {
    const n = {};
    for (const k in op) n[k] = typeof op[k] === 'string' ? norm(op[k]) : op[k];
    return n;
  });
  if (src.includes(norm(target.check))) {
    log(`✓ ${target.file}: 补丁已在位，跳过`);
    return 'ok';
  }
  log(`→ ${target.file}: 补丁缺失，尝试恢复…`);
  let next = src;
  try {
    for (const op of ops) next = applyOp(next, op);
  } catch (e) {
    log(`✗ ${target.file}: ${e.message}（原文件未修改）`);
    return 'failed';
  }
  if (next === src) { log(`✗ ${target.file}: 恢复结果未变化，跳过`); return 'failed'; }
  // 备份（仅首次）后原子写：tmp（.js 后缀供 node --check）→ 语法校验 → 替换
  const bak = abs + '.dsh-keeper-prebak';
  const tmp = abs + '.dsh-keeper-tmp.js';
  try {
    if (!existsSync(bak)) copyFileSync(abs, bak);
    writeFileSync(tmp, next, 'utf8');
    const syntaxErr = syntaxErrorOf(tmp);
    if (syntaxErr) {
      rmSync(tmp, { force: true });
      log(`✗ ${target.file}: 恢复内容未通过语法校验（${syntaxErr}），未写入（原文件保持未打状态，备份 ${path.basename(bak)} 可用）`);
      return 'failed';
    }
    copyFileSync(tmp, abs);
    rmSync(tmp, { force: true });
    log(`✔ ${target.file}: 已恢复补丁（原文件备份 ${path.basename(bak)}）`);
    return 'ok';
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    log(`✗ ${target.file}: 写入失败（${e.message}），原文件未动`);
    return 'failed';
  }
}

/** 主入口：校验并恢复全部补丁。可被 cordis apply 调用，也可被自测脚本直接调用。 */
export function applyPatches(appDir, log) {
  if (!appDir) { log('✗ 未定位到 DSH Desktop 应用目录（可设 DSH_DESKTOP_APP_DIR 覆盖）'); return { ok: false }; }
  const tplPath = path.join(__dirname, 'templates.json');
  if (!existsSync(tplPath)) { log(`✗ 模板缺失: ${tplPath}`); return { ok: false }; }
  let targets;
  try { targets = JSON.parse(readFileSync(tplPath, 'utf8')).targets; } catch (e) {
    log(`✗ 模板解析失败: ${e.message}`);
    return { ok: false };
  }
  const report = {};
  for (const [name, target] of Object.entries(targets)) {
    report[name] = repairTarget(appDir, target, log);
  }
  const anyOk = Object.values(report).some((s) => s === 'ok');
  return { ok: true, report };
}

/** cordis 插件 apply：同步执行一次（文件操作小、幂等）。 */
export function apply(ctx) {
  let l = console.log;
  const logFile = (() => {
    try {
      const dir = path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'logs');
      mkdirSync(dir, { recursive: true });
      return path.join(dir, 'core-patch-keeper.log');
    } catch { return null; }
  })();
  const log = (...parts) => {
    const line = `[core-patch-keeper ${new Date().toISOString()}] ${parts.join(' ')}`;
    try { l(line); } catch {}
    if (logFile) { try { appendFileSync(logFile, line + '\n', 'utf8'); } catch {} }
  };
  try {
    if (ctx && ctx.logger && typeof ctx.logger.info === 'function') l = (...a) => { try { ctx.logger.info?.(a.join(' ')); } catch {} };
  } catch {}
  const appDir = detectAppDir();
  const result = applyPatches(appDir, log);
  log(result.ok ? '本轮校验完成' : '本轮校验未完成', JSON.stringify(result.report || {}));
}

export { Config, name, inject };
export default { name, inject, Config, apply };