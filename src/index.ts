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

type ScorePolicy = 'MAX' | 'LATEST' | 'AVERAGE';

const DEFAULT_CONFIG = {
  raw_full_score: 100,
  target_full_score: 100,
  weight_percentage: 10,
  score_policy: 'LATEST' as ScorePolicy,
  score_fields: '',
  lesson_id: '',
};

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

export default {
  manifest: {
    id: 'openlearn-plugin-interactive-courseware',
    name: '互动网页课件插件',
    version: '1.0.20',
    main: 'index.js',
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

      // 4c. classId
      let classId = '';
      if (studentId && studentId !== 'teacher_preview') {
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

      // 4e. 成绩解析：自定义变量优先 → 默认兜底
      let finalRawScore = nativeScore;
      const customFields = parseScoreFields(config.score_fields || '');
      if (customFields.length) {
        try {
          const resultRow = (await db.prepare('SELECT extra_json FROM submission_result WHERE attempt_id = ?').get(attemptId)) as any;
          if (resultRow?.extra_json) {
            const rawExtra = JSON.parse(resultRow.extra_json);
            const customScore = extractScoreFromFields(rawExtra, customFields);
            if (customScore !== null) finalRawScore = customScore;
          }
        } catch (e) {
          ctx.log.warn('自定义成绩变量解析失败，回退默认提取', { attemptId, error: String(e) });
        }
      }

      // 仅真实学生（有 coursewareId + studentId）才做聚合与同步
      if (!studentId || !coursewareId || studentId === 'teacher_preview') {
        ctx.log.info('教师预览/缺失上下文提交，跳过成绩归集', { attemptId, rawScore: finalRawScore });
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

        const scoreRows = (await db.prepare(
          `SELECT score FROM ${attemptsTable} WHERE courseware_id = ? AND student_id = ? ORDER BY submitted_at ASC`
        ).all(coursewareId, studentId)) as any[];
        const scores = scoreRows.map((r) => Number(r.score));
        const aggregateRaw = aggregateScores(scores, policy);

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

    ctx.log.info('互动网页课件插件激活成功（订阅原生提交 + 多尝试留分聚合）', {
      configsTable, attemptsTable, summaryTable, submitEvent: SUBMIT_EVENT,
    });
  },

  async deactivate() {
    // ctx.db.dropAllTables() 由 PluginHost 自动调用
  },
};
