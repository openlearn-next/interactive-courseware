# Changelog

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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
