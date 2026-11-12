import test from 'node:test';
import assert from 'node:assert/strict';
import { R, A, K, rootAt, load } from './_studio.mjs';
const { tl, plan: P } = load('duck-arm');
test('机械臂版：每个镜头全程可达、不超关节限位、离地面和小鸭子有间隙', () => {
  assert.ok(P.takes.length >= 4);
  for (const t of P.takes) { assert.ok(t.ok, t.name); assert.equal(t.unreach, 0); assert.ok(t.minClr > 0.03, `${t.name} 间隙 ${t.minClr}`); }
});
test('镜头真的在该在的位置：正运动学算出的镜头位置 = 运镜里的机位（误差 < 3 mm），视线对准主体', () => {
  const ev = { cam: {} };
  for (let t = 0.01; t < tl.dur; t += 0.173) {
    R.evalAt(tl, t, ev);
    const r = rootAt(ev.clip, ev.s), tgt = [r[0], r[1], r[2] + P.opt.lookUp], eu = R.eyeUp(ev.cam, tgt), b = P.opt.base;
    const F = K.fk(A.qAt(P, t), [0, 0]), L = F[7], lens = [L[3] + b[0], L[7] + b[1], L[11] + b[2]];
    assert.ok(Math.hypot(lens[0] - eu.eye[0], lens[1] - eu.eye[1], lens[2] - eu.eye[2]) < 0.003, `t=${t.toFixed(2)}`);
    const d = [tgt[0] - lens[0], tgt[1] - lens[1], tgt[2] - lens[2]], dl = Math.hypot(...d), z = [L[2], L[6], L[10]];
    assert.ok((d[0] * z[0] + d[1] * z[1] + d[2] * z[2]) / dl > 0.9995, '视线偏了');
  }
});
test('放慢倍数：不小于 1；放慢之后各关节的峰值速度和加速度都在上限内', () => {
  const D = Math.PI / 180;
  P.segs.forEach((s, i) => {
    assert.ok(s.slow >= 1);
    const take = P.takes.find(t => t.seg === tl.segs[i].base);
    s.peakV.forEach((v, j) => assert.ok(v / take.slow <= K.VMAX[j] * D * 1.001));
    s.peakA.forEach((a, j) => assert.ok(a / take.slow ** 2 <= K.AMAX[j] * D * 1.001));
  });
  assert.ok(P.slow < 20, `放慢 ${P.slow} 倍太离谱，多半是逆解跳支了`);
});
test('起步段：有加速段时段首速率为 0（真机不会被要求瞬间到最大速度）', () => {
  for (const g of tl.segs) assert.ok(Math.abs(R.evalAt(tl, g.t0 + 1e-9).rate) < 1e-3);
});
test('导出的 CSV：7 列、时间递增、时长等于真机时长', () => {
  const t = P.takes[0], rows = A.takeCsv(P, t.seg).split('\n');
  assert.equal(rows[0], 't,j1,j2,j3,j4,j5,j6');
  const last = rows[rows.length - 1].split(',').map(Number); assert.equal(last.length, 7); assert.ok(Math.abs(last[0] - t.realDur) < 0.03);
  assert.ok(rows.slice(1).every(r => r.split(',').every(v => Number.isFinite(+v))));
});
