/**
 * 互动网页课件插件 —— 服务端入口 (dist/index.js)
 *
 * 遵循 OpenLearn v0.7.x 平台规范：
 *   - 对齐 ActionRegistry default-deny 机制，登记全部对外 Command 描述符与 RBAC 权限；
 *   - 规范 capabilitiesProposed 真实权限全集（lesson:read/write, management:read/write, student:write）；
 *   - 优先写透宿主原生 courseware.save_score_config，保持官方成绩口径一致；
 *   - 监听原生事件 courseware.attempt_submitted，进行积分台账增量发放与学期成绩同步；
 *   - 提供 AI 课件源码成绩变量智能审计 Action 与已监视变量发现。
 */

import type { PluginContext } from '@openlearn/plugin-sdk';
import {
  IDatabaseToken,
  IActionRegistryServiceToken,
  IPointsLedgerServiceToken,
  IPointsDimensionRegistryToken,
  ISemesterGradeServiceToken,
} from '@openlearn/plugin-sdk';

const POINTS_DIMENSION_ID = 'interactive_courseware';
const SUBMIT_EVENT = 'courseware.attempt_submitted';

type ScorePolicy = 'MAX' | 'LATEST' | 'AVERAGE';

const DEFAULT_CONFIG = {
  raw_full_score: 100,
  target_full_score: 100,
  weight_percentage: 10,
  score_policy: 'LATEST' as ScorePolicy,
  score_fields: '',
  lesson_id: '',
};

/**
 * 非真实学生的 attempt 归属标识。
 *
 * `injectLmsSdk` 在无法识别/无会话时写入 courseware_attempt.student_id 的哨兵值：
 *   - 'teacher' / 'teacher_preview' → 教师或管理员预览
 *   - 'guest'                       → 匿名、无 cookie 访问
 *   - 'admin'                       → 管理员调试
 * 这类记录绝不允许写入学期成绩册或积分台账，避免污染真实学生学情数据。
 */
const NON_STUDENT_OWNERS = new Set(['teacher', 'teacher_preview', 'guest', 'admin']);

/**
 * 归属守卫：确认 attempt 的归属者确实是 `students` 表中的真实学生。
 * fail-closed —— 查询异常或不存在一律视为非真实学生。
 */
async function isRealStudent(db: any, studentId: string): Promise<boolean> {
  const id = String(studentId || '');
  if (!id || NON_STUDENT_OWNERS.has(id)) return false;
  try {
    const row = await db.prepare('SELECT id FROM students WHERE id = ? LIMIT 1').get(id);
    return !!row;
  } catch {
    return false;
  }
}

function getNested(raw: any, path: string): any {
  if (!raw || typeof raw !== 'object') return undefined;
  const parts = path.trim().split('.');
  let cur = raw;
  for (const p of parts) {
    if (!p) continue;
    if (cur && typeof cur === 'object' && p in cur) cur = cur[p];
    else return undefined;
  }
  return cur;
}

function toNumber(v: any): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.endsWith('%')) {
      const n = parseFloat(s.slice(0, -1));
      return Number.isNaN(n) ? null : n;
    }
    const n = parseFloat(s);
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function parseScoreFields(fields: string): string[] {
  if (!fields || !fields.trim()) return [];
  return fields.split(/[,，;；\n\r]+/).map((s) => s.trim()).filter(Boolean);
}

function extractScoreFromFields(raw: any, fields: string[]): number | null {
  for (const f of fields) {
    const n = toNumber(getNested(raw, f));
    if (n !== null) return n;
  }
  return null;
}

function aggregateScores(scores: number[], policy: ScorePolicy): number {
  if (!scores.length) return 0;
  if (policy === 'MAX') return Math.max(...scores);
  if (policy === 'AVERAGE') return scores.reduce((s, x) => s + x, 0) / scores.length;
  return scores[scores.length - 1]; // LATEST
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(v, hi));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 从平台数据库读取课件入口 HTML 源码。
 * 遵循沙箱安全规范，不使用 node:fs/node:path，而是从平台已持久化的数据表中检索。
 */
