'use strict';
// 文本工具：全程以 Unicode 码点（character）为偏移单位，前端用 Array.from 保持一致。

function codeLength(s) {
  let n = 0;
  // eslint-disable-next-line no-unused-vars
  for (const _ of s) n++;
  return n;
}

function sliceCP(s, start, end) {
  return Array.from(s).slice(start, end).join('');
}

// 校验并归一化范围：返回 {start,end,length,excerpt}，非法范围抛出带 reason 的错误
function validateRange(text, start, end) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw Object.assign(new Error('范围端点必须为整数'), { status: 400 });
  }
  const length = codeLength(text);
  if (start < 0 || end < 0 || start > end || end > length) {
    throw Object.assign(
      new Error(`非法范围 [${start},${end})：当前段共 ${length} 个字符，须满足 0 ≤ start ≤ end ≤ ${length}`),
      { status: 400, code: 'BAD_RANGE' }
    );
  }
  return { start, end, length, excerpt: sliceCP(text, start, end) };
}

// 两处范围是否重叠（半开区间；[0,2) 与 [2,4) 不重叠，可无缝相接）
function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

// 将一组同段内互不重叠的替换应用到原文（右起应用，避免偏移漂移）
function applyEdits(text, edits) {
  let result = text;
  for (const e of edits.slice().sort((a, b) => b.start - a.start)) {
    result = sliceCP(result, 0, e.start) + e.replace + sliceCP(result, e.end);
  }
  return result;
}

// 发布时把旧引用范围经一组互不重叠的修订映射到新文本坐标。
// 返回 {start,end,affected}。affected=true 表示引用与某次修订相交，
// 被引文字可能已不存在；此时坐标只是粗略几何记录，调用方必须把异议标记为
// needs_relocation 并保留原文快照，UI 不得据此悄悄指向新文字。
function transformRange(range, edits) {
  let { start, end } = range;
  let affected = false;
  for (const e of edits.slice().sort((a, b) => a.start - b.start)) {
    const d = codeLength(e.replace) - (e.end - e.start);
    if (e.end <= start) {
      start += d;
      end += d;
    } else if (e.start >= end) {
      // 修订完全在引用之后，不变
    } else {
      affected = true;
      start = Math.min(start, e.start);
      end = Math.max(start, e.start + codeLength(e.replace));
    }
  }
  return { start, end, affected };
}

// 续提换算：把基版坐标下的半开选区映射过一组同段互不重叠的修订（同一版本步内）。
// 与 transformRange 的差异：比较始终在原坐标系进行、位移累积计算（相邻修订互不干扰）；
// 零长度选区（插入点）被任何修订区间触及（start <= k <= end）即视为受影响——
// 此时插入点相对新旧文字的位置无法可靠推断，调用方必须拒绝自动换算，
// 不得凭同文搜索猜测位置。
function transformRangeRebase(range, edits) {
  const { start, end } = range;
  const point = start === end;
  let delta = 0;
  for (const e of edits.slice().sort((a, b) => a.start - b.start)) {
    const d = codeLength(e.replace) - (e.end - e.start);
    if (point) {
      if (e.start <= start && start <= e.end) return { start, end, affected: true };
      if (e.end < start) delta += d;
    } else if (e.end <= start) {
      delta += d;
    } else if (e.start < end) {
      return { start, end, affected: true };
    }
  }
  return { start: start + delta, end: end + delta, affected: false };
}

// ---------- 片段来源重放 ----------
// 从初始导入的整段文字出发，沿逐次发布的修订按纯几何坐标重放，跟踪每个连续片段的来源：
// 未被修订触及的文字保留原来源；替换或插入的文字归本次发布的提议；被删除的文字不占结果。
// 绝不按同文搜索猜测来源（即使新文字与旧文字相同，也按坐标归属）。
//   initialLength：初始版本（v1）该段的码点长度
//   versionEdits：[{ versionId, edits: [{ start, end, replaceLen, proposalId }] }] 按版本升序；
//                 edits 为该版本发布时合入的同段修订（互不重叠，坐标基于上一版本正文）
// 返回 [{ start, end, source }]：无缝铺满 [0, 最终长度) 的半开区间序列（相邻同来源已合并），
// source 为 { type:'import' } 或 { type:'proposal', proposalId, versionId }。
function replayProvenance(initialLength, versionEdits) {
  let spans = [];
  if (initialLength > 0) spans.push({ start: 0, end: initialLength, source: { type: 'import' } });
  for (const ve of versionEdits || []) {
    // 同位置纯插入与合版顺序保持一致：位置相同者按提议编号倒序（后提交者的文字排在前面）
    const edits = (ve.edits || [])
      .slice()
      .sort((a, b) => a.start - b.start || a.end - b.end || b.proposalId - a.proposalId);
    if (edits.length === 0) continue;
    const next = [];
    let si = 0;     // 当前待读的旧片段下标
    let cursor = 0; // 已处理到的旧坐标
    let shift = 0;  // 累积位移：新坐标 = 旧坐标 + shift
    // 把旧文本 [from, to) 的片段按当前位移复制到 next（保留原来源，边界处切分）
    const copyOld = (from, to) => {
      while (si < spans.length && spans[si].end <= from) si++;
      for (let j = si; j < spans.length && spans[j].start < to; j++) {
        const s = Math.max(spans[j].start, from);
        const e = Math.min(spans[j].end, to);
        if (s < e) next.push({ start: s + shift, end: e + shift, source: spans[j].source });
      }
    };
    for (const e of edits) {
      copyOld(cursor, e.start); // 修订之前的旧文字：保留原来源
      const rlen = e.replaceLen || 0;
      if (rlen > 0) {
        // 替换/插入文字：归本次发布的提议
        next.push({
          start: e.start + shift,
          end: e.start + shift + rlen,
          source: { type: 'proposal', proposalId: e.proposalId, versionId: ve.versionId },
        });
      }
      shift += rlen - (e.end - e.start); // 被删除的旧文字不占结果
      cursor = e.end;
    }
    copyOld(cursor, Infinity); // 尾部旧文字
    spans = next;
  }
  // 合并相邻同来源片段（删除旧文字后两侧同来源文字重新相接）
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && last.end === sp.start && sameSource(last.source, sp.source)) last.end = sp.end;
    else merged.push({ start: sp.start, end: sp.end, source: sp.source });
  }
  return merged;
}

function sameSource(a, b) {
  if (a.type !== b.type) return false;
  return a.type === 'import' || (a.proposalId === b.proposalId && a.versionId === b.versionId);
}

// 发布前回应门槛：暂存修订（edit）是否触及异议当前锚点（anchor）。
// - 非零长度修订：两个半开区间相交即触及（[0,2) 与 [2,4) 相接不算）；
// - 零长度修订（纯插入）：插入点落在引用范围 [anchor.start, anchor.end) 内即触及
//   （点等于引用起点算触及，等于引用终点不算，与半开区间口径一致）。
function editTouchesAnchor(edit, anchor) {
  if (edit.start === edit.end) {
    return anchor.start <= edit.start && edit.start < anchor.end;
  }
  return edit.start < anchor.end && anchor.start < edit.end;
}

module.exports = {
  codeLength,
  sliceCP,
  validateRange,
  overlaps,
  applyEdits,
  transformRange,
  transformRangeRebase,
  editTouchesAnchor,
  replayProvenance,
};
