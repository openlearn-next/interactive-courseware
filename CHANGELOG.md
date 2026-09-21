# Changelog

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.28] - 2026-09-21

### Added
- **接管平台「分数变量监视器」的采样结果，让留分策略真正有样本可用**。平台原生 `server/utils/bridge-sdk.ts` 新增了分数变量监视器：它会随 Bridge SDK 注入课件 iframe，持续观察课件内的分数变量（`window` 上的分数语义全局变量、`window.__LMS_WATCH__` 显式声明、以及分数类 DOM 元素的**可见**文本），一旦发生变化就以 `LMS.saveProgress` 上报一次样本，快照落在 `submission_raw.payload_json.watch` 与 `submission_result.extra_json.watch`。插件侧配套：
  - **新增命令 `grade.list_watch_variables`**：从该课件最近一条含 `watch` 快照的上报里取出变量名，供配置页做候选，教师不必手写变量名；返回 `{ variables, sampledAt, changed }`，变量名统一带 `watch.` 前缀；
  - **配置页「成绩变量」支持点击选用**（`src/frontend.tsx`）：在变量输入框下方渲染「平台已监视到的变量（点击选用）」胶囊按钮组并显示最近样本时间，点击即增删 `score_fields` 条目（已选显示 `✓`）；尚无样本时提示「先让学生端打开一次该课件」；
  - 变量填写格式随之明确为点路径，如 `watch.userScore`、`watch.score`、`watch.dom__score`（`dom__score` 是 DOM 兜底键名，用于覆盖把分数只写进 `#score` 而完全不调用 `LMS.*` 的静态课件）。

### Fixed
- **修复「多次作答留分策略」永远退化为 LATEST**。此前聚合只在 `grade_attempts` 上按 `attempt_id` 取值，而一个学生在一个课件上只会复用同一条 active attempt（该表恒为一行），所以 `score_policy` 的 `MAX` / `AVERAGE` 分支永远不可能生效。现改为读取**样本历史**：`SELECT payload_json FROM submission_raw WHERE attempt_id = ? ORDER BY created_at ASC`，逐行解析后按 `score_fields`（未配置时回退 `payload.score`）取分，得到完整样本序列再交给 `aggregateScores(samples, policy)`；读不到样本时回退本次上报分。`grade_attempts` 仍保留为 attempt 级最新值，默认策略 `LATEST` 的行为与升级前一致。

## [1.0.27] - 2026-09-21

### Fixed
- **修复归属守卫失效：教师预览分与匿名访客分会被写进真实成绩册**。`src/index.ts` 的守卫写作 `studentId === 'teacher_preview'`，但平台 `injectLmsSdk`（`server/routes/shared.ts`）实际写入 `courseware_attempt.student_id` 的哨兵是 `'teacher'`（教师/管理员预览）与 `'guest'`（匿名无 cookie 访问），**从不出现 `'teacher_preview'`** —— 该守卫等于永不生效。一旦课件配置了「归属课时」，教师预览或匿名访客的提交就会被 `saveSemesterGrade` 当作真实学生写入学期成绩册，并向积分台账加发积分。
  - 现改为 `isRealStudent()` 归属守卫：先排除 `teacher` / `teacher_preview` / `guest` / `admin` 哨兵，再回查 `students` 主表确认归属者确实是真实学生（查询异常时 fail-closed 视为非学生），未通过则记录日志并直接跳过归集。
  - 守卫位置前置到读取课时/班级之前，避免为无效提交做无谓的配置查询。

### Changed
- **成绩配置面板明确「分数去向」**：此前「课件内部原始满分 / 折算为平台标准满分 / 课程总成绩权重 (%)」三者并排，容易让教师误以为权重会影响学期成绩。实际口径是：学期成绩册写入 `聚合分 ÷ 课件内部原始满分 × 折算为平台标准满分`（**未加权**，且必须填写「归属课时」），积分台账才用 `该归一化分 × 权重%` 且只增不减。现在面板顶部新增「分数去向」说明卡片，并在三个字段标签中直接标注各自的作用域。

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
