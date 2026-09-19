/**
 * 互动网页课件插件 —— 前端入口 (dist/frontend.js)
 *
 * teacher.tab 配置面板：
 *   - 分页列表展示已配置课件的成绩设置
 *   - 编辑表单含「成绩变量」输入框（可空=默认提取；多变量优先提取）
 */

import React from 'react';

let ctx: any = null;

interface CoursewareItem {
  id: string;
  uuid: string;
  name: string;
  type: string;
}

interface GradeConfig {
  courseware_id: string;
  courseware_name: string;
  raw_full_score: number;
  target_full_score: number;
  weight_percentage: number;
  score_policy: 'MAX' | 'LATEST' | 'AVERAGE';
  score_fields: string;
  lesson_id: string;
  lesson_title?: string;
}

const DEFAULT_CONFIG: GradeConfig = {
  courseware_id: '',
  courseware_name: '',
  raw_full_score: 100,
  target_full_score: 100,
  weight_percentage: 10,
  score_policy: 'LATEST',
  score_fields: '',
  lesson_id: '',
};

const PAGE_SIZE = 5;

// 通用样式
const boxStyle: React.CSSProperties = {
  backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 10, padding: 16, marginBottom: 14,
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', borderRadius: 6, boxSizing: 'border-box',
  backgroundColor: '#0f172a', border: '1px solid #334155', color: '#f8fafc', fontSize: 13,
};
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 12, color: '#94a3b8', marginBottom: 6 };
const btnPrimary: React.CSSProperties = {
  padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
  backgroundColor: '#2563eb', color: '#fff', fontWeight: 600, fontSize: 13,
};
const btnGhost: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 6, border: '1px solid #475569', cursor: 'pointer',
  backgroundColor: '#0f172a', color: '#cbd5e1', fontSize: 12,
};
const btnAi: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5,
  padding: '5px 10px', borderRadius: 6, border: '1px solid #7c3aed',
  backgroundColor: '#2e1065', color: '#ddd6fe', fontSize: 11, fontWeight: 600,
  cursor: 'pointer', lineHeight: 1.2,
};

// 解析 "a, b; c" 形式的变量串为数组
function parseFields(raw: string): string[] {
  return (raw || '').split(/[,，;；\n\r]+/).map((s) => s.trim()).filter(Boolean);
}

// 图标按钮用的星芒图标
const SparkleIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" style={{ display: 'block', flexShrink: 0 }}>
    <path d="M12 2l1.9 5.6L19.5 9.5l-5.6 1.9L12 17l-1.9-5.6L4.5 9.5l5.6-1.9L12 2z" />
    <path d="M19 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2z" />
  </svg>
);

