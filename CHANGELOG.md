# Changelog

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.26] - 2026-09-19

### Fixed
- **兼容推理型模型输出**：MiniMax-M3 等模型会在 JSON 前输出 `<think>…</think>` 推理块，旧的 `match(/\[[\s\S]*?\]/)` 会误抓推理过程中的方括号导致解析失败。现先剥离 `<think>` 块与 markdown 代码围栏，再用贪婪匹配提取 JSON 数组。

### Note
- v1.0.25 报错 `AI Provider Request Failed (401): login fail: Please carry the API secret key` 的根因在**平台端**：`packages/core/di/ai-service.ts` 的密钥解密与 `server/utils/crypto.ts` 分叉，后者有 `.env` 回退而前者没有，导致插件 `ctx.services.ai.generateText()` 把密文当 Bearer 发出。已在 openlearnv2 仓库修复（新增 `packages/core/di/api-key-crypto.ts` 作为唯一事实来源，`AIService` 改用共享 `decryptApiKey` 并在解密失败时抛出明确错误）；本插件侧只需重启服务后重试。

## [1.0.25] - 2026-09-19

### Fixed
- **修复插件上传 HTTP 500：移除 `node:fs` / `node:path` 动态导入**。`grade.analyze_score_fields` 原先用 `await import('node:path')` + `await import('node:fs/promises')` 读取 `storage/courseware/{uuid}/{entry}`，被平台 `openlearn-token-enforcer` 在打包阶段拒绝（`Import of "node:path" is not allowed`），导致 `/api/plugins/upload-zip-raw` 返回 HTTP 500。现将课件源码获取改为双通道，不再触碰任何 Node 内置模块：
  1. **前端优先**：点击 AI 分析时先 `fetch('/runtime/{uuid}/')` 取平台已渲染的入口 HTML（该路由自带磁盘自愈，可覆盖仅存于磁盘的「自动提交版」课件），降级则传 `htmlContent` 给后端；
  2. **后端兜底**：未收到 `htmlContent` 时改由数据库读取 —— 优先 `vfs_nodes.content`，再回退 `system_resources`（按 id/uuid/名称关联；`folder` 型解析文件数组并选取入口），与平台 `server/routes/bridge.ts` 的自愈逻辑一致。
- 移除了已不再需要的 `process.cwd()` 磁盘路径拼接（`@types/node` 保留作为通用开发依赖）。

### Verified
- 用平台同款 `openlearn-token-enforcer`（onResolve 仅放行相对路径与 `@openlearn/*`）对本包 `dist/index.js` 复刻打包，验证 **通过、无报错**；包内 `index.js` / `frontend.js` 已无任何 `node:*` 导入。

## [1.0.24] - 2026-09-19

### Changed
- 重新构建并打包，供平台端二次验证（包含 v1.0.23 的 ✨ AI 成绩变量识别功能与 `@types/node` 类型修复，产物无逻辑变更）。

## [1.0.23] - 2026-09-19

### Added
- **AI 智能识别成绩变量**：配置面板「成绩变量」文本框右上角新增 ✨ AI 分析图标按钮（选定课件后出现），调用平台 AI Provider（`ctx.services.ai.generateText`）读取课件 HTML 源码，识别可能表示学生成绩的 JS 变量（支持 `result.score` 等点号路径）；弹窗勾选后一键回填 `score_fields`，已配置变量自动置灰去重，可「重新分析」。
- 新增命令 `grade.analyze_score_fields`：读取 `storage/courseware/{uuid}/{entry}`（限 60 KB）后以低温度提示词约束 AI 仅输出 JSON 数组，并做容错解析（非 JSON 时返回空候选并附原始响应）。

### Fixed
- `scripts/bump-version.js` 现在同步更新根目录 `manifest.json` 的 `version`，避免打包 ZIP 内 manifest 版本与 `package.json` / `src/index.ts` 不一致。
- 补充开发依赖 `@types/node`：修复 `src/index.ts` 中 `process.cwd()` 等 Node 全局的类型报错，`npx tsc --noEmit` 现为 0 错误（不影响 `esbuild` 打包产物）。

