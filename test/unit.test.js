'use strict';
// 纯文本算子单元测试（码点偏移、合版、引用映射、续提换算）
const assert = require('assert');
const { codeLength, sliceCP, validateRange, applyEdits, transformRange, transformRangeRebase, editTouchesAnchor, replayProvenance } = require('../src/text');
const { parseTranscript } = require('../src/store');

let n = 0;
const ok = (c, m) => { assert(c, m); n++; console.log('  ✓', m); };

// 码点计数：emoji 占 1 码点但 2 UTF-16 单元
const s = 'a😀b';
ok(codeLength(s) === 3, '😀 按 1 个码点计数');
ok(sliceCP(s, 1, 2) === '😀', '按码点切出 emoji');

// 范围校验以码点为准
const vr = validateRange(s, 1, 2);
ok(vr.excerpt === '😀', '非法范围判定基于码点而非 UTF-16');
assert.throws(() => validateRange(s, 0, 4), /非法范围/, '越界范围抛错');

// 同段多修订互不重叠：右起合并、彼此不影响
const text = '甲乙丙丁戊';
const merged = applyEdits(text, [
  { start: 0, end: 1, replace: 'X' },     // 甲 -> X
  { start: 2, end: 3, replace: 'YY' },    // 丙 -> YY
  { start: 4, end: 5, replace: '' },      // 删除戊
]);
ok(merged === 'X乙YY丁', `多处不重叠修订合并为“${merged}”`);

// 引用映射：修订在引用之前 → 平移且仍有效
let t = transformRange({ start: 3, end: 4 }, [{ start: 0, end: 1, replace: 'XYZ' }]);
ok(t.start === 5 && t.end === 6 && t.affected === false, '引用在修订之后：平移 +2，不受影响');

// 引用与修订相交 → affected，须重新定位
t = transformRange({ start: 2, end: 5 }, [{ start: 3, end: 4, replace: 'Q' }]);
ok(t.affected === true, '引用与修订相交：标记需重新定位');

// 修订在引用之后 → 坐标不变
t = transformRange({ start: 0, end: 2 }, [{ start: 3, end: 4, replace: 'QQQQ' }]);
ok(t.start === 0 && t.end === 2 && t.affected === false, '引用在修订之前：坐标不变');

// ---------- 续提换算（transformRangeRebase） ----------
// 非零选区：前方相邻修订长度有增有减，位移应累积计算
let rb = transformRangeRebase({ start: 5, end: 7 }, [
  { start: 0, end: 4, replace: 'X' },   // Δ = -3
  { start: 4, end: 5, replace: 'YY' },  // Δ = +1
]);
ok(rb.start === 3 && rb.end === 5 && rb.affected === false, '续提换算：相邻修订累积平移 [5,7)→[3,5)');

// 修订与选区相交 → 受影响，拒绝换算
rb = transformRangeRebase({ start: 2, end: 5 }, [{ start: 4, end: 6, replace: 'Q' }]);
ok(rb.affected === true, '续提换算：修订与选区相交即受影响');

// 边界相接不算触及（半开区间，可无缝相接）
rb = transformRangeRebase({ start: 2, end: 5 }, [{ start: 0, end: 2, replace: 'XYZ' }]);
ok(rb.start === 3 && rb.end === 6 && rb.affected === false, '续提换算：修订终点与选区起点相接不算触及');

// 零长度插入点：严格在前方的修订 → 平移
rb = transformRangeRebase({ start: 4, end: 4 }, [{ start: 0, end: 2, replace: 'XYZW' }]);
ok(rb.start === 6 && rb.end === 6 && rb.affected === false, '插入点：前方修订使其平移 +2');

// 插入点被修订区间覆盖 → 受影响
rb = transformRangeRebase({ start: 4, end: 4 }, [{ start: 3, end: 6, replace: 'Q' }]);
ok(rb.affected === true, '插入点被修订区间覆盖：受影响');

