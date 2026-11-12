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

// ---- 干涉检测与自动修正 ----
import { load as loadScript, rootAt as rootAt2, R as R2, A as A2, S as S2, clipDur as clipDur2, readScript as readScript2 } from './_studio.mjs';
function planOf(sc) { const c = S2.compile(sc, clipDur2), tl2 = R2.build(c.shots, c.bpm, { attack: c.attack }); const o = { base: c.rig.base, mount: c.rig.mount, lookUp: c.subject.lookUp, subjectR: c.subject.radius, subjectHalf: c.subject.half || 0, subjectYaw: c.subject.yaw || 0 }; return { tl: tl2, o, plan: A2.plan(tl2, rootAt2, o) }; }

test('干涉检测：示例脚本全程没有干涉；把机位怼到主体上会报“碰到主体”，并指出是哪一段', () => {
  const ok = planOf(readScript2('duck-arm'));
  for (let t = 0.05; t < ok.tl.dur; t += 0.31) assert.equal(A2.stateAt(ok.plan, t).mask, 0, `t=${t.toFixed(2)} 不该有干涉`);
  // 面板不让把距离设到 0.15 米以内，这里绕过校验直接改时间轴，造一个镜头贴到主体上的情况
  const c0 = S2.compile(readScript2('duck-arm'), clipDur2), tlb = R2.build(c0.shots, c0.bpm, { attack: c0.attack });
  tlb.segs[0].cam = Object.assign({}, tlb.segs[0].cam, { dist: [0.3, 0.1] });
  const ob = { base: c0.rig.base, mount: c0.rig.mount, lookUp: c0.subject.lookUp, subjectR: c0.subject.radius };
  const bad = { tl: tlb, plan: A2.plan(tlb, rootAt2, ob) }, take = bad.plan.takes[0];
  assert.equal(take.ok, false); assert.ok(take.issues.some(x => /干涉/.test(x) && /主体/.test(x)), take.issues.join('；'));
  const st = A2.stateAt(bad.plan, bad.tl.segs[0].t1 - 0.01); assert.ok(st.mask !== 0 && st.hits.some(h => h.what === 'subject'));
});
test('自动修正：够不着的镜头能改成拍得了的，而且只在原机位附近小改', () => {
  const sc = readScript2('duck-arm'); sc.shots[0].cam.dist = [0.52, 1.8];
  const b = planOf(sc); assert.equal(b.plan.takes[0].ok, false);
  let last; for (const step of A2.repair(b.tl.segs[0], rootAt2, b.o)) last = step;
  assert.ok(last.done && last.ok && last.changed, JSON.stringify({ ok: last.ok, evals: last.evals }));
  assert.ok(last.cam.dist[1] < 1.8 && last.cam.dist[1] > 0.5, '终点距离应该被拉近到够得着的范围，但不该离谱：' + last.cam.dist[1]);
  assert.ok(Math.abs(last.cam.dist[0] - 0.52) < 0.2 && Math.abs(last.cam.az[0] - b.tl.segs[0].cam.az[0]) < 0.5, '起点基本不动');
  assert.equal(A2.planShot(Object.assign({}, b.tl.segs[0], { cam: Object.assign({}, b.tl.segs[0].cam, last.cam) }), rootAt2, Object.assign({}, A2.DEF, b.o)).ok, true);
});
test('自动修正：本来就没问题的镜头不会被改', () => {
  const b = planOf(readScript2('duck-arm')); let last; for (const step of A2.repair(b.tl.segs[0], rootAt2, b.o)) last = step;
  assert.ok(last.ok && !last.changed);
});

test('赛车脚本：全部镜头机械臂可达、全程无干涉；长条主体按横放的胶囊体检查，朝向会影响结果', () => {
  const sc = readScript2('car-arm'), c = S2.compile(sc, clipDur2), tl2 = R2.build(c.shots, c.bpm, { attack: c.attack });
  const o = { base: c.rig.base, mount: c.rig.mount, lookUp: c.subject.lookUp, subjectR: c.subject.radius, subjectHalf: c.subject.half, subjectYaw: c.subject.yaw };
  const P2 = A2.plan(tl2, rootAt2, o);
  assert.ok(P2.ok, P2.takes.filter(t => !t.ok).map(t => t.name + '：' + t.issues.join('；')).join(' / '));
  assert.ok(Math.abs(c.subject.yaw - (-40 * Math.PI / 180)) < 1e-9);
  for (let t = 0.05; t < tl2.dur; t += 0.29) assert.equal(A2.stateAt(P2, t).mask, 0);
  // 同一个姿态：主体当成一个球时没事，当成一根朝着机械臂伸过来的长条就碰上了
  const F = A2.stateAt(P2, 0.05).F, lens = [F[7][3], F[7][7], F[7][11]], subj = [lens[0], lens[1] + 0.3, lens[2]];
  assert.equal(A2.collide(F, subj, Object.assign({}, P2.opt, { subjectHalf: 0, subjectR: 0.05 })).hits.filter(h => h.what === 'subject').length, 0);
  assert.ok(A2.collide(F, subj, Object.assign({}, P2.opt, { subjectHalf: 0.3, subjectYaw: Math.PI / 2, subjectR: 0.05 })).hits.some(h => h.what === 'subject'));
});