## [1.0.22] - 2026-09-19

### Fixed
- **声明 `executionMode: 'inline'`**：插件在 `grade.list_courseware` 和 `grade.list_configs` 中直接查询平台核心表（`courseware`、`lessons`），在 Worker 沙箱中触发 `WorkerCapabilityError: forbidden from accessing core security table`，导致课件列表与配置列表始终为空。显式声明 `executionMode: 'inline'` 使插件在受信任内联模式中运行，解除核心表访问限制。
- **升级 `@openlearn/plugin-sdk` 至 `^3.6.1`**：旧版 `^3.4.3` 存在 `node:fs`/`node:path` 透传进 bundle 的问题，上传时会被平台 token-enforcer 拦截报 HTTP 500；`3.6.1` 已上游修复，bundle 体积由 ~130 KB 降至更小。
- **补充根目录 `manifest.json`**：确保 `openlearn-plugin-sdk build` 打包时 100% 精确读取 `executionMode: 'inline'`，不依赖 bundle 内代码提取回退逻辑。

## [1.0.21] - 2026-09-05

### Added
- 配置列表「归属课时」改为可点击链接，点击跳转到课程编辑器展示对应课时
  （依赖宿主 `navigation.setSelectedLesson` API，需宿主 plugin-host.ts 同步支持）

## [1.0.20] - 2026-09-05

### Changed
- 配置面板宽度改为 100%（铺满可用空间，移除 maxWidth 限制）
- 配置列表「归属课时」列改为显示可读课时名称（LEFT JOIN lessons.title），不再显示裸 ID

## [1.0.19] - 2026-09-05

### Changed（架构重构）
- **方案 A**：从「自绘 iframe + postMessage 桥 + ZIP 解构」重构为接入平台原生 `html-applet` 课件体系
- 得分链路改为订阅平台原生事件 `courseware.attempt_submitted`（不再自建 postMessage 上报）
- 前端从「播放器 / 编辑器 / 白板组件」收敛为单个 `teacher.tab` 配置面板
- 体积由 ~728 KB 降至 ~130 KB

### Added
- 自定义成绩变量（`score_fields`）：支持多个变量名（逗号/分号/换行分隔）与点号嵌套路径（如 `result.score`），优先于平台默认提取，取不到再回退默认
- 多尝试留分策略真正实现（`MAX` / `LATEST` / `AVERAGE`），新增 `grade_attempts` + `grade_summary` 表做聚合
- 配置分页列表（`grade.list_configs`）+ 新增 / 编辑 / 删除（`grade.set_config` / `grade.delete_config`）
- 归属课时可读名称显示（`grade.get_lesson` 命令查 `lessons.title`）
- 积分台账（`IPointsLedgerService.addPoints`）与学期成绩（`ISemesterGradeService.saveSemesterGrade`）双同步
- 积分维度注册（`IPointsDimensionRegistry.registerDimension`，id=`interactive_courseware`）

### Fixed
- Worker 模式数据库访问：所有 `db.prepare().run/get/all` 均 `await`，修复 `#<Promise> could not be cloned`
- 课件名称显示为 `cw_xxx` 而非友好文件名的问题
- 原 `awardPoints`（方法不存在）、`socketService.emit`（方向错误）导致的成绩断链

### Removed
- 自绘组件：`CoursewarePlayer` / `CoursewareEditor` / `WhiteboardWidget`
- 自绘工具：`zipBundler` / `postMessageBridge` / `scoreExtractor` / `coursewareTemplates`

## [1.0.18] - 2026-07-29

- 初始可分发版本（自绘 iframe 播放器 / 编辑器 / ZIP 解构 / postMessage 桥接 / 成绩推导引擎）