// 插入点恰在修订起点 / 终点 → 均视为触及
rb = transformRangeRebase({ start: 4, end: 4 }, [{ start: 4, end: 6, replace: 'Q' }]);
ok(rb.affected === true, '插入点恰在修订起点：触及');
rb = transformRangeRebase({ start: 4, end: 4 }, [{ start: 2, end: 4, replace: 'Q' }]);
ok(rb.affected === true, '插入点恰在修订终点：触及');

// 插入点之后的修订 → 不变
rb = transformRangeRebase({ start: 4, end: 4 }, [{ start: 5, end: 8, replace: 'Q' }]);
ok(rb.start === 4 && rb.end === 4 && rb.affected === false, '插入点之后的修订不影响');

// 解析：段号与自动编号
const segs = parseTranscript('1. 第一段\n2、第二段\n无段号正文\n4 第四段\n');
ok(segs.length === 4, `解析 4 段（段号、顿号、空格分隔、自动编号），实际 ${segs.length}`);
ok(segs[0].seg === 1 && segs[1].seg === 2 && segs[2].seg === 3 && segs[3].seg === 4,
  '无段号行自动顺延编号为 3，后续显式段号 4 正常');

assert.throws(() => parseTranscript('1. 甲\n1. 乙'), /重复/, '重复段号报错');
assert.throws(() => parseTranscript('   \n\n'), /空|未解析/, '空稿报错');

// ---------- 发布前回应门槛：暂存修订是否触及异议锚点（editTouchesAnchor） ----------
// 非零长度修订：半开区间相交即触及，端点相接不算
ok(editTouchesAnchor({ start: 2, end: 5 }, { start: 5, end: 8 }) === false, '门槛：修订起点等于引用终点（相接）不算触及');
ok(editTouchesAnchor({ start: 5, end: 7 }, { start: 2, end: 5 }) === false, '门槛：修订终点等于引用起点（相接）不算触及');
ok(editTouchesAnchor({ start: 3, end: 6 }, { start: 2, end: 5 }) === true, '门槛：区间相交算触及');
ok(editTouchesAnchor({ start: 0, end: 2 }, { start: 1, end: 3 }) === true, '门槛：部分相交算触及');
ok(editTouchesAnchor({ start: 3, end: 4 }, { start: 9, end: 12 }) === false, '门槛：完全不相交不算触及');
// 零长度修订（纯插入）：插入点落在引用范围 [a,b) 内（a ≤ 点 < b）算触及
ok(editTouchesAnchor({ start: 5, end: 5 }, { start: 2, end: 8 }) === true, '门槛：零长度插入点在引用范围内算触及');
ok(editTouchesAnchor({ start: 2, end: 2 }, { start: 2, end: 8 }) === true, '门槛：插入点恰在引用起点算触及');
ok(editTouchesAnchor({ start: 8, end: 8 }, { start: 2, end: 8 }) === false, '门槛：插入点恰在引用终点不算触及');
ok(editTouchesAnchor({ start: 9, end: 9 }, { start: 2, end: 8 }) === false, '门槛：插入点在引用范围外不算触及');

// ---------- 正文来源重放（replayProvenance） ----------
function tagOf(tokens, i) { return tokens[i].tag; }
// v1 初始：无任何发布步骤 → 全部归初始导入
let tk = replayProvenance('甲乙丙丁', []);
ok(tk.map((t) => t.ch).join('') === '甲乙丙丁' && tk.every((t) => t.tag === null),
  '来源重放：v1 原文全部标记为初始导入');

// 单版多处修订（替换、插入、删除混合）：触及文字归本次提议，未触及保留原来源，删除不占结果
tk = replayProvenance('甲乙丙丁戊', [
  { version: 2, edits: [
    { id: 7, start: 0, end: 1, replace: 'X' },    // 甲 -> X
    { id: 8, start: 2, end: 3, replace: 'Y' },    // 丙 -> Y
    { id: 9, start: 4, end: 5, replace: '' },     // 删除戊
  ] },
]);
ok(tk.map((t) => t.ch).join('') === 'X乙Y丁', '来源重放：多修订合版文本与 applyEdits 一致');
ok(tk[0].tag && tk[0].tag.proposalId === 7 && tk[0].tag.version === 2, '替换文字归提议 #7@v2');
ok(tagOf(tk, 1) === null, '未触及文字“乙”保留初始导入来源');
ok(tk[2].tag && tk[2].tag.proposalId === 8, '替换文字归提议 #8');
ok(tagOf(tk, 3) === null && tk.length === 4, '删除不占结果，后续“丁”仍为初始来源');

