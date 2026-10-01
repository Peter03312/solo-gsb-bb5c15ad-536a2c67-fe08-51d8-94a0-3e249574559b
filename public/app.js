'use strict';
/* 听证会校订台前端：原生 JS，字符偏移一律使用 Array.from（Unicode 码点），与后端一致 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const cpLen = (s) => Array.from(s).length;
const cpSlice = (s, a, b) => Array.from(s).slice(a, b).join('');
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

let me = null;
let booth = null;
let tab = 'proposals';
let viewMode = 'base';
let currentSelection = null; // { seg, start, end, excerpt }

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败（${res.status}）`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  setTimeout(() => t.classList.add('hidden'), 3200);
  t.classList.remove('hidden');
}

// ---------- 弹窗 ----------
function openModal(html, wide = false) {
  const box = wide ? $('#version-box') : $('#modal-box');
  const overlay = wide ? $('#version-overlay') : $('#modal-overlay');
  box.innerHTML = html;
  overlay.classList.remove('hidden');
  overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.add('hidden'); };
}
function closeModal() {
  $('#modal-overlay').classList.add('hidden');
  $('#version-overlay').classList.add('hidden');
}
const STATUS_LABEL = {
  pending: '待复核', adopted: '已采纳·暂存', rejected: '已驳回',
  conflicted: '冲突', published: '已发布', active: '有效', needs_relocation: '待重新定位',
};
const DECISION_LABEL = { adopt: '采纳', reject: '驳回', conflict: '标记冲突', publish: '发布', rebase: '续提' };

// 记录员可对本人“基版已过期”类冲突提议发起续提（换算到当前版本重新提交）
function canRebase(p) {
  return me && me.role === 'recordist' && p.status === 'conflicted' &&
    p.creator_user === me.username &&
    (p.conflict_kind === 'base_expired' ||
      (!p.conflict_kind && (p.conflict_reason || '').indexOf('基版已过期') === 0));
}

// ---------- 启动 / 登录 ----------
async function boot() {
  try {
    const data = await api('/api/me');
    me = data.user;
  } catch (_) { me = null; }
  if (me) enterApp();
  else showLogin();
}

function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
}

async function enterApp() {
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#user-info').textContent = `${me.displayName}（${roleLabel(me.role)}）@${me.username}`;
  $('#secret-logs-btn').style.display = me.role === 'reviewer' ? '' : 'none';
  await reload();
}

function roleLabel(r) {
  return { recordist: '记录员', reviewer: '复核员', participant: '参与者' }[r] || r;
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  const fd = new FormData(e.target);
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: { username: fd.get('username'), password: fd.get('password') },
    });
    me = data.user;
    await enterApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch (_) {}
  me = null; booth = null;
  showLogin();
});

$('#refresh-btn').addEventListener('click', reload);
$('#secret-logs-btn').addEventListener('click', openSecretLogs);
$('#secret-logs-btn').style.display = 'none'; // 仅复核员可见（登录后按角色显示）

// ---------- 段级保密留痕（复核员） ----------
const SECRET_ACTION_LABEL = { classify: '设为保密', declassify: '解除保密' };
async function openSecretLogs() {
  try {
    const data = await api('/api/secret-logs');
    const logs = data.logs || [];
    openModal(`
      <h3>保密变更留痕</h3>
      <p class="muted">保密以段号为准，立即作用于当前及全部历史版本的参与者视图；不改写已发布版本、提议、异议与回应原始记录。</p>
      ${logs.length ? `<div class="secret-log-list">${logs.map((l) => `
        <div class="decision-item ${l.action === 'classify' ? 't-conflict' : 't-adopt'}">
          <b>第 ${l.seg} 段 · ${SECRET_ACTION_LABEL[l.action] || l.action}</b>
          （${l.previous_state} → ${l.new_state}）
          <div class="card-meta">${esc(l.actor_name)}（${esc(l.actor_user)}）· ${l.created_at} UTC · 留痕 #${l.id}</div>
        </div>`).join('')}</div>`
      : '<div class="empty">尚无保密变更记录。</div>'}
      <div class="actions"><button class="btn" data-close>关闭</button></div>`);
  } catch (err) { toast(err.message, 'error'); }
}

async function reload() {
  try {
    booth = await api('/api/booth');
  } catch (err) {
    if (err.status === 401) return showLogin();
    toast(err.message, 'error');
    return;
  }
  render();
}

// ---------- 渲染入口 ----------
function render() {
  if (!booth || !booth.initialized) {
    $('#import-box').classList.toggle('hidden', !(me.role === 'recordist'));
    $('#paper').innerHTML = me.role === 'recordist'
      ? '<p class="muted">请在上方导入 UTF-8 逐字稿。</p>'
      : '<div class="empty">逐字稿尚未导入，请等待记录员导入并形成初始版本。</div>';
    $('#publish-bar').classList.add('hidden');
    $('#doc-title').textContent = '听证会逐字稿校订台';
    $('#ver-line').textContent = '尚无版本';
  } else {
    $('#import-box').classList.add('hidden');
    $('#doc-title').textContent = booth.title;
    // 发布预览属工作人员校订环节：参与者不可切换（总览中始终为当前已发布正文）
    $('#view-preview').style.display = me.role === 'participant' ? 'none' : '';
    if (me.role === 'participant' && viewMode === 'preview') {
      viewMode = 'base';
      syncViewToggle();
    }
    $('#ver-line').textContent = booth.currentVersion.note
      ? `当前版本 v${booth.currentVersion.id} · ${booth.currentVersion.note} · ${booth.currentVersion.createdAt} UTC`
      : `当前版本 v${booth.currentVersion.id} · ${booth.currentVersion.createdAt} UTC`;
    renderPaper();
    renderPublishBar();
  }
  renderTabs();
  renderProposals();
  renderObjections();
  renderVersions();
}

// ---------- 正文渲染（含标记叠加） ----------
function segText(seg, list) {
  const s = list.find((x) => x.seg === seg);
  return s ? s.text : '';
}

function buildPreviewMarks(seg) {
  // 由暂存修订换算预览文本中的替换区间
  const edits = booth.stage.filter((p) => p.seg === seg).sort((a, b) => a.start - b.start);
  const marks = [];
  let delta = 0;
  for (const e of edits) {
    const s = e.start + delta;
    const en = s + cpLen(e.replacement);
    delta += cpLen(e.replacement) - (e.end - e.start);
    if (en > s) marks.push({ start: s, end: en, cls: 'mk-preview', key: `p${e.id}` });
  }
  return marks;
}

function renderPaper() {
  const list = viewMode === 'preview' ? booth.previewSegments : booth.segments;
  const paper = $('#paper');
  paper.innerHTML = '';

  for (const seg of list) {
    const row = document.createElement('div');
    row.className = 'seg' + (seg.secret ? ' is-secret' : '');
    const no = document.createElement('div');
    no.className = 'seg-no';
    no.textContent = seg.seg;
    if (seg.secret) no.classList.add('seg-no-secret');
    const body = document.createElement('div');
    body.className = 'seg-body' + (viewMode === 'base' ? ' selectable' : '');
    body.dataset.seg = seg.seg;

    if (seg.secret) {
      // 参与者视角：保密段只渲染占位，不叠加任何标记（提议/异议均已被服务端过滤）
      const ph = document.createElement('div');
      ph.className = 'secret-placeholder';
      ph.textContent = '🔒 ' + seg.text;
      body.appendChild(ph);
    } else {
      const segMarks = viewMode === 'preview' ? buildPreviewMarks(seg.seg) : collectSegMarks(seg.seg);
      renderMarkedText(body, seg.text, segMarks);
      // 复核员：段号旁保密开关；工作人员始终可见真实正文
      if (me.role === 'reviewer') {
        const btn = document.createElement('button');
        btn.className = 'btn tiny secret-toggle';
        btn.textContent = isSecret(seg.seg) ? '解除保密' : '设为保密';
        btn.title = '按段号保密，立即作用于当前及全部历史版本的参与者视图';
        btn.addEventListener('mousedown', (e) => e.preventDefault());
        btn.addEventListener('click', () => toggleSecret(seg.seg));
        body.appendChild(btn);
      } else if (isSecret(seg.seg)) {
        const tag = document.createElement('span');
        tag.className = 'secret-tag';
        tag.textContent = '🔒 保密段（工作人员可见）';
        body.appendChild(tag);
      }
      // 已登录用户按段查看当前已发布版本的正文来源（预览为未发布内容，不提供来源）
      if (viewMode === 'base') {
        const srcBtn = document.createElement('button');
        srcBtn.className = 'btn tiny src-toggle';
        srcBtn.textContent = '来源';
        srcBtn.title = '按逐次发布的修订重放：查看该段每个连续片段来自初始导入还是哪条已发布提议';
        srcBtn.addEventListener('mousedown', (e) => e.preventDefault());
        srcBtn.addEventListener('click', () => openProvenance(booth.currentVersion.id, seg.seg));
        body.appendChild(srcBtn);
      }
    }
    row.appendChild(no);
    row.appendChild(body);
    paper.appendChild(row);
  }
}

// 段号是否在当前保密集合中（工作人员视角的真实正文用）
function isSecret(seg) {
  return !!(booth && booth.secretSegs && booth.secretSegs.includes(seg));
}

async function toggleSecret(seg) {
  const secret = !isSecret(seg);
  if (!window.confirm(`确认将第 ${seg} 段${secret ? '设为保密' : '解除保密'}？\n` +
      (secret
        ? '立即作用于当前及全部历史版本的参与者视图：参与者只看到保密占位，不获得正文、暂存预览、提议及依据、异议、回应与决议，且不能在该段新建或重新定位异议。'
        : '解除后参与者将重新看到该段内容与相关记录。'))) return;
  try {
    const r = await api(`/api/segments/${seg}/${secret ? 'secret' : 'unsecret'}`, { method: 'POST' });
    await reload();
    toast(`第 ${seg} 段已${secret ? '设为保密' : '解除保密'}（留痕 #${r.logId}：${r.previousState} → ${r.newState}）`, 'success');
  } catch (err) { toast(err.message, 'error'); }
}

function collectSegMarks(seg) {
  const cur = booth.currentVersion.id;
  const marks = [];
  for (const p of booth.proposals) {
    if (p.seg !== seg) continue;
    if (p.status === 'published') {
      if (p.published_version_id === cur) marks.push({ start: p.start_cp, end: p.end_cp, cls: 'mk-published', key: `p${p.id}` });
      continue;
    }
    if (p.base_ver !== cur) continue;
    if (p.status === 'rejected') continue;
    if (p.status === 'conflicted') marks.push({ start: p.start_cp, end: p.end_cp, cls: 'mk-conflict', key: `p${p.id}` });
    else marks.push({
      start: p.start_cp, end: p.end_cp,
      cls: 'mk-adopted' + (p.status === 'pending' ? ' mk-pending' : ''),
      key: `p${p.id}`,
    });
  }
  for (const o of booth.objections) {
    if (o.seg !== seg) continue;
    marks.push({
      start: o.start_cp, end: o.end_cp,
      cls: o.anchor_status === 'needs_relocation' ? 'mk-relo' : 'mk-objection',
      key: `o${o.id}`,
    });
  }
  return marks;
}

// 按码点切分并叠加可能交叠的标记
function renderMarkedText(container, text, marks) {
  const cps = Array.from(text);
  const len = cps.length;
  const pts = Array.from(new Set([0, len, ...marks.flatMap((m) => [m.start, m.end])]))
    .filter((x) => x >= 0 && x <= len).sort((a, b) => a - b);
  let last = 0;
  for (const pos of pts) {
    if (pos > last) {
      const chunk = cps.slice(last, pos).join('');
      const active = marks.filter((m) => m.start <= last && pos <= m.end);
      appendChunk(container, chunk, active);
    }
    last = pos;
  }
}

function appendChunk(container, chunk, active) {
  if (!active.length) {
    container.appendChild(document.createTextNode(chunk));
    return;
  }
  const span = document.createElement('span');
  span.className = Array.from(new Set(active.map((m) => m.cls))).join(' ');
  span.dataset.mk = active.map((m) => m.key).join(',');
  span.textContent = chunk;
  container.appendChild(span);
}

// 标记点击 → 详情
$('#paper').addEventListener('click', (e) => {
  const mk = e.target.closest('.mk');
  if (!mk) return;
  const keys = (mk.dataset.mk || '').split(',');
  if (keys.length === 1) openMarkDetail(keys[0]);
  else {
    openModal(`
      <h3>此处有 ${keys.length} 项叠加标记</h3>
      ${keys.map((k) => {
        const isP = k[0] === 'p';
        const id = k.slice(1);
        const obj = isP ? booth.proposals.find((x) => x.id == id) : booth.objections.find((x) => x.id == id);
        const label = isP ? `提议 #${id}` : `异议 #${id}`;
        const sub = isP ? STATUS_LABEL[obj.status] : STATUS_LABEL[obj.anchor_status || obj.status];
        return `<div class="card"><div class="card-head"><span class="card-id">${label}</span>
          <span class="muted">${esc(sub)}</span></div>
          <div class="quote">${esc(isP ? obj.original_excerpt : obj.quoted_text)}</div>
          <div class="card-actions"><button class="btn small primary" data-open="${k}">查看详情</button></div></div>`;
      }).join('')}
      <div class="actions"><button class="btn" data-close>关闭</button></div>`);
    $$('#modal-box [data-open]').forEach((b) =>
      b.addEventListener('click', () => openMarkDetail(b.dataset.open)));
  }
});
$('#modal-box').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });
$('#version-box').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });

function openMarkDetail(key) {
  closeModal();
  if (key[0] === 'p') openProposalModal(parseInt(key.slice(1), 10));
  else openObjectionModal(parseInt(key.slice(1), 10));
}

// ---------- 视图切换 ----------
$('#view-base').addEventListener('click', () => { viewMode = 'base'; syncViewToggle(); renderPaper(); });
$('#view-preview').addEventListener('click', () => { viewMode = 'preview'; syncViewToggle(); renderPaper(); hideSelectionToolbar(); });
function syncViewToggle() {
  $('#view-base').classList.toggle('active', viewMode === 'base');
  $('#view-preview').classList.toggle('active', viewMode === 'preview');
}

// ---------- 选区捕获 ----------
function cpOffsetInSeg(segEl, node, offset) {
  const walker = document.createTreeWalker(segEl, NodeFilter.SHOW_TEXT);
  let n, cp = 0;
  while ((n = walker.nextNode())) {
    if (n === node) return cp + cpLen(n.textContent.slice(0, offset));
    cp += cpLen(n.textContent);
  }
  return null;
}

document.addEventListener('mouseup', onSelection);
document.addEventListener('touchend', () => setTimeout(onSelection, 10));
document.addEventListener('selectionchange', () => {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) hideSelectionToolbar();
});

function onSelection() {
  hideSelectionToolbar();
  if (!booth || !booth.initialized || viewMode !== 'base') return;
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const aBody = range.startContainer.parentElement && range.startContainer.parentElement.closest('.seg-body');
  const bBody = range.endContainer.parentElement && range.endContainer.parentElement.closest('.seg-body');
  if (!aBody || !bBody || aBody !== bBody || !$('#paper').contains(aBody)) {
    if (aBody !== bBody && aBody && bBody) toast('请在同一段落内选择范围', 'error');
    return;
  }
  const seg = parseInt(aBody.dataset.seg, 10);
  const segObj = (booth.segments || []).find((x) => x.seg === seg);
  if (segObj && segObj.secret) return; // 参与者视角的保密占位不可选择（服务端同样拒绝）
  const s = cpOffsetInSeg(aBody, range.startContainer, range.startOffset);
  const en = cpOffsetInSeg(aBody, range.endContainer, range.endOffset);
  if (s == null || en == null || s === en) return;
  const start = Math.min(s, en), end = Math.max(s, en);
  const text = segText(seg, booth.segments);
  currentSelection = { seg, start, end, excerpt: cpSlice(text, start, end) };

  const bar = $('#selection-toolbar');
  bar.innerHTML = '';
  if (me.role === 'recordist') {
    bar.appendChild(toolButton('✏ 提交修订提议', openProposalForm));
  }
  bar.appendChild(toolButton('⚑ 提出异议引用', openObjectionForm));
  bar.classList.remove('hidden');
  const rect = range.getBoundingClientRect();
  bar.style.position = 'fixed';
  bar.style.left = Math.max(8, Math.min(window.innerWidth - 260, rect.left)) + 'px';
  bar.style.top = (rect.bottom + 8) + 'px';
}
function toolButton(label, fn) {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => { hideSelectionToolbar(); fn(); });
  return b;
}
function hideSelectionToolbar() { $('#selection-toolbar').classList.add('hidden'); }

// ---------- 提议表单 ----------
function openProposalForm() {
  const sel = currentSelection;
  if (!sel) return;
  openModal(`
    <h3>提交修订提议（第 ${sel.seg} 段）</h3>
    <p class="muted">提议将绑定当前已发布版本 v${booth.currentVersion.id}。范围：[${sel.start}, ${sel.end})，共 ${sel.end - sel.start} 个字符。</p>
    <div class="sel-quote">${esc(sel.excerpt)}</div>
    <label>替换文字（空串表示删除该范围；不得含换行）
      <textarea id="f-replace" rows="3"></textarea>
    </label>
    <label>修订依据 <em style="color:var(--danger)">*</em>
      <textarea id="f-basis" rows="3" placeholder="如：现场录音 00:12:05 显示发言人为张三，而非“李四”"></textarea>
    </label>
    <div class="actions">
      <button class="btn" data-close>取消</button>
      <button class="btn primary" id="f-submit">提交提议</button>
    </div>`);
  $('#f-submit').addEventListener('click', async () => {
    try {
      const r = await api('/api/proposals', {
        method: 'POST',
        body: {
          seg: sel.seg, start: sel.start, end: sel.end,
          replacement: $('#f-replace').value,
          basis: $('#f-basis').value,
        },
      });
      closeModal();
      await reload();
      if (r.id) toast(`提议 #${r.id} 已提交`, 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- 异议表单 ----------
function openObjectionForm() {
  const sel = currentSelection;
  if (!sel) return;
  openModal(`
    <h3>提出异议引用（第 ${sel.seg} 段）</h3>
    <p class="muted">系统会保存引用时刻的原文快照。若以后修订使被引文字不再存在，将提示重新定位，不会自动指向新文字。</p>
    <div class="sel-quote">${esc(sel.excerpt)}</div>
    <label>异议说明 <em style="color:var(--danger)">*</em>
      <textarea id="f-note" rows="3"></textarea>
    </label>
    <div class="actions">
      <button class="btn" data-close>取消</button>
      <button class="btn primary" id="f-submit-o">提交异议</button>
    </div>`);
  $('#f-submit-o').addEventListener('click', async () => {
    try {
      const r = await api('/api/objections', {
        method: 'POST',
        body: { seg: sel.seg, start: sel.start, end: sel.end, note: $('#f-note').value },
      });
      closeModal();
      await reload();
      toast(`异议 #${r.id} 已记录`, 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- 提议详情 / 复核操作 ----------
function openProposalModal(id) {
  const p = booth.proposals.find((x) => x.id === id);
  if (!p) return;
  const cur = booth.currentVersion.id;
  const canReview = me.role === 'reviewer';
  const actionable = canReview && p.base_ver === cur && (p.status === 'pending' || p.status === 'adopted');
  const same = p.replacement === p.original_excerpt;
  openModal(`
    <h3>提议 #${p.id} <span class="tag tag-${p.status}">${STATUS_LABEL[p.status]}</span></h3>
    <div class="card-meta">
      第 ${p.seg} 段 · 范围 [${p.start_cp}, ${p.end_cp}) · 基版 v${p.base_ver}
      ${p.published_version_id ? `· 已随 v${p.published_version_id} 发布` : ''}
      ${p.rebased_from_id ? `· 续提自冲突提议 #${p.rebased_from_id}` : ''}
      ${p.continued_by_id ? `· 已续提为提议 #${p.continued_by_id}` : ''}<br/>
      提交人：${esc(p.creator_name)}（${esc(p.creator_user)}）· ${p.created_at} UTC
    </div>
    <div class="quote">${esc(p.original_excerpt)}</div>
    <div><span class="arrow">替换为 →</span><span class="replacement">${esc(p.replacement) || '（空串·删除）'}</span>${same ? ' <span class="muted">（与原文相同）</span>' : ''}</div>
    <div class="basis" style="margin-top:8px"><b>依据：</b>${esc(p.basis)}</div>
    ${p.conflict_reason ? `<div class="conflict-reason">冲突原因：${esc(p.conflict_reason)}</div>` : ''}
    <div class="actions">
      <button class="btn" data-close>关闭</button>
      ${actionable && p.status === 'pending' ? '<button class="btn danger" id="p-reject">驳回</button><button class="btn primary" id="p-adopt">采纳</button>' : ''}
      ${actionable && p.status === 'adopted' ? '<button class="btn danger" id="p-reject">驳回（移出暂存区）</button>' : ''}
      ${canRebase(p) ? '<button class="btn primary" id="p-rebase">续提到当前版本…</button>' : ''}
    </div>`);

  const rebaseBtn = $('#p-rebase');
  if (rebaseBtn) rebaseBtn.addEventListener('click', () => openRebase(p.id));

  const adoptBtn = $('#p-adopt');
  if (adoptBtn) adoptBtn.addEventListener('click', async () => {
    try {
      const r = await api(`/api/proposals/${id}/adopt`, { method: 'POST' });
      closeModal();
      await reload();
      if (r.markedConflict) toast(`提议 #${id} 已标记冲突：${r.reason}`, 'error');
      else toast(`提议 #${id} 已采纳，进入发布暂存区`, 'success');
    } catch (err) {
      toast(err.message, 'error');
      await reload();
    }
  });
  const rejectBtn = $('#p-reject');
  if (rejectBtn) rejectBtn.addEventListener('click', async () => {
    const reason = prompt('驳回原因（可留空）：') ?? null;
    if (reason === null) return;
    try {
      await api(`/api/proposals/${id}/reject`, { method: 'POST', body: { reason } });
      closeModal();
      await reload();
      toast(`提议 #${id} 已驳回`, 'success');
    } catch (err) { toast(err.message, 'error'); await reload(); }
  });
}

// ---------- 续提（基版已过期提议的换算重提） ----------
async function openRebase(id) {
  try {
    const pv = await api(`/api/proposals/${id}/rebase-preview`, { method: 'POST' });
    showRebaseModal(pv);
  } catch (err) {
    openModal(`
      <h3>无法续提</h3>
      <div class="conflict-reason">${esc(err.message)}</div>
      <p class="muted">提示：可在左侧当前正文中手工拖选范围，使用“提交修订提议”重新提交。</p>
      <div class="actions"><button class="btn" data-close>知道了</button></div>`);
  }
}

function showRebaseModal(pv) {
  const stepsDesc = (pv.steps || []).map((s) => `v${s.version}（${s.edits} 项修订）`).join(' → ');
  openModal(`
    <h3>续提预览：提议 #${pv.proposalId}</h3>
    <p class="muted">系统按 v${pv.fromVersion} → v${pv.toVersion} 逐次发布的修订，将原段内选区换算到当前正文；
      不凭同文搜索猜测位置。确认后生成关联原提议的新待复核提议，原冲突提议保留可追溯。</p>
    <div class="card-meta">换算路径：${esc(stepsDesc || '无中途修订')}</div>
    <label>目标选区（当前版本 v${pv.toVersion} · 第 ${pv.seg} 段 · [${pv.start}, ${pv.end})）</label>
    <div class="quote">${esc(pv.excerpt) || '（零长度选区·插入点）'}</div>
    <label>原基版 v${pv.fromVersion} 摘录</label>
    <div class="quote">${esc(pv.originalExcerpt) || '（零长度选区·插入点）'}</div>
    <div><span class="arrow">替换为 →</span><span class="replacement">${esc(pv.replacement) || '（空串·删除）'}</span></div>
    <div class="basis" style="margin-top:8px"><b>依据：</b>${esc(pv.basis)}</div>
    ${pv.stageOverlap ? `<div class="conflict-reason">⚠ 目标选区与当前已采纳提议 #${pv.stageOverlap.id} 交叠，确认将被拒绝；请先处理暂存区，或在当前正文手工选区提交。</div>` : ''}
    <div class="actions">
      <button class="btn" data-close>取消</button>
      <button class="btn primary" id="rb-confirm">确认续提，生成新待复核提议</button>
    </div>`);
  $('#rb-confirm').addEventListener('click', async () => {
    try {
      const r = await api(`/api/proposals/${pv.proposalId}/rebase-confirm`, {
        method: 'POST',
        body: { token: pv.token },
      });
      closeModal();
      await reload();
      toast(`已生成续提提议 #${r.id}（关联原提议 #${pv.proposalId}），等待复核`, 'success');
    } catch (err) {
      closeModal();
      await reload();
      toast(`续提被拒绝：${err.message}`, 'error');
    }
  });
}

// ---------- 异议详情 ----------
function openObjectionModal(id) {
  const o = booth.objections.find((x) => x.id === id);
  if (!o) return;
  const canRelocate = o.anchor_status === 'needs_relocation' && (me.role === 'reviewer' || o.creator_user === me.username);
  const gate = (booth.publishCheck && booth.publishCheck.items || []).find((x) => x.objectionId === id);
  const canRespond = me.role === 'reviewer' && gate && !gate.satisfied;
  openModal(`
    <h3>异议 #${o.id} <span class="tag tag-${o.anchor_status === 'needs_relocation' ? 'needs_relocation' : 'pending'}">${STATUS_LABEL[o.anchor_status === 'needs_relocation' ? 'needs_relocation' : 'active']}</span></h3>
    <div class="card-meta">
      第 ${o.seg} 段 · 当前锚点 [${o.start_cp}, ${o.end_cp}) · 提出于 v${o.created_in_version} · ${o.created_at} UTC<br/>
      提出人：${esc(o.creator_name)}（${esc(o.creator_user)}）
    </div>
    <label>被引原文快照（始终保留，不随后续修订改变）</label>
    <div class="quote">${esc(o.quoted_text)}</div>
    <div class="basis" style="margin-top:6px"><b>说明：</b>${esc(o.note)}</div>
    ${gate ? (gate.satisfied
      ? `<div class="snapshot-note gate-ok-note">✔ 已对本次暂存修订（触及提议 ${gate.proposalIds.map((x) => `#${x}`).join('、')}）作出回应（回应 #${gate.response.id}，v${gate.response.versionId}）。</div>`
      : `<div class="snapshot-note">⚠ 本异议被暂存修订触及（提议 ${gate.proposalIds.map((x) => `#${x}`).join('、')}），发布前须由复核员逐条回应。${
        gate.response ? `<br/>上一份回应已失效：${esc(gate.response.invalidReason)}` : '当前尚无回应。'}</div>`) : ''}
    ${o.anchor_status === 'needs_relocation' ? `
      <div class="snapshot-note">
        ⚠ 后续修订可能已使被引文字不再存在。系统仅保留原文快照，<b>不会</b>将引用悄悄指向新文字；
        请核对当前正文后重新定位。
      </div>` : ''}
    <div class="actions">
      <button class="btn" data-close>关闭</button>
      ${canRespond ? `<button class="btn primary" id="o-respond">${gate.response ? '重新回应…' : '发布前回应…'}</button>` : ''}
      ${canRelocate ? '<button class="btn primary" id="o-relocate">重新定位…</button>' : ''}
    </div>`);
  const btn = $('#o-relocate');
  if (btn) btn.addEventListener('click', () => openRelocateForm(o));
  const rb = $('#o-respond');
  if (rb) rb.addEventListener('click', () => openRespondForm(id));
}

function openRelocateForm(o) {
  const segList = booth.segments.map((s) => s.seg);
  openModal(`
    <h3>重新定位异议 #${o.id}</h3>
    <p class="muted">在当前版本 v${booth.currentVersion.id} 上指定新的段落与码点范围。</p>
    <label>段号
      <select id="r-seg">${segList.map((s) => `<option value="${s}"${s === o.seg ? ' selected' : ''}>第 ${s} 段</option>`).join('')}</select>
    </label>
    <div style="display:flex;gap:10px">
      <label style="flex:1">起始 <input id="r-start" type="number" min="0" value="${o.start_cp}" /></label>
      <label style="flex:1">结束 <input id="r-end" type="number" min="1" value="${Math.max(o.end_cp, o.start_cp + 1)}" /></label>
    </div>
    <label>新位置文字预览
      <div class="sel-quote" id="r-preview"></div>
    </label>
    <div class="actions">
      <button class="btn" data-close>取消</button>
      <button class="btn primary" id="r-submit">确认重新定位</button>
    </div>`);
  const update = () => {
    const seg = parseInt($('#r-seg').value, 10);
    const s = parseInt($('#r-start').value, 10);
    const en = parseInt($('#r-end').value, 10);
    const text = segText(seg, booth.segments);
    let preview = '';
    if (Number.isInteger(s) && Number.isInteger(en) && s >= 0 && en <= cpLen(text) && s < en) {
      preview = cpSlice(text, s, en);
    } else {
      preview = `（范围非法：本段共 ${cpLen(text)} 个字符，须满足 0 ≤ 起始 < 结束 ≤ ${cpLen(text)}）`;
    }
    $('#r-preview').textContent = preview;
  };
  $('#r-seg').addEventListener('change', update);
  $('#r-start').addEventListener('input', update);
  $('#r-end').addEventListener('input', update);
  update();
  $('#r-submit').addEventListener('click', async () => {
    try {
      await api(`/api/objections/${o.id}/relocate`, {
        method: 'POST',
        body: {
          seg: parseInt($('#r-seg').value, 10),
          start: parseInt($('#r-start').value, 10),
          end: parseInt($('#r-end').value, 10),
        },
      });
      closeModal();
      await reload();
      toast(`异议 #${o.id} 已重新定位`, 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

// ---------- 侧栏：标签 ----------
function renderTabs() {
  $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#panel-proposals').classList.toggle('hidden', tab !== 'proposals');
  $('#panel-objections').classList.toggle('hidden', tab !== 'objections');
  $('#panel-versions').classList.toggle('hidden', tab !== 'versions');
  if (booth && booth.initialized) {
    const pending = booth.proposals.filter((p) => p.status === 'pending' && p.base_ver === booth.currentVersion.id).length;
    const relo = booth.objections.filter((o) => o.anchor_status === 'needs_relocation').length;
    const respondPending = (booth.publishCheck && booth.publishCheck.items || []).filter((x) => !x.satisfied).length;
    setBadge('badge-proposals', pending);
    setBadge('badge-objections', relo + respondPending);
  } else {
    setBadge('badge-proposals', 0);
    setBadge('badge-objections', 0);
  }
}
function setBadge(id, n) {
  const el = $('#' + id);
  if (n > 0) { el.textContent = n; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}
$$('.tab').forEach((b) => b.addEventListener('click', () => { tab = b.dataset.tab; renderTabs(); }));

// ---------- 侧栏：提议列表 ----------
function renderProposals() {
  const panel = $('#panel-proposals');
  if (!booth || !booth.initialized) {
    panel.innerHTML = '<div class="empty">尚无文档。</div>';
    return;
  }
  if (!booth.proposals.length) {
    panel.innerHTML = '<div class="empty">还没有修订提议。<br/>记录员可在正文中选择文字范围发起提议。</div>';
    return;
  }
  panel.innerHTML = booth.proposals.map((p) => {
    const cur = booth.currentVersion.id;
    const canReview = me.role === 'reviewer' && p.base_ver === cur &&
      (p.status === 'pending' || p.status === 'adopted');
    return `
    <div class="card">
      <div class="card-head">
        <span class="card-id">#${p.id} <span class="tag tag-${p.status}">${STATUS_LABEL[p.status]}</span></span>
        <span class="card-meta">v${p.base_ver} · ${p.created_at.slice(5, 16)}</span>
      </div>
      <div class="card-meta">第 ${p.seg} 段 [${p.start_cp},${p.end_cp}) · ${esc(p.creator_name)}</div>
      ${p.rebased_from_id ? `<div class="card-meta">↳ 续提自冲突提议 #${p.rebased_from_id}</div>` : ''}
      ${p.continued_by_id ? `<div class="card-meta">↳ 已续提为提议 #${p.continued_by_id}</div>` : ''}
      <div class="quote">${esc(p.original_excerpt)}</div>
      <div><span class="arrow">→</span><span class="replacement">${esc(p.replacement) || '（删除）'}</span></div>
      <div class="basis"><b>依据：</b>${esc(p.basis)}</div>
      ${p.conflict_reason ? `<div class="conflict-reason">${esc(p.conflict_reason)}</div>` : ''}
      ${canReview ? `
      <div class="card-actions">
        ${p.status === 'pending' ? `<button class="btn small primary" data-adopt="${p.id}">采纳</button>` : ''}
        ${p.status === 'adopted' ? `<span class="muted">已在暂存区</span>` : ''}
        <button class="btn small danger" data-reject="${p.id}">${p.status === 'adopted' ? '驳回并移出暂存' : '驳回'}</button>
      </div>` : ''}
      ${canRebase(p) ? `
      <div class="card-actions">
        <button class="btn small primary" data-rebase="${p.id}">续提到当前版本…</button>
      </div>` : ''}
    </div>`;
  }).join('');

  $$('#panel-proposals [data-rebase]').forEach((b) =>
    b.addEventListener('click', () => openRebase(parseInt(b.dataset.rebase, 10))));

  $$('#panel-proposals [data-adopt]').forEach((b) => b.addEventListener('click', async () => {
    const id = parseInt(b.dataset.adopt, 10);
    try {
      const r = await api(`/api/proposals/${id}/adopt`, { method: 'POST' });
      if (r.markedConflict) toast(`提议 #${id} 已标记冲突：${r.reason}`, 'error');
      else toast(`提议 #${id} 已采纳`, 'success');
      await reload();
    } catch (err) { toast(err.message, 'error'); await reload(); }
  }));
  $$('#panel-proposals [data-reject]').forEach((b) => b.addEventListener('click', async () => {
    const id = parseInt(b.dataset.reject, 10);
    const reason = prompt(`驳回提议 #${id} 的原因（可留空）：`) ?? null;
    if (reason === null) return;
    try {
      await api(`/api/proposals/${id}/reject`, { method: 'POST', body: { reason } });
      toast(`提议 #${id} 已驳回`, 'success');
      await reload();
    } catch (err) { toast(err.message, 'error'); await reload(); }
  }));
}

// ---------- 侧栏：异议列表 ----------
function renderObjections() {
  const panel = $('#panel-objections');
  if (!booth || !booth.initialized) {
    panel.innerHTML = '<div class="empty">尚无文档。</div>';
    return;
  }
  if (!booth.objections.length) {
    panel.innerHTML = '<div class="empty">还没有异议引用。<br/>任何登录用户都可在正文中选择文字范围提出异议。</div>';
    return;
  }
  panel.innerHTML = booth.objections.map((o) => {
    const gate = (booth.publishCheck && booth.publishCheck.items || []).find((x) => x.objectionId === o.id);
    let gateHtml = '';
    if (gate) {
      if (gate.satisfied) {
        gateHtml = `<div class="snapshot-note gate-ok-note">✔ 已对本次暂存修订回应（回应 #${gate.response.id}，v${gate.response.versionId}）。</div>`;
      } else {
        const why = !gate.response ? '尚无回应' : `回应已失效：${esc(gate.response.invalidReason)}`;
        gateHtml = `<div class="snapshot-note">⚠ 被暂存修订触及（提议 ${gate.proposalIds.map((x) => `#${x}`).join('、')}），发布前须回应：${why}
          ${me.role === 'reviewer' ? `<div class="card-actions"><button class="btn small primary" data-respond="${o.id}">${gate.response ? '重新回应' : '填写回应'}</button></div>` : ''}</div>`;
      }
    }
    return `
    <div class="card">
      <div class="card-head">
        <span class="card-id">#${o.id}
          ${o.anchor_status === 'needs_relocation'
            ? '<span class="tag tag-needs_relocation">待重新定位</span>'
            : '<span class="tag tag-published">有效</span>'}
        </span>
        <span class="card-meta">v${o.created_in_version} · ${o.created_at.slice(5, 16)}</span>
      </div>
      <div class="card-meta">第 ${o.seg} 段 [${o.start_cp},${o.end_cp}) · ${esc(o.creator_name)}</div>
      <label class="card-meta">被引原文快照</label>
      <div class="quote">${esc(o.quoted_text)}</div>
      <div class="basis"><b>异议：</b>${esc(o.note)}</div>
      ${o.anchor_status === 'needs_relocation' ? `
        <div class="snapshot-note">⚠ 修订后被引文字可能已不存在；此为原文快照，引用未自动指向新文字，请重新定位。</div>` : ''}
      ${gateHtml}
    </div>`;
  }).join('');
  $$('#panel-objections [data-respond]').forEach((b) =>
    b.addEventListener('click', () => openRespondForm(parseInt(b.dataset.respond, 10))));
}

// ---------- 侧栏：版本 ----------
function renderVersions() {
  const panel = $('#panel-versions');
  if (!booth || !booth.initialized) { panel.innerHTML = '<div class="empty">尚无版本。</div>'; return; }
  panel.innerHTML = booth.versions.map((v) => `
    <div class="ver-card">
      <div>
        <div class="vid">v${v.id} ${v.id === booth.currentVersion.id ? '<span class="tag tag-published">当前</span>' : ''}</div>
        <div class="card-meta">${esc(v.note) || '<span class="muted">版本备注仅工作人员可见</span>'} · ${esc(v.creator_name || '系统')} · ${v.created_at} UTC</div>
      </div>
      <button class="btn small" data-ver="${v.id}">只读查看</button>
    </div>`).join('');
  $$('#panel-versions [data-ver]').forEach((b) =>
    b.addEventListener('click', () => openVersion(parseInt(b.dataset.ver, 10))));
}

async function openVersion(id) {
  try {
    const v = await api(`/api/versions/${id}`);
    showVersionModal(v);
  } catch (err) { toast(err.message, 'error'); }
}

function showVersionModal(v) {
  openModal(`
      <div class="v-head">
        <h3>版本 v${v.id}（不可变快照）</h3>
        <button class="btn small" data-close>关闭</button>
      </div>
      <div class="v-meta">${esc(v.note) || '<span class="muted">（版本备注仅工作人员可见）</span>'} · ${v.created_at} UTC</div>
      <div class="v-section">
        <h4>正文</h4>
        <div class="paper" style="padding:16px 20px;min-height:auto">
          ${v.segments.map((s) => `
            <div class="seg${s.secret ? ' is-secret' : ''}">
              <div class="seg-no${s.secret ? ' seg-no-secret' : ''}">${s.seg}</div>
              <div class="seg-body">${s.secret
                ? `<span class="secret-placeholder">🔒 ${esc(s.text)}</span>`
                : `${esc(s.text)}<button class="btn tiny src-toggle" data-src-ver="${v.id}" data-src-seg="${s.seg}">来源</button>`}</div>
            </div>`).join('')}
        </div>
      </div>
      <div class="v-section">
        <h4>决议（${v.decisions.length}）</h4>
        ${v.decisions.length ? v.decisions.map((d) => `
          <div class="decision-item t-${d.type}">
            <b>${DECISION_LABEL[d.type] || d.type}</b>
            ${d.proposal_id ? `· 提议 #${d.proposal_id}（第 ${d.seg} 段 [${d.start_cp},${d.end_cp})，提出人 ${esc(d.proposal_creator || '')}）` : ''}
            ${d.version_id ? `· 版本 v${d.version_id}` : ''}
            ${d.reason ? ` — ${esc(d.reason)}` : ''}
            <div class="card-meta">${esc(d.actor_name || '系统')} · ${d.created_at} UTC</div>
          </div>`).join('') : '<p class="muted">初始版本无决议。</p>'}
      </div>
      <div class="v-section">
        <h4>异议（${v.objections.length}）</h4>
        ${v.objections.length ? v.objections.map((o) => `
          <div class="decision-item ${o.status === 'needs_relocation' ? 't-conflict' : ''}">
            <b>异议 #${o.id}</b> · 第 ${o.seg} 段 [${o.start_cp},${o.end_cp})
            ${o.status === 'needs_relocation' ? ' · <span class="tag tag-needs_relocation">待重新定位</span>' : ''}
            <div class="quote">${esc(o.quoted_text)}</div>
            <div class="basis">${esc(o.note)}</div>
            <div class="card-meta">${esc(o.creator_name)} · 提出于 v${o.created_in_version} · ${o.created_at} UTC</div>
          </div>`).join('') : '<p class="muted">本版本尚无异议。</p>'}
      </div>
      <div class="v-section">
        <h4>发布前异议回应（${v.responses.length}）</h4>
        ${v.responses.length ? v.responses.map((r) => `
          <div class="decision-item t-adopt">
            <b>对异议 #${r.objection_id} 的回应</b> · 第 ${r.seg} 段 [${r.start_cp},${r.end_cp})
            · 关联采纳提议 ${(r.proposalIds || []).length ? r.proposalIds.map((x) => `#${x}`).join('、') : '（无）'}
            <div class="basis">${esc(r.note)}</div>
            <div class="card-meta">${esc(r.responder_name)}（${esc(r.responder_user)}）· 回应于 v${r.version_id} · ${r.created_at} UTC · 随 v${r.published_version_id} 发布（只读归档）</div>
          </div>`).join('') : '<p class="muted">本版本无发布前异议回应（发布未触及异议，或按原规则发布）。</p>'}
      </div>`, true);
  $$('#version-box [data-src-ver]').forEach((b) =>
    b.addEventListener('click', () => openProvenance(parseInt(b.dataset.srcVer, 10), parseInt(b.dataset.srcSeg, 10), v)));
}

// ---------- 正文来源（按段、按已发布版本，逐次发布修订重放） ----------
async function openProvenance(versionId, seg, backVersion = null) {
  try {
    const data = await api(`/api/versions/${versionId}/sources/${seg}`);
    showProvenanceModal(data, backVersion);
  } catch (err) { toast(err.message, 'error'); }
}

function showProvenanceModal(data, backVersion = null) {
  const rows = (data.fragments || []).map((f) => {
    const initial = f.source === 'initial';
    return `<tr>
      <td class="src-range">[${f.start}, ${f.end})</td>
      <td class="src-text src-${f.source}">${esc(f.text) || '<span class="muted">（空）</span>'}</td>
      <td class="src-from">${initial
        ? '<span class="tag tag-published">初始导入</span>'
        : `<span class="tag tag-adopted">提议 #${f.proposalId} · v${f.versionId} 发布</span>`}</td>
    </tr>`;
  }).join('');
  openModal(`
      <div class="v-head">
        <h3>正文来源：v${data.versionId} · 第 ${data.seg} 段</h3>
        <div>
          ${backVersion ? '<button class="btn small" id="src-back">← 返回版本</button>' : ''}
          <button class="btn small" data-close>关闭</button>
        </div>
      </div>
      <p class="muted">来源按逐次发布的修订逐码点重放：未被触及的文字保留原来源；替换或插入的文字归最后写入它的已发布提议；
        删除不占结果；不按同文搜索猜测。区间为该版本第 ${data.seg} 段的 Unicode 码点半开区间 [start, end)，共 ${data.length} 个码点。</p>
      <div class="src-legend">
        <span class="tag tag-published">初始导入</span>
        <span class="tag tag-adopted">已发布提议（编号·发布版本）</span>
      </div>
      <table class="src-table">
        <thead><tr><th>码点区间</th><th>片段文字</th><th>来源</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3" class="muted">该段为空。</td></tr>'}</tbody>
      </table>`, true);
  const back = $('#src-back');
  if (back && backVersion) back.addEventListener('click', () => showVersionModal(backVersion));
}

// ---------- 发布 ----------
function gateItems() {
  return (booth && booth.publishCheck && booth.publishCheck.items) || [];
}

function renderPublishBar() {
  const bar = $('#publish-bar');
  if (me.role !== 'reviewer' || !booth.stage.length) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const segDesc = {};
  for (const p of booth.stage) {
    segDesc[p.seg] = (segDesc[p.seg] || 0) + 1;
  }
  $('#stage-summary').innerHTML =
    `暂存区：<b>${booth.stage.length}</b> 项已采纳修订（` +
    Object.entries(segDesc).map(([s, n]) => `第${s}段×${n}`).join('、') +
    `）。互不重叠的修订将合并发布为 v${booth.currentVersion.id + 1}`;

  // 发布前回应门槛
  const items = gateItems();
  const pending = items.filter((it) => !it.satisfied);
  const gate = $('#publish-gate');
  if (!items.length) {
    gate.innerHTML = '<div class="gate-ok">本批暂存修订未触及任何异议，可按原规则发布。</div>';
  } else if (!pending.length) {
    gate.innerHTML = `<div class="gate-ok">✔ 被暂存修订触及的 ${items.length} 条异议均已逐条回应，可发布。</div>`;
  } else {
    gate.innerHTML =
      `<div class="gate-warn">⚠ 发布前须逐条回应被暂存修订触及的 ${items.length} 条异议；` +
      `尚有 <b>${pending.length}</b> 条待回应（或回应已失效），发布将被拒绝：</div>` +
      `<div class="gate-list">${pending.map((it) => {
        const why = !it.response
          ? '尚无回应'
          : `回应已失效：${esc(it.response.invalidReason)}`;
        const relo = it.anchorStatus === 'needs_relocation' ? '（异议待重新定位）' : '';
        return `<div class="gate-item">
          <div>异议 #${it.objectionId}${relo} · 第 ${it.seg} 段 [${it.start},${it.end}) · 触及提议 ${
            it.proposalIds.map((x) => `#${x}`).join('、')}</div>
          <div class="gate-quote">“${esc(it.quotedText)}”</div>
          <div class="gate-why">${esc(why)}</div>
          <button class="btn small primary" data-respond="${it.objectionId}">${it.response ? '重新回应' : '填写回应'}</button>
        </div>`;
      }).join('')}</div>`;
    $$('#publish-gate [data-respond]').forEach((b) =>
      b.addEventListener('click', () => openRespondForm(parseInt(b.dataset.respond, 10))));
  }
  $('#publish-btn').disabled = pending.length > 0;
  $('#publish-btn').textContent = pending.length > 0
    ? `发布新版本（${pending.length} 条异议待回应）` : '发布新版本';
}

function openRespondForm(objectionId) {
  const it = gateItems().find((x) => x.objectionId === objectionId);
  if (!it) return;
  const oldNote = it.response && it.response.note ? it.response.note : '';
  openModal(`
    <h3>发布前回应异议 #${objectionId}</h3>
    <p class="muted">回应将关联本异议、触及它的已采纳提议（${it.proposalIds.map((x) => `#${x}`).join('、')}），
      以及当前版本 v${booth.currentVersion.id} 与暂存状态；采纳/驳回提议、重新定位异议后须重新核对，失效回应不能发布。</p>
    <div class="card-meta">第 ${it.seg} 段 · 当前锚点 [${it.start}, ${it.end})${
      it.anchorStatus === 'needs_relocation' ? ' · <span class="tag tag-needs_relocation">待重新定位</span>' : ''}
      · 提出于 v${it.createdInVersion}</div>
    <label>被引原文快照（始终保留）</label>
    <div class="sel-quote">${esc(it.quotedText)}</div>
    <div class="basis"><b>异议说明：</b>${esc(it.note)}</div>
    ${it.response && it.response.invalidReason
      ? `<div class="conflict-reason">上一份回应（#${it.response.id}）已失效：${esc(it.response.invalidReason)}</div>` : ''}
    <label>回应说明 <em style="color:var(--danger)">*</em>
      <textarea id="f-respond" rows="4" placeholder="如：经核对录音，该修订不影响异议所指事实，异议留待下一版处理；或：异议成立，暂缓发布本修订……">${esc(oldNote)}</textarea>
    </label>
    <div class="actions">
      <button class="btn" data-close>取消</button>
      <button class="btn primary" id="f-respond-submit">保存回应</button>
    </div>`);
  $('#f-respond-submit').addEventListener('click', async () => {
    try {
      const r = await api(`/api/objections/${objectionId}/respond`, {
        method: 'POST',
        body: { note: $('#f-respond').value },
      });
      closeModal();
      await reload();
      toast(`异议 #${objectionId} 的回应 #${r.id} 已保存（关联 v${r.versionId} 暂存状态）`, 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

$('#publish-btn').addEventListener('click', async () => {
  try {
    const r = await api('/api/publish', { method: 'POST', body: { note: $('#publish-note').value } });
    $('#publish-note').value = '';
    toast(`已发布新版本 v${r.versionId}`, 'success');
    await reload();
  } catch (err) { toast(err.message, 'error'); await reload(); }
});

// ---------- 导入 ----------
$('#import-file').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => { $('#import-text').value = reader.result; };
  reader.readAsText(file, 'utf-8');
});

$('#import-btn').addEventListener('click', async () => {
  $('#import-msg').textContent = '';
  const text = $('#import-text').value;
  if (!text.trim()) { $('#import-msg').textContent = '逐字稿内容为空'; return; }
  try {
    const r = await api('/api/doc/import', {
      method: 'POST',
      body: { title: $('#import-title').value, text },
    });
    toast(`已导入并发布初始版本 v${r.baseVersionId}`, 'success');
    await reload();
  } catch (err) { $('#import-msg').textContent = err.message; }
});

// 全局快捷键：Esc 关闭
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeModal(); hideSelectionToolbar(); }
});

boot();
