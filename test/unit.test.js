'use strict';
// 纯文本算子单元测试（码点偏移、合版、引用映射、续提换算）
const assert = require('assert');
const { codeLength, sliceCP, validateRange, applyEdits, transformRange, transformRangeRebase, editTouchesAnchor } = require('../src/text');
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

console.log(`\n单元测试全部通过：${n} 项 ✅`);