// 相邻边界：[0,1) 与 [1,2) 无缝相接，来源各自正确、不串行
tk = replayProvenance('甲乙丙', [
  { version: 3, edits: [
    { id: 1, start: 0, end: 1, replace: 'P' },
    { id: 2, start: 1, end: 2, replace: 'Q' },
  ] },
]);
ok(tk.map((t) => t.ch).join('') === 'PQ丙', '来源重放：相邻修订合并正确');
ok(tk[0].tag.proposalId === 1 && tk[1].tag.proposalId === 2 && tagOf(tk, 2) === null,
  '相邻边界处来源按几何区间归属，不按同文搜索');

// 纯插入（零长度修订）：插入码点归提议，原文字保留
tk = replayProvenance('甲乙', [
  { version: 4, edits: [{ id: 3, start: 1, end: 1, replace: '插' }] },
]);
ok(tk.map((t) => t.ch).join('') === '甲插乙', '来源重放：零长度插入合版正确');
ok(tagOf(tk, 0) === null && tk[1].tag.proposalId === 3 && tagOf(tk, 2) === null,
  '纯插入码点归提议，两侧原文字保留初始来源');

// 后续再次改写：最后写入该片段的提议才是来源；换成相同文字也算重写
tk = replayProvenance('甲乙丙', [
  { version: 2, edits: [{ id: 1, start: 0, end: 3, replace: 'XYZ' }] },
  { version: 3, edits: [{ id: 2, start: 0, end: 3, replace: '甲乙丙' }] }, // 同文重写
]);
ok(tk.map((t) => t.ch).join('') === '甲乙丙', '来源重放：同文重写后文本不变');
ok(tk.every((t) => t.tag && t.tag.proposalId === 2 && t.tag.version === 3),
  '同文搜索不可猜来源：同文重写后全部归最后写入的提议 #2@v3');

// 后续部分改写：只覆盖其中一段，其余保留上一版提议来源
tk = replayProvenance('ABC', [
  { version: 2, edits: [{ id: 1, start: 0, end: 3, replace: 'XYZ' }] },
  { version: 3, edits: [{ id: 2, start: 1, end: 2, replace: 'Q' }] },
]);
ok(tk.map((t) => t.ch).join('') === 'XQZ', '来源重放：再次部分改写合版正确');
ok(tk[0].tag.proposalId === 1 && tk[1].tag.proposalId === 2 && tk[2].tag.proposalId === 1,
  '再次改写只改被触及片段，其余来源沿修订历史保留');

// 码点口径：emoji 作为 1 个码点被整段替换
tk = replayProvenance('a😀b', [
  { version: 2, edits: [{ id: 5, start: 1, end: 2, replace: '🙂' }] },
]);
ok(tk.map((t) => t.ch).join('') === 'a🙂b' && tk[1].tag.proposalId === 5,
  '来源重放：增补平面字符按 1 码点处理');

// 同点两个零长度插入：与发布合版相同的稳定次序（id 小的先应用，后续应用的同点插入在其左侧）
tk = replayProvenance('甲乙', [
  { version: 2, edits: [
    { id: 1, start: 1, end: 1, replace: 'L' },
    { id: 2, start: 1, end: 1, replace: 'R' },
  ] },
]);
ok(tk.map((t) => t.ch).join('') === '甲RL乙' && tk[1].tag.proposalId === 2 && tk[2].tag.proposalId === 1,
  '来源重放：同点零长度插入按合版实际顺序归属（后应用的 #2 文本在左、#1 在右）');

console.log(`\n单元测试全部通过：${n} 项 ✅`);