function CoursewareGradePanel(props: { renderType?: string; lessonId?: string | null; classId?: string | null }) {
  const currentLessonId = props.lessonId || '';
  const currentClassId = props.classId || '';

  const [configs, setConfigs] = React.useState<GradeConfig[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [coursewares, setCoursewares] = React.useState<CoursewareItem[]>([]);
  const [editing, setEditing] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState('');
  const [form, setForm] = React.useState<GradeConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [lessonName, setLessonName] = React.useState('');

  // AI 分析状态
  const [aiAnalyzing, setAiAnalyzing] = React.useState(false);
  const [aiModal, setAiModal] = React.useState<{
    open: boolean;
    candidates: string[];
    message: string;
    coursewareName: string;
  }>({ open: false, candidates: [], message: '', coursewareName: '' });
  const [aiPicked, setAiPicked] = React.useState<string[]>([]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // 当前表单已配置的变量（用于候选去重与「已添加」标记）
  const existingScoreFields = parseFields(form.score_fields);

  // 载入分页配置列表
  const loadConfigs = React.useCallback((p: number) => {
    if (!ctx?.invokeCommand) return;
    setLoading(true);
    ctx.invokeCommand('grade.list_configs', { page: p, pageSize: PAGE_SIZE })
      .then((res: any) => {
        setConfigs(Array.isArray(res?.items) ? res.items : []);
        setTotal(Number(res?.total) || 0);
      })
      .catch((e: any) => setStatus(`❌ 载入配置列表失败: ${e?.message || e}`))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    loadConfigs(page);
  }, [page, loadConfigs]);

  // 载入课件下拉（编辑/新增时）
  const loadCoursewares = React.useCallback(() => {
    if (!ctx?.invokeCommand) return;
    ctx.invokeCommand('grade.list_courseware')
      .then((list: CoursewareItem[]) => setCoursewares(Array.isArray(list) ? list : []))
      .catch((e: any) => setStatus(`❌ 载入课件列表失败: ${e?.message || e}`));
  }, []);

  // 按 lessonId 解析可读课时名称
  const resolveLessonName = React.useCallback((lessonId: string) => {
    if (!lessonId || !ctx?.invokeCommand) {
      setLessonName('');
      return;
    }
    ctx.invokeCommand('grade.get_lesson', { lessonId })
      .then((res: any) => setLessonName(res?.title || ''))
      .catch(() => setLessonName(''));
  }, []);

  // 表单课时变化时解析名称
  React.useEffect(() => {
    resolveLessonName(form.lesson_id);
  }, [form.lesson_id, resolveLessonName]);

  // 新增配置
  const handleAdd = () => {
    setSelectedId('');
    setForm({ ...DEFAULT_CONFIG, lesson_id: currentLessonId });
    setEditing(true);
    loadCoursewares();
  };

  // 编辑某条配置
  const handleEdit = (cfg: GradeConfig) => {
    setSelectedId(cfg.courseware_id);
    setForm({ ...DEFAULT_CONFIG, ...cfg });
    setEditing(true);
    loadCoursewares();
  };

  // 切换下拉选择（新增时）
  const handleSelectChange = (id: string) => {
    setSelectedId(id);
    if (!id) return;
    const selected = coursewares.find((c) => c.id === id);
    ctx?.invokeCommand('grade.get_config', { coursewareId: id })
      .then((cfg: GradeConfig) => {
        const merged = { ...DEFAULT_CONFIG, ...(cfg || {}), courseware_id: id };
        // 优先使用课件列表中的友好名称（而非可能为空的库名或 cw_xxx ID）
        if (selected?.name) merged.courseware_name = selected.name;
        if (!merged.lesson_id && currentLessonId) merged.lesson_id = currentLessonId;
        setForm(merged);
      })
      .catch((e: any) => setStatus(`❌ 载入配置失败: ${e?.message || e}`));
  };

  // 保存
  const handleSave = async () => {
    if (!selectedId || !ctx?.invokeCommand) return;
    setStatus('⏳ 保存中…');
    try {
      const selected = coursewares.find((c) => c.id === selectedId);
      const res = await ctx.invokeCommand('grade.set_config', {
        coursewareId: selectedId,
        coursewareName: selected?.name || form.courseware_name,
        rawFullScore: form.raw_full_score,
        targetFullScore: form.target_full_score,
        weightPercentage: form.weight_percentage,
        scorePolicy: form.score_policy,
        scoreFields: form.score_fields,
        lessonId: form.lesson_id,
      });
      if (res?.success === false) {
        setStatus(`❌ 保存失败: ${res?.message}`);
      } else {
        setStatus('✅ 配置已保存');
        setEditing(false);
        loadConfigs(page);
      }
    } catch (e: any) {
      setStatus(`❌ 保存失败: ${e?.message || e}`);
    }
  };

  // 删除配置
  const handleDelete = async (coursewareId: string) => {
    if (!coursewareId || !ctx?.invokeCommand) return;
    if (!window.confirm('确定删除该课件的成绩配置吗？将连带清理其成绩记录与汇总。')) return;
    setStatus('⏳ 删除中…');
    try {
      const res = await ctx.invokeCommand('grade.delete_config', { coursewareId });
      if (res?.success === false) {
        setStatus(`❌ 删除失败: ${res?.message}`);
      } else {
        setStatus('✅ 已删除');
        if (editing && selectedId === coursewareId) {
          setEditing(false);
          setSelectedId('');
        }
        // 若当前页被删空且不是第一页，回退一页
        const newPage = configs.length === 1 && page > 1 ? page - 1 : page;
        loadConfigs(newPage);
        setPage(newPage);
      }
    } catch (e: any) {
      setStatus(`❌ 删除失败: ${e?.message || e}`);
    }
  };

  // 跳转到课程编辑器展示指定课时
  const gotoLesson = (lessonId: string) => {
    if (!lessonId) return;
    ctx?.navigation?.setSelectedLesson?.(lessonId);
    ctx?.navigation?.setTeacherTab?.('lesson_editor');
  };

  // AI 分析课件成绩变量（打开/复用弹窗，分析期间保持弹窗显示加载态）
  const handleAiAnalyze = async () => {
    if (!selectedId || !ctx?.invokeCommand) return;
    const cwMeta = coursewares.find((c) => c.id === selectedId);
    const cwName = cwMeta?.name || form.courseware_name || selectedId;
    setAiAnalyzing(true);
    setAiPicked([]);
    setAiModal({ open: true, candidates: [], message: 'AI 正在分析课件源码，请稍候…', coursewareName: cwName });
    try {
      // 优先由前端拓取已渲染的课件源码（可覆盖仅存于磁盘的“自动提交版”），
      // 拓取失败则由后端从 vfs_nodes / system_resources 兜底。
      let htmlContent = '';
      try {
        const resp = await fetch(`/runtime/${encodeURIComponent(cwMeta?.uuid || selectedId)}/`, { credentials: 'same-origin' });
        if (resp.ok) htmlContent = await resp.text();
      } catch {
        // 忽略，交由后端兜底
      }

      const res = await ctx.invokeCommand('grade.analyze_score_fields', {
        coursewareId: selectedId,
        coursewareName: cwName,
        htmlContent: htmlContent ? htmlContent.slice(0, 60000) : undefined,
      });
      const raw: any[] = Array.isArray(res?.candidates) ? res.candidates : [];
      const candidates = Array.from(new Set(raw.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())));
      setAiModal({
        open: true,
        candidates,
        message: res?.message || (res?.success === false ? '分析失败' : ''),
        coursewareName: res?.coursewareName || cwName,
      });
    } catch (e: any) {
      setAiModal({ open: true, candidates: [], message: `调用失败: ${e?.message || e}`, coursewareName: cwName });
    } finally {
      setAiAnalyzing(false);
    }
  };

  const closeAiModal = () => {
    setAiModal((m) => ({ ...m, open: false }));
    setAiPicked([]);
  };

  const toggleAiPick = (candidate: string, checked: boolean) => {
    setAiPicked((prev) => (checked ? [...prev, candidate] : prev.filter((c) => c !== candidate)));
  };

  // 将勾选的候选变量追加（去重）到 score_fields
  const handleConfirmPicked = () => {
    const merged = [...existingScoreFields];
    let added = 0;
    for (const c of aiPicked) {
      if (c && !merged.includes(c)) { merged.push(c); added += 1; }
    }
    setForm((prev) => ({ ...prev, score_fields: merged.join(', ') }));
    closeAiModal();
    if (added > 0) setStatus(`✅ 已添加 ${added} 个成绩变量`);
  };

  const field = (label: string, value: number | string, onChange: (v: any) => void, type = 'number') => (
    <div style={{ marginBottom: 10 }}>
      <label style={labelStyle}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value)}
        style={inputStyle}
      />
    </div>
  );

  return (
    <div style={{ padding: 20, fontFamily: 'Inter, system-ui, sans-serif', color: '#f8fafc', width: '100%', boxSizing: 'border-box' }}>
      <h2 style={{ margin: '0 0 4px 0', fontSize: 18, color: '#38bdf8' }}>🌐 互动网页课件成绩配置</h2>
      <p style={{ margin: '0 0 16px 0', fontSize: 12, color: '#94a3b8' }}>
        课件渲染由平台原生 html-applet 承担；此处配置每个课件的成绩变量、满分折算、课程权重与归属课时。
      </p>

      {(currentLessonId || currentClassId) && (
        <div style={{ fontSize: 11, color: '#60a5fa', marginBottom: 14, padding: '8px 12px', borderRadius: 8, backgroundColor: '#1e293b', border: '1px solid #334155' }}>
          📍 当前上下文：课时 <b>{currentLessonId || '—'}</b> · 班级 <b>{currentClassId || '—'}</b>
          （新课件未指定归属课时时，将自动填充当前课时）
        </div>
      )}

      {/* ── 编辑表单 ── */}
      {editing ? (
        <div style={boxStyle}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontSize: 15, color: '#f1f5f9' }}>{selectedId ? '编辑课件配置' : '新增课件配置'}</h3>
            <button onClick={() => setEditing(false)} style={btnGhost}>← 返回列表</button>
          </div>

          {!selectedId ? (
            <div style={{ marginBottom: 10 }}>
              <label style={labelStyle}>选择课件</label>
              <select value={selectedId} onChange={(e) => handleSelectChange(e.target.value)} style={inputStyle}>
                <option value="" disabled>-- 请选择 --</option>
                {coursewares.map((c) => <option key={c.id} value={c.id}>{c.name || c.id}</option>)}
              </select>
            </div>
          ) : (
            <div style={{ marginBottom: 10 }}>
              <label style={labelStyle}>课件</label>
              <div style={{ ...inputStyle, color: '#e2e8f0' }}>
                {coursewares.find((c) => c.id === selectedId)?.name || form.courseware_name || selectedId}
              </div>
            </div>
          )}

          <div style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>成绩变量（可留空，多个用逗号/换行分隔，支持点号路径如 result.score）</label>
              {!!selectedId && (
                <button
                  type="button"
                  title="调用 AI 分析课件源码，自动识别可能表示学生成绩的变量"
                  onClick={handleAiAnalyze}
                  disabled={aiAnalyzing}
                  style={{ ...btnAi, opacity: aiAnalyzing ? 0.6 : 1, cursor: aiAnalyzing ? 'wait' : 'pointer' }}
                >
                  <SparkleIcon />
                  <span>{aiAnalyzing ? '分析中…' : 'AI 分析'}</span>
                </button>
              )}
            </div>
            <textarea
              rows={2}
              value={form.score_fields}
              onChange={(e) => setForm({ ...form, score_fields: e.target.value })}
              placeholder="留空则使用系统默认获取方式；例如：userScore, result.points, finalGrade"
              style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical' }}
            />
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
              优先依次尝试上述变量，全部取不到时回退系统默认提取。
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {field('课件内部原始满分', form.raw_full_score, (v) => setForm({ ...form, raw_full_score: v }))}
            {field('折算为平台标准满分', form.target_full_score, (v) => setForm({ ...form, target_full_score: v }))}
            {field('课程总成绩权重 (%)', form.weight_percentage, (v) => setForm({ ...form, weight_percentage: v }))}

            <div style={{ marginBottom: 10 }}>
              <label style={labelStyle}>多次作答留分策略</label>
              <select
                value={form.score_policy}
                onChange={(e) => setForm({ ...form, score_policy: e.target.value as GradeConfig['score_policy'] })}
                style={inputStyle}
              >
                <option value="MAX">🏆 取最高分</option>
                <option value="LATEST">🕒 取最新一次</option>
                <option value="AVERAGE">📊 取平均分</option>
              </select>
            </div>

            <div style={{ marginBottom: 10 }}>
              <label style={labelStyle}>归属课时 lessonId（可空）</label>
              <input
                type="text"
                value={form.lesson_id}
                onChange={(e) => setForm({ ...form, lesson_id: e.target.value })}
                placeholder="留空则不记学期成绩"
                style={inputStyle}
              />
              {lessonName && (
                <div style={{ fontSize: 11, color: '#4ade80', marginTop: 4 }}>
                  📖 {lessonName}
                </div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
            <button onClick={() => setEditing(false)} style={btnGhost}>取消</button>
            <button onClick={handleSave} disabled={!selectedId || loading} style={btnPrimary}>💾 保存配置</button>
          </div>
        </div>
      ) : null}

      {/* ── 分页列表 ── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 14, color: '#f1f5f9' }}>已配置课件（共 {total} 条）</h3>
        <button onClick={handleAdd} style={btnPrimary}>＋ 新增配置</button>
      </div>

      <div style={boxStyle}>
        {loading && configs.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>载入中…</div>
        ) : configs.length === 0 ? (
          <div style={{ color: '#64748b', fontSize: 13 }}>暂无配置，点击「＋ 新增配置」为课件设置成绩规则。</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#94a3b8', textAlign: 'left', borderBottom: '1px solid #334155' }}>
                <th style={{ padding: '6px 8px' }}>课件</th>
                <th style={{ padding: '6px 8px' }}>成绩变量</th>
                <th style={{ padding: '6px 8px' }}>权重</th>
                <th style={{ padding: '6px 8px' }}>满分折算</th>
                <th style={{ padding: '6px 8px' }}>留分策略</th>
                <th style={{ padding: '6px 8px' }}>归属课时</th>
                <th style={{ padding: '6px 8px' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {configs.map((cfg) => (
                <tr key={cfg.courseware_id} style={{ borderBottom: '1px solid #1e293b' }}>
                  <td style={{ padding: '6px 8px', color: '#e2e8f0' }}>{cfg.courseware_name || cfg.courseware_id}</td>
                  <td style={{ padding: '6px 8px', color: '#38bdf8', fontFamily: 'monospace' }}>
                    {cfg.score_fields ? cfg.score_fields : <span style={{ color: '#64748b' }}>默认</span>}
                  </td>
                  <td style={{ padding: '6px 8px' }}>{cfg.weight_percentage}%</td>
                  <td style={{ padding: '6px 8px' }}>{cfg.raw_full_score}→{cfg.target_full_score}</td>
                  <td style={{ padding: '6px 8px' }}>{cfg.score_policy}</td>
                  <td style={{ padding: '6px 8px' }}>
                    {cfg.lesson_id ? (
                      <a
                        href="#/lesson_editor"
                        onClick={(e) => { e.preventDefault(); gotoLesson(cfg.lesson_id); }}
                        title="跳转到该课时的课程编辑器"
                        style={{ color: '#60a5fa', cursor: 'pointer', textDecoration: 'underline' }}
                      >
                        {cfg.lesson_title || cfg.lesson_id}
                      </a>
                    ) : (
                      <span style={{ color: '#64748b' }}>—</span>
                    )}
                  </td>
                  <td style={{ padding: '6px 8px' }}>
                    <button onClick={() => handleEdit(cfg)} style={btnGhost}>编辑</button>{' '}
                    <button onClick={() => handleDelete(cfg.courseware_id)} style={{ ...btnGhost, color: '#f87171', borderColor: '#7f1d1d' }}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* 分页 */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end', marginTop: 12, fontSize: 12, color: '#94a3b8' }}>
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} style={{ ...btnGhost, opacity: page <= 1 ? 0.5 : 1 }}>上一页</button>
            <span>第 {page} / {totalPages} 页</span>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages} style={{ ...btnGhost, opacity: page >= totalPages ? 0.5 : 1 }}>下一页</button>
          </div>
        )}
      </div>

      {status && <p style={{ marginTop: 8, fontSize: 12, color: status.includes('✅') ? '#4ade80' : status.includes('❌') ? '#f87171' : '#eab308' }}>{status}</p>}

      {/* ── AI 成绩变量分析弹窗 ── */}
      {aiModal.open && (
        <div
          role="dialog"
          aria-label="AI 成绩变量分析"
          onClick={(e) => { if (e.target === e.currentTarget) closeAiModal(); }}
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(15, 23, 42, 0.6)', backdropFilter: 'blur(4px)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
        >
          <div style={{ width: 560, maxWidth: '92vw', maxHeight: '86vh', overflowY: 'auto', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: 14, padding: 20, boxShadow: '0 20px 40px rgba(0, 0, 0, 0.45)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <h3 style={{ margin: 0, fontSize: 15, color: '#c4b5fd', display: 'flex', alignItems: 'center', gap: 6 }}>
                <SparkleIcon /> AI 成绩变量分析
              </h3>
              <button onClick={closeAiModal} style={btnGhost} aria-label="关闭">✕</button>
            </div>
            <p style={{ margin: '0 0 14px 0', fontSize: 12, color: '#94a3b8' }}>
              课件：<b style={{ color: '#e2e8f0' }}>{aiModal.coursewareName || '—'}</b>
            </p>

            {aiAnalyzing ? (
              <div style={{ fontSize: 13, color: '#c4b5fd', backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: 14 }}>
                ⏳ 正在读取课件代码并调用 AI 分析，请稍候…
              </div>
            ) : aiModal.candidates.length === 0 ? (
              <div style={{ fontSize: 13, color: '#fbbf24', backgroundColor: '#1e293b', border: '1px solid #334155', borderRadius: 8, padding: 12 }}>
                {aiModal.message || 'AI 未识别到可能的成绩变量，可在上方手动填写。'}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 8 }}>
                  勾选需要监控的成绩变量（已配置的自动置灰），保存后将按顺序依次尝试提取：
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {aiModal.candidates.map((c) => {
                    const added = existingScoreFields.includes(c);
                    const checked = added || aiPicked.includes(c);
                    return (
                      <label
                        key={c}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderRadius: 8, border: `1px solid ${checked ? '#7c3aed' : '#334155'}`, backgroundColor: checked ? '#2e1065' : '#1e293b', cursor: added ? 'not-allowed' : 'pointer', opacity: added ? 0.65 : 1 }}
                      >
                        <input type="checkbox" checked={checked} disabled={added} onChange={(e) => toggleAiPick(c, e.target.checked)} />
                        <code style={{ fontSize: 13, color: '#e2e8f0' }}>{c}</code>
                        {added && <span style={{ marginLeft: 'auto', fontSize: 11, color: '#4ade80' }}>已添加</span>}
                      </label>
                    );
                  })}
                </div>
              </>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
              <button onClick={handleAiAnalyze} disabled={aiAnalyzing} style={{ ...btnGhost, opacity: aiAnalyzing ? 0.6 : 1 }}>
                {aiAnalyzing ? '⏳ 分析中…' : '🔄 重新分析'}
              </button>
              <button onClick={closeAiModal} style={btnGhost}>取消</button>
              <button
                onClick={handleConfirmPicked}
                disabled={aiAnalyzing || aiPicked.length === 0}
                style={{ ...btnPrimary, backgroundColor: aiAnalyzing || aiPicked.length === 0 ? '#334155' : '#7c3aed', cursor: aiAnalyzing || aiPicked.length === 0 ? 'not-allowed' : 'pointer' }}
              >
                ＋ 添加选中（{aiPicked.length}）
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export async function activate(hostCtx: any) {
  ctx = hostCtx;
  try {
    hostCtx.ui.registerExtensionPoint('teacher.tab', {
      id: 'tab_interactive_courseware_grade',
      label: '互动网页课件',
      icon: 'Globe',
      position: 20,
      renderType: 'panel',
      component: CoursewareGradePanel,
    });
  } catch (e) {
    console.warn('[InteractiveCourseware] 注册 teacher.tab 失败:', e);
  }
}

export function deactivate() {
  if (ctx?.ui) {
    try {
      ctx.ui.unregisterExtensionPoint('teacher.tab', 'tab_interactive_courseware_grade');
    } catch (e) {}
  }
}

export default {
  activate,
  deactivate,
};
