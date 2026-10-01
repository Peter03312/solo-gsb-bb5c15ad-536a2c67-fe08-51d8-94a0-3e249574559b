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

// ---------- 正文来源重放 ----------
// 按逐次发布的修订逐码点重放正文来源。
// initialText：查询版本所在段的 v1 原文（码点数组，每个码点初始来源标签 tag(null)）；
// steps：[{ version, edits:[{id,start,end,replace}] }, ...]，edits 即该版发布时
//   实际合入该段的已采纳提议（坐标为该版基版坐标）。store 按 start、id 升序取出，
//   发布合版 applyEdits 以 start 降序稳定排序（同起点保持原 id 升序）右起应用；
//   此处使用相同迭代次序（start 降序、并列 id 升序），包括零长度插入与空串删除。
// 规则（纯几何重放，绝不按同文搜索猜测）：
// - 未被任何修订触及的码点保留原来源标签；
// - 被替换/插入的码点（含把原文换成相同文字的情形）标签改为本次提议 {proposalId,version}；
// - 删除（end>start、replace 为空）不产出码点，不占结果；
// - 零长度修订（纯插入）产出的码点同样归本次提议。
// 返回与 applyEdits 等价的 token 数组：[{ch, tag}]；相邻同标签的合并由调用方完成。
function replayProvenance(initialText, steps) {
  let tokens = Array.from(initialText).map((ch) => ({ ch, tag: null }));
  for (const step of steps) {
    for (const e of step.edits.slice().sort((a, b) =>
      b.start - a.start || a.id - b.id
    )) {
      const inserted = Array.from(e.replace).map((ch) => ({
        ch,
        tag: { proposalId: e.id, version: step.version },
      }));
      // 与 applyEdits 的右起切片完全一致：删除 [start,end)，再在同点放入替换码点
      tokens = tokens.slice(0, e.start).concat(inserted, tokens.slice(e.end));
    }
  }
  return tokens;
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
