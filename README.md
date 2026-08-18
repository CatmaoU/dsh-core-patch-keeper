# dsh-core-patch-keeper

DSH Desktop 核心补丁守护（host 半，零运行时依赖）。

## 背景

DSH Desktop 升级会整体覆盖 `resources/app` 下的核心文件，导致本地维护的
3 处功能补丁丢失，需要手工重新打：

| 目标文件 | 补丁 | 功能 |
|---|---|---|
| `preload.js` | `webUtils` 拖放路径桥（`__DSH_DROP_BRIDGE__`） | Electron≥32 无 `File.path`，拖入文件取绝对路径（dsh-drop-in 依赖） |
| `main.js` | `applyDropInBridgeFix()` 定义 + 4 个启动调用点 | 每次启动幂等重打 preload 桥 |
| `@deepseek-ai/dsh-client-ui-settings-models/lib/client.js` | 模型商行拖拽排序（`persistProviderOrder` / `finishDrag` / DnD CSS） | 设置→模型 页面直接拖动调整模型商顺序，选择器同步 |

> 注：`dsh-host-apiproxy` 的 `WEB_SETTINGS_NAMESPACES` 白名单补丁已于 2026-08-17
> 移除（apiproxy 恢复出厂）：`@dsh-external/dsh-provider-order` 的持久化改走其
> 自身 webServer 路由（GET/PUT `/dsh-provider-order/order`），不再需要 settings
> 白名单；余额插件的 AccessKey 以 localStorage 为主通道，settings wire 仅兜底
> 且失败被吞，官方出厂状态即可工作。

本插件在每次启动时校验这 3 处补丁；缺失时用 `lib/templates.json` 中的
**精确模板**恢复（模板由 `extract-templates.mjs` 从已打文件 + 未打备份自动提取，
恢复产物与原补丁逐字节一致）。**锚点不匹配（核心文件行文已随版本变化）时跳过
并记日志，绝不硬改。**

## 安装

- 常规：放入 profile 插件目录（或 `link` 进 profile dependencies），重启生效。
- 自测：`node test.mjs`（模拟升级还原 → 恢复 → 逐字节比对 → 还原现场）。

## 升级 Desktop 后的行为

首次启动时日志（`~/.dsh/logs/core-patch-keeper.log` + 控制台）会显示
`✔ 已恢复补丁`；恢复前会把「未打版本」备份为 `<file>.dsh-keeper-prebak`
（恢复成功后可删）。若显示 `✓ 已在位，跳过` 表示无事发生。

## 模板再提取

升级后核心文件行文变化导致恢复跳过时，重新生成模板：

```sh
node extract-templates.mjs   # 读取 D:\dsh\resources\app（可用 DSH_DESKTOP_APP_DIR 覆盖）
```

前提：目标文件当前仍带补丁（或存在 `.dpo-bak` 未打备份供锚点提取）。
若手工补丁形态有变动，先手工打一次补丁，再提取，保证模板与新版一致。

## 安全设计

- 恢复前先备份（`.dsh-keeper-prebak`，仅首次）。
- 全部操作在内存完成 → 写临时文件 → `node --check` 语法校验通过后才替换。
- 任一锚点缺失/歧义/校验失败 → 放弃该文件，原文件保持不动。
- 幂等：补丁已在位时跳过；重复执行无副作用。
- 行尾（CRLF/LF）自动匹配目标文件。