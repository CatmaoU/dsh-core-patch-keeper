// dsh-core-patch-keeper 自测：模拟「DSH 升级覆盖核心文件（补丁丢失）」→ 运行恢复 →
// 逐字节比对恢复产物与原已打文件。任何失败最后都从备份还原现场（原文件不动）。
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatches } from './lib/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.DSH_DESKTOP_APP_DIR || 'D:\\dsh\\resources\\app';
const targets = JSON.parse(readFileSync(path.join(__dirname, 'lib', 'templates.json'), 'utf8')).targets;
const tmpDir = path.join(__dirname, '.selftest');
mkdirSync(tmpDir, { recursive: true });

const orig = {};   // name -> original absolute path
const backedUp = {};
const fails = [];
const report = (tag, ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'} [${tag}] ${msg}`); if (!ok) fails.push(`${tag}: ${msg}`); };

function revert(src, ops) {
  const nl = src.includes('\r\n') ? '\r\n' : '\n';
  const norm = (s) => (s == null ? s : s.replace(/\r\n/g, '\n').replace(/\n/g, nl));
  let s = src;
  // 正向执行各 op 的逆（外层扩展包含内层扩展，先还原外层再处理内层；无依赖时任意皆可）。
  for (const op of ops) {
    const o = {};
    for (const k in op) o[k] = typeof op[k] === 'string' ? norm(op[k]) : op[k];
    switch (o.kind) {
      case 'replace': s = s.split(o.new).join(o.old); break;
      case 'insertAfter': s = s.split(o.anchor + o.insert).join(o.anchor); break;
      case 'insertBefore': s = s.split(o.insert + o.anchor).join(o.anchor); break;
      case 'append': {
        // 桥块含「// ----」注释块 + IIFE，删除边界 = 注释块首行
        const marker = norm('// dsh-drop-in path bridge: Electron >= 32');
        if (s.endsWith(o.text)) s = s.slice(0, -o.text.length);
        else {
          const i = s.lastIndexOf(marker);
          if (i >= 0) {
            const bb = s.lastIndexOf('// ---------------------------------------------------------------------------', i);
            if (bb >= 0) s = s.slice(0, bb);
          }
        }
        break;
      }
      case 'replaceAllCalls': while (s.includes(o.new)) s = s.split(o.new).join(o.old); break;
      case 'insertLineAfter': {
        const eol2 = s.includes('\r\n') ? '\r\n' : '\n';
        const lines = s.split(eol2);
        const out = [];
        for (let i = 0; i < lines.length; i++) {
          if (lines[i] === o.insertLine) continue; // 已插行 → 删除
          out.push(lines[i]);
        }
        s = out.join(eol2);
        break;
      }
      case 'replaceOnceIfMissing': s = s.split(o.new).join(o.old); break;
    }
  }
  return s;
}
function syntaxOk(abs) {
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

console.log('== 1. 备份原始文件 ==');
for (const [name, t] of Object.entries(targets)) {
  const abs = path.join(APP, t.file);
  orig[name] = abs;
  const bak = path.join(tmpDir, name + '.orig');
  copyFileSync(abs, bak);
  backedUp[name] = bak;
  report(name, existsSync(bak), `已备份 → ${bak}`);
}

console.log('== 2. 模拟升级还原（逆向补丁） ==');
for (const [name, t] of Object.entries(targets)) {
  const src = readFileSync(orig[name], 'utf8');
  const reverted = revert(src, t.ops);
  writeFileSync(orig[name], reverted, 'utf8');
  const stillPatched = reverted.includes(t.check);
  report(name, !stillPatched, `补丁已清除（check="${t.check.slice(0, 30)}…" 不再命中）`);
  report(name + '-syntax', syntaxOk(orig[name]), `还原后语法合法`);
}

console.log('== 3. 运行 keeper 恢复 ==');
const result = applyPatches(APP, console.log);

console.log('== 4. 恢复产物对比与校验 ==');
for (const [name, t] of Object.entries(targets)) {
  const patched = readFileSync(orig[name], 'utf8');
  const expected = readFileSync(backedUp[name], 'utf8');
  const okCheck = patched.includes(t.check);
  report(name + '-check', okCheck, `补丁已恢复（check 命中）`);
  report(name + '-bytes', patched === expected, `恢复产物与原已打文件逐字节一致（${patched.length} bytes）`);
  report(name + '-syntax2', syntaxOk(orig[name]), `恢复后语法合法`);
}

console.log('== 5. 还原现场（from 备份） ==');
for (const [name, t] of Object.entries(targets)) {
  copyFileSync(backedUp[name], orig[name]);
  report(name, readFileSync(orig[name], 'utf8') === readFileSync(backedUp[name], 'utf8'), '现场已还原');
}
rmSync(tmpDir, { recursive: true, force: true });

console.log(fails.length === 0 ? '\nALL PASS ✔ 恢复链路无损' : `\n${fails.length} FAILED:\n` + fails.join('\n'));
process.exit(fails.length === 0 ? 0 : 1);