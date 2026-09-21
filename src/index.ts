/**
 * 互动网页课件插件 —— 服务端入口 (dist/index.js)
 *
 * 方案 A：接入平台原生 html-applet 课件体系，订阅原生事件 courseware.attempt_submitted。
 *
 * 成绩解析（按优先级）：
 *   1. 配置中自定义 score_fields（多个变量名，支持点号嵌套）从 submission_result.extra_json 提取
 *   2. 回退到平台默认提取结果（event.payload.score）
 *
 * 多尝试留分策略（score_policy）：
 *   - MAX：取该生在该课件所有尝试的最高原始分
 *   - LATEST：取最新一次原始分
 *   - AVERAGE：取所有尝试平均原始分
 *   - 学期成绩按策略聚合分写入；积分台账只计聚合加权分的正向增量（激励只增不减）
 *
 * ⚠️ Worker 模式注意：ctx.resolve(IDatabaseToken) 返回的代理中 prepare().run/get/all
 *    均为异步 RPC（返回 Promise），故所有 DB 调用一律 await（Inline 模式 await 同步值无害）。
 */

import type { PluginContext } from '@openlearn/plugin-sdk';
import {
  Token,
  IDatabaseToken,
  IPointsLedgerServiceToken,
  IPointsDimensionRegistryToken,
} from '@openlearn/plugin-sdk';

const ISemesterGradeServiceToken = new Token('@openlearn/core:ISemesterGradeService');
const POINTS_DIMENSION_ID = 'interactive_courseware';
const SUBMIT_EVENT = 'courseware.attempt_submitted';

import { SCORE_MONITOR_SCRIPT } from './score-monitor-script.js';

/** 「课件运行时脚本扩展点」的 DI Token（按名字解析，避免插件 bundle 硬依赖 SDK 构建产物） */
interface RuntimeScriptRegistryLike {
  register(
    owner: string,
    script: { id: string; source: string; position?: 'head' | 'body-end'; priority?: number }
  ): void;
  unregister(owner: string, id: string): void;
}
const RUNTIME_SCRIPT_REGISTRY_TOKEN_NAME = '@openlearn/core:ICoursewareRuntimeScriptRegistry';
const ICoursewareRuntimeScriptRegistryToken = new Token<RuntimeScriptRegistryLike>(RUNTIME_SCRIPT_REGISTRY_TOKEN_NAME);
const SCORE_MONITOR_SCRIPT_ID = 'score-variable-monitor';

// 停用插件时需要撤销注册，而 deactivate() 拿不到 ctx，故在此保留注册句柄
let runtimeScriptRegistryRef: any = null;
let runtimeScriptOwnerId: string | null = null;

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
 * `injectLmsSdk`（server/routes/shared.ts）在无法识别/无会话时写入 courseware_attempt.student_id 的哨兵值：
 *   - 'teacher' / 'teacher_preview' → 教师或管理员预览（attempt id 前缀 att_teacher_）
 *   - 'guest'                       → 匿名、无 cookie 访问（attempt id 前缀 att_guest_）
 * 这类记录绝不允许写入学期成绩册或积分台账，否则教师预览分会污染真实成绩。
 */
const NON_STUDENT_OWNERS = new Set(['teacher', 'teacher_preview', 'guest', 'admin']);

/**
 * 归属守卫：确认 attempt 的归属者确实是 `students` 表中的真实学生。
 * fail-closed —— 查询异常一律视为非学生。
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

function randomId(): string {
  const g: any = globalThis as any;
  if (typeof g?.crypto?.randomUUID === 'function') return g.crypto.randomUUID();
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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
 *
 * ⚠️ 平台 openlearn-token-enforcer 禁止插件 import `node:fs` / `node:path` 等内置模块
 *    （打包时直接报错），因此这里不读磁盘，而是读取平台已经持久化的源码：
 *      1) `vfs_nodes`        —— “文件/代码”型课件的原始内容
 *      2) `system_resources` —— 上传的 html / folder 型课件（按 id / uuid / 名称关联）
 *    与平台 server/routes/bridge.ts 的自愈逻辑保持一致。
 */
async function loadCoursewareHtml(db: any, cw: any): Promise<{ html: string; source?: string; error?: string }> {
  const norm = (s: any) => String(s || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();

  // folder 型：从文件数组 JSON 中挑选入口文件
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
    // 表不存在等情况忽略，继续尝试 system_resources
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
    // 忽略，走最终错误返回
  }

  return { html: '', error: '未能在平台数据库中定位课件源码（vfs_nodes / system_resources 均未命中）' };
}