async function loadCoursewareHtml(db: any, cw: any): Promise<{ html: string; source?: string; error?: string }> {
  const norm = (s: any) => String(s || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

  const pickEntryFromFiles = (files: any[], entry: string): string => {
    if (!Array.isArray(files) || files.length === 0) return '';
    const wanted = norm(entry);
    const base = wanted.split('/').pop() || '';
    const byExact = files.find((f) => norm(f?.path) === wanted);
    if (byExact?.content !== undefined) return String(byExact.content);
    const byBase = files.find((f) => (norm(f?.path).split('/').pop() || '') === base);
    if (byBase?.content !== undefined) return String(byBase.content);
    const index = files.find((f) => /(^|\/)index\.html?$/.test(norm(f?.path)));
    if (index?.content !== undefined) return String(index.content);
    const anyHtml = files.find((f) => /\.html?$/.test(norm(f?.path)));
    if (anyHtml?.content !== undefined) return String(anyHtml.content);
    return '';
  };

  // 1) vfs_nodes
  try {
    if (cw?.id) {
      const node = (await db.prepare("SELECT content FROM vfs_nodes WHERE id = ? AND type = 'file'").get(cw.id)) as any;
      if (node?.content) return { html: String(node.content), source: 'vfs_nodes' };
    }
  } catch {
    // 忽略异常，继续尝试 system_resources
  }

  // 2) system_resources
  try {
    let row: any = null;
    if (cw?.uuid || cw?.id) {
      row = (await db.prepare('SELECT id, name, type, content FROM system_resources WHERE id = ? OR id = ?').get(cw.uuid || '', cw.id || '')) as any;
    }
    if (!row && cw?.name) {
      const nameCandidate = String(cw.name).endsWith('.html') ? cw.name : `${cw.name}.html`;
      row = (await db.prepare('SELECT id, name, type, content FROM system_resources WHERE name = ? OR name = ?').get(cw.name, nameCandidate)) as any;
    }
    if (row?.content) {
      if (row.type === 'folder') {
        let files: any[] = [];
        try { files = JSON.parse(row.content); } catch { files = []; }
        const html = pickEntryFromFiles(files, cw?.entry || '');
        if (html) return { html, source: 'system_resources:folder' };
      } else {
        return { html: String(row.content), source: 'system_resources:html' };
      }
    }
  } catch {
    // 忽略异常
  }

  return { html: '', error: '未能在平台数据库中定位课件源码（vfs_nodes / system_resources 均未命中）' };
}

export default {
  manifest: {
    id: 'openlearn-plugin-interactive-courseware',
    name: '互动网页课件插件',
    version: '1.0.34',
    main: 'index.js',
    executionMode: 'inline',
    description: '接入平台原生 html-applet 课件，支持自定义成绩变量与 MAX/AVERAGE 多尝试留分，加权计入课程总成绩册与积分台账',
    author: 'OpenLearn Developer',
    engines: { openlearn: '>=0.7.0' },
    requires: [
      '@openlearn/core:ICommandBusService@^1.0.0',
      '@openlearn/core:IActionRegistryService@^1.0.0',
      '@openlearn/core:IEventBusService@^1.0.0',
      '@openlearn/core:IDatabase@^1.0.0',
      '@openlearn/core:IPointsLedgerService@^1.0.0',
      '@openlearn/core:IPointsDimensionRegistry@^1.0.0',
      '@openlearn/core:ISemesterGradeService@^1.0.0',
    ],
    capabilitiesProposed: [
      'lesson:read',
      'lesson:write',
      'management:read',
      'management:write',
      'student:write',
    ],
    contributes: {
      'teacher.tab': [
        {
          id: 'tab_interactive_courseware_grade',
          label: '互动网页课件',
          icon: 'Globe',
          position: 20,
        },
      ],
      'editor.palette_item': [
        {
          id: 'openlearn-plugin-interactive-courseware/interactive-board',
          type: 'openlearn-plugin-interactive-courseware/interactive-board',
          labelZh: '互动网页课件',
          labelEn: 'Interactive Courseware',
          descriptionZh: '在备课画板中插入互动课件与成绩留分配置图元',
          descriptionEn: 'Insert interactive courseware with grading rules',
          color: 'indigo',
          group: 'media',
          icon: 'FileCheck',
          defaultData: {
            title: '互动网页课件任务',
            scorePolicy: 'LATEST',
            rawFullScore: 100,
            targetFullScore: 100,
            weightPercentage: 10,
          },
        },
      ],
    },
    classroomTools: [
      {
        id: 'tool_interactive_courseware',
        name: '课件成绩',
        icon: 'FileCheck',
        commandType: 'grade.list_configs',
        payload: { lessonId: '$lessonId' },
      },
    ],
  },

  async activate(ctx: PluginContext) {
    const { commandBus, eventBus } = ctx.services;
    const actionRegistry = ctx.services.actionRegistry || (await ctx.resolve(IActionRegistryServiceToken).catch(() => null));

    // ── 1. 命名空间隔离表 ──
    await ctx.db.ensureTable('grade_configs', `
      courseware_id     TEXT PRIMARY KEY,
      courseware_name   TEXT NOT NULL DEFAULT '',
      raw_full_score    REAL NOT NULL DEFAULT 100,
      target_full_score REAL NOT NULL DEFAULT 100,
      weight_percentage REAL NOT NULL DEFAULT 10,
      score_policy      TEXT NOT NULL DEFAULT 'LATEST',
      score_fields      TEXT NOT NULL DEFAULT '',
      lesson_id         TEXT NOT NULL DEFAULT '',
      updated_at        INTEGER NOT NULL
    `);
    await ctx.db.ensureTable('grade_attempts', `
      attempt_id    TEXT PRIMARY KEY,
      courseware_id TEXT NOT NULL,
      student_id    TEXT NOT NULL,
      score         REAL NOT NULL,
      submitted_at  INTEGER NOT NULL
    `);
    await ctx.db.ensureTable('grade_summary', `
      courseware_id     TEXT NOT NULL,
      student_id        TEXT NOT NULL,
      aggregate_score   REAL NOT NULL,
      awarded_weighted  REAL NOT NULL DEFAULT 0,
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY (courseware_id, student_id)
    `);
    const configsTable = ctx.db.table('grade_configs');
    const attemptsTable = ctx.db.table('grade_attempts');
    const summaryTable = ctx.db.table('grade_summary');

    // ── 2. 解析内核服务 ──
    let db: any = null;
    let pointsLedger: any = null;
    let dimensionRegistry: any = null;
    let semesterGrade: any = null;

    try {
      db = await ctx.resolve(IDatabaseToken);
    } catch (e) {
      ctx.log.warn('IDatabaseToken 解析失败，成绩归集将不可用', { error: String(e) });
    }
    try {
      pointsLedger = await ctx.resolve(IPointsLedgerServiceToken);
      dimensionRegistry = await ctx.resolve(IPointsDimensionRegistryToken);
      semesterGrade = await ctx.resolve(ISemesterGradeServiceToken);
    } catch (e) {
      ctx.log.warn('积分/学期成绩服务解析失败，部分同步将被跳过', { error: String(e) });
    }

    // ── 2b. 防御：旧表缺 score_fields 列则补列 ──
    if (db) {
      try {
        const cols = (await db.prepare(`PRAGMA table_info(${configsTable})`).all()) as any[];
        if (Array.isArray(cols) && !cols.some((c: any) => c.name === 'score_fields')) {
          await db.prepare(`ALTER TABLE ${configsTable} ADD COLUMN score_fields TEXT NOT NULL DEFAULT ''`).run();
        }
      } catch (e) {
        // 表不存在等情况忽略
      }
    }

    // ── 3. 注册积分维度 ──
    try {
      dimensionRegistry?.registerDimension?.({
        id: POINTS_DIMENSION_ID,
        name: '互动网页课件',
        category: 'plugin',
        defaultWeight: 0.1,
        maxScore: 100,
        description: '互动网页课件作答加权得分',
        pluginId: ctx.pluginId,
      });
    } catch (e) {
      ctx.log.warn('积分维度注册失败', { error: String(e) });
    }

    // ── 4. 注册 AI Action（满足内核 default-deny 门禁） ──
    if (actionRegistry) {
      try {
        await actionRegistry.register({
          id: 'grade-list-courseware',
          commandType: 'grade.list_courseware',
          description: '列出平台当前已导入的所有课件元信息',
          capabilityRequired: 'lesson:read',
          inputSchema: {
            type: 'OBJECT',
            properties: {},
          },
        });

        await actionRegistry.register({
          id: 'grade-get-lesson',
          commandType: 'grade.get_lesson',
          description: '根据课时 ID 查询课时标题与基本信息',
          capabilityRequired: 'lesson:read',
          inputSchema: {
            type: 'OBJECT',
            properties: {
              lessonId: { type: 'STRING', description: '课时 ID' },
            },
            required: ['lessonId'],
          },
        });

        await actionRegistry.register({
          id: 'grade-list-configs',
          commandType: 'grade.list_configs',
          description: '分页查询互动课件的成绩换算与留分策略配置列表',
          capabilityRequired: 'lesson:read',
          inputSchema: {
            type: 'OBJECT',
            properties: {
              page: { type: 'INTEGER', description: '页码（默认 1）' },
              pageSize: { type: 'INTEGER', description: '每页条数（默认 10）' },
              lessonId: { type: 'STRING', description: '可选课时 ID 过滤' },
            },
          },
        });

        await actionRegistry.register({
          id: 'grade-get-config',
          commandType: 'grade.get_config',
          description: '读取指定课件的成绩配置（优先平台原生口径）',
          capabilityRequired: 'lesson:read',
          inputSchema: {
            type: 'OBJECT',
            properties: {
              coursewareId: { type: 'STRING', description: '课件 ID' },
            },
            required: ['coursewareId'],
          },
        });

        await actionRegistry.register({
          id: 'grade-set-config',
          commandType: 'grade.set_config',
          description: '保存或更新课件成绩配置，并写透至平台原生成绩配置服务',
          capabilityRequired: 'lesson:write',
          inputSchema: {
            type: 'OBJECT',
            properties: {
              coursewareId: { type: 'STRING', description: '课件 ID' },
              coursewareName: { type: 'STRING', description: '课件显示名称' },
              rawFullScore: { type: 'NUMBER', description: '课件原始满分' },
              targetFullScore: { type: 'NUMBER', description: '折算目标满分' },
              weightPercentage: { type: 'NUMBER', description: '成绩加权百分比' },
              scorePolicy: { type: 'STRING', description: '留分策略: MAX | LATEST | AVERAGE' },
              scoreFields: { type: 'STRING', description: '自定义成绩变量名（逗号分隔）' },
              lessonId: { type: 'STRING', description: '关联课时 ID' },
            },
            required: ['coursewareId'],
          },
        });

        await actionRegistry.register({
          id: 'grade-delete-config',
          commandType: 'grade.delete_config',
          description: '删除指定课件的成绩配置及本地尝试汇总缓存',
          capabilityRequired: 'lesson:write',
          inputSchema: {
            type: 'OBJECT',
            properties: {
              coursewareId: { type: 'STRING', description: '课件 ID' },
            },
            required: ['coursewareId'],
          },
        });

        await actionRegistry.register({
          id: 'grade-analyze-score-fields',
          commandType: 'grade.analyze_score_fields',
          description: '使用平台 AI 服务审计课件 HTML 源码中的学生得分与状态变量',
          capabilityRequired: 'lesson:read',
          inputSchema: {
            type: 'OBJECT',
            properties: {
              coursewareId: { type: 'STRING', description: '课件 ID' },
              coursewareName: { type: 'STRING', description: '课件名称（可选）' },
              htmlContent: { type: 'STRING', description: '直接传入的 HTML 源码（可选）' },
            },
            required: ['coursewareId'],
          },
        });

        await actionRegistry.register({
          id: 'grade-list-watch-variables',
          commandType: 'grade.list_watch_variables',
          description: '查询平台原生分数变量监视器已捕获的动态变量清单',
          capabilityRequired: 'lesson:read',
          inputSchema: {
            type: 'OBJECT',
            properties: {
              coursewareId: { type: 'STRING', description: '课件 ID' },
            },
            required: ['coursewareId'],
          },
        });
      } catch (e) {
        ctx.log.warn('ActionRegistry 注册部分或全部失败', { error: String(e) });
      }
    }

    // ── 5. 辅助调用宿主原生命令 ──
    const callNativeCommand = async (type: string, payload: any, actorId?: string) => {
      const bus: any = ctx.services?.commandBus;
      if (!bus || typeof bus.createCommand !== 'function' || typeof bus.execute !== 'function') return null;
      const envelope = await bus.createCommand(type, payload, actorId || ctx.pluginId);
      return await bus.execute(envelope);
    };

    const upsertLocalConfig = async (input: {
      coursewareId: string;
      coursewareName?: string;
      rawFullScore?: number;
      targetFullScore?: number;
      weightPercentage?: number;
      scorePolicy?: ScorePolicy;
      scoreFields?: string;
      lessonId?: string;
    }) => {
      if (!db) return;
      await db.prepare(`
        INSERT INTO ${configsTable}
          (courseware_id, courseware_name, raw_full_score, target_full_score, weight_percentage, score_policy, score_fields, lesson_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(courseware_id) DO UPDATE SET
          courseware_name = excluded.courseware_name,
          raw_full_score = excluded.raw_full_score,
          target_full_score = excluded.target_full_score,
          weight_percentage = excluded.weight_percentage,
          score_policy = excluded.score_policy,
          score_fields = excluded.score_fields,
          lesson_id = excluded.lesson_id,
          updated_at = excluded.updated_at
      `).run(
        input.coursewareId,
        input.coursewareName || '',
        Number(input.rawFullScore ?? 100),
        Number(input.targetFullScore ?? 100),
        Number(input.weightPercentage ?? 10),
        input.scorePolicy || 'LATEST',
        input.scoreFields || '',
        input.lessonId || '',
        Date.now(),
      );
    };

    // ── 6. 订阅原生课件提交事件 ──
    await eventBus.subscribe(SUBMIT_EVENT, async (event: any) => {
      const payload: any = event?.payload || {};
      const attemptId: string | undefined = payload?.attemptId;
      const nativeScore = Number(payload?.score);
      if (!attemptId || Number.isNaN(nativeScore)) return;
      if (!db) {
        ctx.log.warn('数据库不可用，跳过成绩归集', { attemptId });
        return;
      }

      const now = Date.now();

      // 6a. 反查尝试记录
      let studentId = '';
      let coursewareId = '';
      const attempt = (await db.prepare('SELECT * FROM courseware_attempt WHERE id = ?').get(attemptId)) as any;
      if (attempt) {
        studentId = attempt.student_id || '';
        coursewareId = attempt.courseware_id || '';
      }

      // 6b. lessonId：配置显式指定优先；srcDoc 预览从 attemptId 解析
      let lessonId = '';
      const srcDocMatch = /^att_srcdoc_(.+)_\d+_\d+$/.exec(attemptId);
      if (srcDocMatch) lessonId = srcDocMatch[1];

      // 6c. 归属守卫：拦截非真实学生（教师预览、匿名访客）
      if (!(await isRealStudent(db, studentId))) {
        ctx.log.info('非真实学生提交（教师预览/匿名访客），跳过成绩归集', {
          attemptId,
          studentId,
          coursewareId,
        });
        return;
      }

      // 6d. classId 反查
      let classId = '';
      if (studentId) {
        const row = (await db.prepare('SELECT class_id FROM class_students WHERE student_id = ? LIMIT 1').get(studentId)) as any;
        classId = row?.class_id || '';
      }

      // 6e. 读配置
      let config: any = null;
      if (coursewareId) {
        config = (await db.prepare(`SELECT * FROM ${configsTable} WHERE courseware_id = ?`).get(coursewareId)) as any;
      }
      if (!config) config = { ...DEFAULT_CONFIG };
      if (config.lesson_id) lessonId = config.lesson_id;

      // 6f. 成绩解析：从样本历史读取分数序列
      const customFields = parseScoreFields(config.score_fields || '');
      let samples: number[] = [];
      try {
        const rawRows = (await db.prepare(
          'SELECT payload_json FROM submission_raw WHERE attempt_id = ? ORDER BY created_at ASC'
        ).all(attemptId)) as any[];
        for (const row of rawRows) {
          let parsed: any = null;
          try {
            parsed = JSON.parse(row?.payload_json || '{}');
          } catch {
            parsed = null;
          }
          if (!parsed) continue;
          let value: number | null = null;
          if (customFields.length) value = extractScoreFromFields(parsed, customFields);
          if (value === null) value = toNumber(parsed.score);
          if (value !== null) samples.push(value);
        }
      } catch (e) {
        ctx.log.warn('样本历史读取失败，回退单次上报分', { attemptId, error: String(e) });
      }

      if (!samples.length) samples = [nativeScore];
      const finalRawScore = samples[samples.length - 1];

      if (!coursewareId) {
        ctx.log.info('缺少课件上下文，跳过成绩归集', { attemptId, studentId, rawScore: finalRawScore });
        return;
      }

      // 6g. 记录本次尝试得分，并按策略聚合
      const policy: ScorePolicy = config.score_policy || 'LATEST';
      try {
        await db.prepare(`
          INSERT INTO ${attemptsTable} (attempt_id, courseware_id, student_id, score, submitted_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(attempt_id) DO UPDATE SET score = excluded.score, submitted_at = excluded.submitted_at
        `).run(attemptId, coursewareId, studentId, finalRawScore, now);

        const aggregateRaw = aggregateScores(samples, policy);
        const rawFull = Number(config.raw_full_score) || 100;
        const targetFull = Number(config.target_full_score) || 100;
        const weight = Number(config.weight_percentage) ?? 10;
        const aggregateNormalized = round2(clamp((aggregateRaw / (rawFull || 100)) * targetFull, 0, targetFull));
        const aggregateWeighted = round2(aggregateNormalized * (weight / 100));

        // 6h. 学期成绩同步
        if (lessonId) {
          try {
            if (typeof semesterGrade?.saveSemesterGrade === 'function') {
              await semesterGrade.saveSemesterGrade(lessonId, studentId, aggregateNormalized);
            } else {
              ctx.log.warn('学期成绩服务缺少 saveSemesterGrade 方法，已跳过', { studentId });
            }
          } catch (e) {
            ctx.log.warn('学期成绩同步失败（可能未排课）', { lessonId, studentId, error: String(e) });
          }
        } else {
          ctx.log.warn('缺少 lessonId，跳过学期成绩同步', { studentId, coursewareId });
        }

        // 6i. 积分台账增量记录（激励只增不减）
        if (classId) {
          try {
            const prev = (await db.prepare(
              `SELECT awarded_weighted FROM ${summaryTable} WHERE courseware_id = ? AND student_id = ?`
            ).get(coursewareId, studentId)) as any;
            const prevAwarded = prev ? Number(prev.awarded_weighted) || 0 : 0;
            const delta = Math.max(0, round2(aggregateWeighted - prevAwarded));

            if (delta > 0.001 && typeof pointsLedger?.addPoints === 'function') {
              await pointsLedger.addPoints(
                studentId,
                classId,
                POINTS_DIMENSION_ID,
                delta,
                `互动课件 [${coursewareId}] ${policy} 聚合分 +${delta}`,
                ctx.pluginId,
              );
            }

            await db.prepare(`
              INSERT INTO ${summaryTable} (courseware_id, student_id, aggregate_score, awarded_weighted, updated_at)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(courseware_id, student_id) DO UPDATE SET
                aggregate_score = excluded.aggregate_score,
                awarded_weighted = excluded.awarded_weighted,
                updated_at = excluded.updated_at
            `).run(coursewareId, studentId, aggregateRaw, prevAwarded + delta, now);
          } catch (e) {
            ctx.log.warn('积分台账同步失败', { studentId, coursewareId, error: String(e) });
          }
        } else {
          ctx.log.warn('缺少 classId，跳过积分台账同步', { studentId, coursewareId });
        }
      } catch (e) {
        ctx.log.error('成绩聚合处理失败', { attemptId, error: String(e) });
      }
    });

    // ── 7. Command Handlers ──

    // 7a. 列出平台课件
    await commandBus.registerHandler('grade.list_courseware', {
      async execute() {
        if (!db) return [];
        try {
          return await db.prepare('SELECT id, uuid, name, type FROM courseware ORDER BY created_at DESC').all();
        } catch (e) {
          ctx.log.warn('读取 courseware 表失败', { error: String(e) });
          return [];
        }
      },
    });

    // 7b. 按 lessonId 查询课时
    await commandBus.registerHandler('grade.get_lesson', {
      async execute(command: any) {
        const lessonId = command?.payload?.lessonId;
        if (!db || !lessonId) return null;
        try {
          return (await db.prepare('SELECT id, title FROM lessons WHERE id = ?').get(lessonId)) || null;
        } catch (e) {
          ctx.log.warn('查询课时名称失败', { lessonId, error: String(e) });
          return null;
        }
      },
    });

    // 7c. 分页列出已配置课件
    await commandBus.registerHandler('grade.list_configs', {
      async execute(command: any) {
        if (!db) return { items: [], total: 0, page: 1, pageSize: 10 };
        const page = Math.max(1, Number(command?.payload?.page) || 1);
        const pageSize = Math.min(100, Math.max(1, Number(command?.payload?.pageSize) || 10));
        const offset = (page - 1) * pageSize;
        try {
          const totalRow = (await db.prepare(`SELECT COUNT(*) AS c FROM ${configsTable}`).get()) as any;
          const total = Number(totalRow?.c || 0);
          const items = await db.prepare(`
            SELECT c.*, l.title AS lesson_title
            FROM ${configsTable} c
            LEFT JOIN lessons l ON l.id = c.lesson_id
            ORDER BY c.updated_at DESC
            LIMIT ? OFFSET ?
          `).all(pageSize, offset);
          return { items, total, page, pageSize };
        } catch (e) {
          ctx.log.warn('读取配置列表失败', { error: String(e) });
          return { items: [], total: 0, page, pageSize };
        }
      },
    });

    // 7d. 读取课件配置（优先宿主原生配置）
    await commandBus.registerHandler('grade.get_config', {
      async execute(command: any) {
        const coursewareId = command?.payload?.coursewareId;
        if (!db || !coursewareId) return { ...DEFAULT_CONFIG };
        try {
          const native: any = await callNativeCommand('courseware.get_score_config', { coursewareId }, command?.actorId);
          if (native && native.success && native.source === 'courseware') {
            try {
              await upsertLocalConfig({
                coursewareId,
                coursewareName: native.courseware_name,
                rawFullScore: Number(native.raw_full_score),
                targetFullScore: Number(native.target_full_score),
                weightPercentage: Number(native.weight_percentage),
                scorePolicy: native.score_policy,
                scoreFields: native.score_fields,
                lessonId: native.lesson_id,
              });
            } catch (e) {
              ctx.log.warn('回写原生配置到插件镜像表失败', { coursewareId, error: String(e) });
            }
            return {
              courseware_id: native.courseware_id,
              courseware_name: native.courseware_name,
              raw_full_score: native.raw_full_score,
              target_full_score: native.target_full_score,
              weight_percentage: native.weight_percentage,
              score_policy: native.score_policy,
              score_fields: native.score_fields,
              lesson_id: native.lesson_id,
              updated_at: native.updated_at,
              native: true,
            };
          }
        } catch (e) {
          ctx.log.warn('读取平台原生成绩配置失败，回落到本地镜像表', { coursewareId, error: String(e) });
        }
        const row = (await db.prepare(`SELECT * FROM ${configsTable} WHERE courseware_id = ?`).get(coursewareId)) as any;
        if (!row) return { ...DEFAULT_CONFIG, courseware_id: coursewareId };
        return row;
      },
    });

    // 7e. 保存课件配置（写透原生）
    await commandBus.registerHandler('grade.set_config', {
      async execute(command: any) {
        const p: any = command?.payload || {};
        const coursewareId = p?.coursewareId;
        if (!db || !coursewareId) return { success: false, message: '缺少 coursewareId' };

        const coursewareName = p?.coursewareName || '';
        const rawFullScore = Number(p?.rawFullScore ?? 100);
        const targetFullScore = Number(p?.targetFullScore ?? 100);
        const weightPercentage = Number(p?.weightPercentage ?? 10);
        const scorePolicy: ScorePolicy = ['MAX', 'LATEST', 'AVERAGE'].includes(p?.scorePolicy) ? p.scorePolicy : 'LATEST';
        const scoreFields = typeof p?.scoreFields === 'string' ? p.scoreFields : '';
        const lessonId = p?.lessonId || '';

        try {
          await upsertLocalConfig({
            coursewareId,
            coursewareName,
            rawFullScore,
            targetFullScore,
            weightPercentage,
            scorePolicy,
            scoreFields,
            lessonId,
          });
        } catch (e) {
          ctx.log.error('保存课件成绩配置失败', { coursewareId, error: String(e) });
          return { success: false, message: String(e) };
        }

        let nativeSynced = false;
        let nativeError = '';
        try {
          const native: any = await callNativeCommand(
            'courseware.save_score_config',
            {
              coursewareId,
              coursewareName,
              scorePolicy,
              scoreFields,
              rawFullScore,
              targetFullScore,
              weightPercentage,
              lessonId: lessonId || undefined,
            },
            command?.actorId,
          );
          nativeSynced = !!(native && native.success);
        } catch (e) {
          nativeError = String(e);
          ctx.log.warn('写透到平台原生成绩配置失败（插件本地配置已保存）', { coursewareId, error: nativeError });
        }

        return { success: true, nativeSynced, nativeError: nativeSynced ? '' : nativeError };
      },
    });

    // 7f. 删除课件配置
    await commandBus.registerHandler('grade.delete_config', {
      async execute(command: any) {
        const coursewareId = command?.payload?.coursewareId;
        if (!db || !coursewareId) return { success: false, message: '缺少 coursewareId' };
        try {
          await db.prepare(`DELETE FROM ${configsTable} WHERE courseware_id = ?`).run(coursewareId);
          await db.prepare(`DELETE FROM ${attemptsTable} WHERE courseware_id = ?`).run(coursewareId);
          await db.prepare(`DELETE FROM ${summaryTable} WHERE courseware_id = ?`).run(coursewareId);
          return { success: true };
        } catch (e) {
          ctx.log.error('删除课件成绩配置失败', { coursewareId, error: String(e) });
          return { success: false, message: String(e) };
        }
      },
    });

    // 7g. AI 智能分析课件成绩变量
    await commandBus.registerHandler('grade.analyze_score_fields', {
      async execute(command: any) {
        const p: any = command?.payload || {};
        const coursewareId = p?.coursewareId;
        if (!coursewareId) return { success: false, message: '缺少 coursewareId', candidates: [] };

        let cw: any = null;
        if (db) {
          try {
            cw = await db.prepare('SELECT id, uuid, name, type, entry FROM courseware WHERE id = ?').get(coursewareId);
          } catch (e) {
            ctx.log.warn('查询课件元信息失败', { coursewareId, error: String(e) });
          }
        }
        const coursewareName = p?.coursewareName || cw?.name || coursewareId;

        let rawHtml = typeof p?.htmlContent === 'string' ? p.htmlContent : '';
        let source = 'direct';
        if (!rawHtml) {
          if (!db) return { success: false, message: '数据库不可用，且未提供课件源码', candidates: [] };
          const loaded = await loadCoursewareHtml(db, cw || { id: coursewareId });
          if (!loaded.html) {
            ctx.log.warn('读取课件源码失败', { coursewareId, uuid: cw?.uuid, entry: cw?.entry, error: loaded.error });
            return { success: false, message: loaded.error || '未能读取课件源码', candidates: [] };
          }
          rawHtml = loaded.html;
          source = loaded.source || 'db';
        }

        const htmlContent = rawHtml.length > 60000
          ? rawHtml.slice(0, 60000) + '\n<!-- [已截断，超出 60KB] -->'
          : rawHtml;

        const aiService = ctx.services?.ai;
        if (!aiService?.generateText) {
          return { success: false, message: '平台 AI 服务不可用（需要配置 AI Provider）', candidates: [] };
        }

        const systemInstruction = `你是一名专业的 HTML 互动课件代码审计助手。
任务：分析给定课件 HTML/JavaScript 源码，找出所有可能表示"学生得分/成绩"的 JavaScript 变量名。

输出规则（严格遵守，不得偏离）：
1. 只输出一个合法 JSON 数组，例如：["score","result.total","userScore"]
2. 数组中每个元素是一个变量名字符串（支持点号路径如 result.score）
3. 若完全找不到成绩变量，输出空数组：[]
4. 不输出任何解释、注释或 Markdown，只输出 JSON 数组本身

成绩变量的判断依据（满足其中一项即可）：
- 变量名包含 score、grade、point、mark、result、total、final、correct、star 等语义词
- 被赋值后通过 postMessage 发送给父窗口（表示上报成绩）
- 在 submit/finish/complete/end 等函数中被读取或传递
- 被写入 localStorage/sessionStorage 且键名含成绩语义`;

        const userPrompt = `课件名称：${coursewareName}

请分析以下 HTML 课件源码，提取所有可能表示学生成绩的 JavaScript 变量名：

\`\`\`html
${htmlContent}
\`\`\``;

        try {
          const aiResponse = await aiService.generateText(userPrompt, {
            systemInstruction,
            temperature: 0.1,
          });

          const cleaned = aiResponse
            .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '')
            .replace(/```[a-zA-Z]*\s*/g, '')
            .trim();
          const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
          if (!jsonMatch) {
            return { success: true, candidates: [], rawResponse: aiResponse, message: 'AI 未能识别到成绩变量' };
          }
          let candidates: string[] = [];
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            candidates = Array.isArray(parsed)
              ? parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
              : [];
          } catch {
            return { success: true, candidates: [], rawResponse: aiResponse, message: 'AI 返回结果解析失败' };
          }

          ctx.log.info('AI 成绩变量分析完成', { coursewareId, source, candidateCount: candidates.length });
          return { success: true, candidates, coursewareName };
        } catch (e) {
          ctx.log.error('AI 分析成绩变量失败', { coursewareId, error: String(e) });
          return { success: false, message: `AI 分析失败: ${String(e)}`, candidates: [] };
        }
      },
    });

    // 7h. 列出平台已监视到的分数变量
    await commandBus.registerHandler('grade.list_watch_variables', {
      async execute(command: any) {
        const coursewareId = command?.payload?.coursewareId;
        if (!db || !coursewareId) return { variables: [], sampledAt: null };
        try {
          const row = (await db.prepare(
            `SELECT sr.payload_json AS payload_json, sr.created_at AS created_at
               FROM submission_raw sr
               JOIN courseware_attempt ca ON ca.id = sr.attempt_id
              WHERE ca.courseware_id = ?
                AND sr.payload_json LIKE '%"watch"%'
              ORDER BY sr.created_at DESC
              LIMIT 1`
          ).get(coursewareId)) as any;
          if (!row?.payload_json) return { variables: [], sampledAt: null };
          const parsed = JSON.parse(row.payload_json);
          const watch = parsed?.watch;
          if (!watch || typeof watch !== 'object') return { variables: [], sampledAt: null };
          const variables = Object.keys(watch)
            .filter((k) => k !== '_changed' && k !== '_at')
            .map((k) => `watch.${k}`);
          return {
            variables,
            sampledAt: Number(row.created_at) || null,
            changed: typeof watch._changed === 'string' ? watch._changed : null,
          };
        } catch (e) {
          ctx.log.warn('读取平台已监视变量失败', { coursewareId, error: String(e) });
          return { variables: [], sampledAt: null };
        }
      },
    });

    ctx.log.info('互动网页课件插件激活完成（Action 注册就绪 + 原生写透与积分同步）', {
      configsTable, attemptsTable, summaryTable, submitEvent: SUBMIT_EVENT,
    });
  },

  async deactivate() {
    // 宿主 PluginHost 停用插件时会自动清理已注册的 CommandHandlers、ActionDescriptors 与 EventBus 监听器
  },
};