export default {
  manifest: {
    id: 'openlearn-plugin-interactive-courseware',
    name: '互动网页课件插件',
    version: '1.0.29',
    main: 'index.js',
    executionMode: 'inline',
    description: '接入平台原生 html-applet 课件，支持自定义成绩变量与 MAX/AVERAGE 多尝试留分，加权计入课程总成绩册与积分台账',
    author: 'OpenLearn Developer',
    engines: { openlearn: '>=0.1.12' },
    requires: [
      '@openlearn/core:ICommandBusService@^1.0.0',
      '@openlearn/core:IEventBusService@^1.0.0',
      '@openlearn/core:IDatabase@^1.0.0',
      '@openlearn/core:IPointsLedgerService@^1.0.0',
      '@openlearn/core:IPointsDimensionRegistry@^1.0.0',
      '@openlearn/core:ISemesterGradeService@^1.0.0',
    ],
    capabilitiesProposed: [
      'courseware:read',
      'courseware:write',
      'courseware:grade',
    ],
  },

  async activate(ctx: PluginContext) {
    const commandBus = ctx.services.commandBus;
    const eventBus = ctx.services.eventBus;

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

    // ── 4. 订阅原生课件提交事件 ──
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

      // 4a. 反查尝试记录
      let studentId = '';
      let coursewareId = '';
      const attempt = (await db.prepare('SELECT * FROM courseware_attempt WHERE id = ?').get(attemptId)) as any;
      if (attempt) {
        studentId = attempt.student_id || '';
        coursewareId = attempt.courseware_id || '';
      }

      // 4b. lessonId：配置显式指定优先；srcDoc 预览从 attemptId 解析
      let lessonId = '';
      const srcDocMatch = /^att_srcdoc_(.+)_\d+_\d+$/.exec(attemptId);
      if (srcDocMatch) lessonId = srcDocMatch[1];

      // 4c. 归属守卫：只有 students 表中的真实学生才继续归集成绩。
      //     教师/管理员预览（student_id='teacher'）与匿名访客（student_id='guest'）
      //     同样会在 courseware_attempt 里留下记录，必须在此拦截，
      //     否则它们会被当成真实学生写进学期成绩册与积分台账。
      if (!(await isRealStudent(db, studentId))) {
        ctx.log.info('非真实学生提交（教师预览/匿名访客），跳过成绩归集', {
          attemptId,
          studentId,
          coursewareId,
        });
        return;
      }

      // 4c-bis. classId
      let classId = '';
      if (studentId) {
        const row = (await db.prepare('SELECT class_id FROM class_students WHERE student_id = ? LIMIT 1').get(studentId)) as any;
        classId = row?.class_id || '';
      }

      // 4d. 读配置
      let config: any = null;
      if (coursewareId) {
        config = (await db.prepare(`SELECT * FROM ${configsTable} WHERE courseware_id = ?`).get(coursewareId)) as any;
      }
      if (!config) config = { ...DEFAULT_CONFIG };
      if (config.lesson_id) lessonId = config.lesson_id;

      // 4e. 成绩解析：从「样本历史」取分，而不是只看本次上报。
      //     原生 bridge-sdk 的分数变量监视器每次发现分数变量变化，就以 saveProgress 上报一次；
      //     host 的 courseware.submit_attempt 会为每次上报写一行 submission_raw
      //     （payload_json = { score, ..., watch: {...} }）。因此这里能拿到完整样本序列，
      //     配置里的 score_policy（MAX / AVERAGE / LATEST）才真正有意义。
      //     旧实现只在 grade_attempts 上按 attempt_id 聚合，而一个学生在一个课件上只会复用
      //     同一条 active attempt（该表只有一行），导致 MAX / AVERAGE 永远退化为 LATEST。
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
      // 兜底：读不到样本历史时（例如 attempt 早于本版本），仍按本次上报分处理
      if (!samples.length) samples = [nativeScore];
      const finalRawScore = samples[samples.length - 1];

      // 4e-bis. 缺少 coursewareId 无法定位成绩配置，跳过（学生归属校验已在 4c 完成）
      if (!coursewareId) {
        ctx.log.info('缺少课件上下文，跳过成绩归集', { attemptId, studentId, rawScore: finalRawScore });
        return;
      }

      // 4f. 记录本次尝试得分，并按策略聚合
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

        // 4g. 学期成绩 = 聚合分（upsert）
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

        // 4h. 积分台账 = 聚合加权分的正向增量（激励只增不减）
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

    // ── 5. 列出平台课件 ──
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

    // ── 5b. 按 lessonId 查询可读课时名称 ──
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

    // ── 6. 分页列出已配置课件 ──
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

    // ── 7. 读取某课件配置 ──
    await commandBus.registerHandler('grade.get_config', {
      async execute(command: any) {
        const coursewareId = command?.payload?.coursewareId;
        if (!db || !coursewareId) return { ...DEFAULT_CONFIG };
        const row = (await db.prepare(`SELECT * FROM ${configsTable} WHERE courseware_id = ?`).get(coursewareId)) as any;
        if (!row) return { ...DEFAULT_CONFIG, courseware_id: coursewareId };
        return row;
      },
    });

    // ── 8. 保存课件配置 ──
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
        const now = Date.now();

        try {
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
            coursewareId, coursewareName, rawFullScore, targetFullScore,
            weightPercentage, scorePolicy, scoreFields, lessonId, now,
          );
          return { success: true };
        } catch (e) {
          ctx.log.error('保存课件成绩配置失败', { coursewareId, error: String(e) });
          return { success: false, message: String(e) };
        }
      },
    });

    // ── 9. 删除课件配置（连带清理成绩记录与汇总）──
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

    // ── 10. AI 智能分析课件成绩变量 ──
    // 从平台数据库读取课件 HTML 源码，调用平台 AI 服务分析可能的成绩变量。
    // 注意：受 token-enforcer 限制，插件禁止 import node:* 内置模块，故不读磁盘文件。
    await commandBus.registerHandler('grade.analyze_score_fields', {
      async execute(command: any) {
        const p: any = command?.payload || {};
        const coursewareId = p?.coursewareId;
        if (!coursewareId) return { success: false, message: '缺少 coursewareId', candidates: [] };

        // 10a. 查询课件元信息（用于兜底读取与显示名称；缺失不致命）
        let cw: any = null;
        if (db) {
          try {
            cw = await db.prepare('SELECT id, uuid, name, type, entry FROM courseware WHERE id = ?').get(coursewareId);
          } catch (e) {
            ctx.log.warn('查询课件元信息失败', { coursewareId, error: String(e) });
          }
        }
        const coursewareName = p?.coursewareName || cw?.name || coursewareId;

        // 10b. 获取入口 HTML：前端已抓取则直接使用（可覆盖仅存于磁盘的「自动提交版」课件），
        //      否则回退平台数据库（vfs_nodes / system_resources）。
        let rawHtml = typeof p?.htmlContent === 'string' ? p.htmlContent : '';
        let source = 'frontend';
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
        // 截取前 60 KB，避免超出 AI 上下文窗口
        const htmlContent = rawHtml.length > 60000
          ? rawHtml.slice(0, 60000) + '\n<!-- [已截断，超出 60KB] -->'
          : rawHtml;

        // 10c. 调用 AI 服务分析成绩变量
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

          // 解析 AI 返回的 JSON 数组（容错处理）：
          // 推理型模型（如 MiniMax-M3）会先输出 <think>…</think>，需先剥离，
          // 否则非贪婪匹配可能命中推理过程中的方括号；同时剔除 markdown 代码围栏。
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

    // ── 11. 列出平台已监视到的分数变量 ──
    // 原生 bridge-sdk 的「分数变量监视器」发现到分数变量变化时，会以 saveProgress 上报一次，
    // host 的 courseware.submit_attempt 为每次上报写一行 submission_raw
    // （payload_json = { score, ..., watch: { 变量名: 值, _changed, _at } }）。
    // 这里取该课件最近一条样本的 watch 键名，供配置页做成可点选的候选变量，
    // 教师无需手写变量名，也无需翻阅课件源码。
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

    // ── 6. 通过「课件运行时脚本扩展点」注册分数变量监视器 ──
    // 课件 iframe 是 credentialless + 无 allow-same-origin 的 opaque origin，父窗口读不到它内部的变量，
    // 服务端拼接 HTML（injectLmsSdk）是平台唯一能向课件投递代码的位置 —— 所以监视器脚本必须由平台代注入。
    // 用字符串 token 解析（而非从 '@openlearn/plugin-sdk' 导入 Token 值），
    // 这样插件 bundle 不依赖宿主 SDK 构建产物是否已包含该 Token，部署顺序更安全。
    try {
      const registry = await ctx.resolve(ICoursewareRuntimeScriptRegistryToken);
      if (registry && typeof registry.register === 'function') {
        registry.register(ctx.pluginId, {
          id: SCORE_MONITOR_SCRIPT_ID,
          source: SCORE_MONITOR_SCRIPT,
          position: 'body-end',
          priority: 200,
        });
        runtimeScriptRegistryRef = registry;
        runtimeScriptOwnerId = ctx.pluginId;
        ctx.log.info('已注册课件运行时分数变量监视器', { id: SCORE_MONITOR_SCRIPT_ID });
      } else {
        ctx.log.warn('课件运行时脚本扩展点不可用，分数变量监视器未注册（成绩仍可按原生提交归集）', {
          token: RUNTIME_SCRIPT_REGISTRY_TOKEN_NAME,
        });
      }
    } catch (e) {
      ctx.log.warn('课件运行时脚本扩展点解析失败，分数变量监视器未注册', { error: String(e) });
    }

    ctx.log.info('互动网页课件插件激活成功（订阅原生提交 + 多尝试留分聚合）', {
      configsTable, attemptsTable, summaryTable, submitEvent: SUBMIT_EVENT,
    });
  },

  async deactivate() {
    // 撤销「课件运行时脚本扩展点」注册，避免停用插件后监视器仍在注入
    try {
      if (runtimeScriptRegistryRef && runtimeScriptOwnerId) {
        runtimeScriptRegistryRef.unregister(runtimeScriptOwnerId, SCORE_MONITOR_SCRIPT_ID);
      }
    } catch (e) {
      // 内核可能已销毁，忽略
    }
    runtimeScriptRegistryRef = null;
    runtimeScriptOwnerId = null;
    // ctx.db.dropAllTables() 由 PluginHost 自动调用
  },
};
