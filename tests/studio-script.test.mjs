import test from 'node:test';
import assert from 'node:assert/strict';
import { S, R, A, K, clipDur, readScript, load, scriptNames } from './_studio.mjs';

test('示例脚本全部通过校验', () => { for (const n of scriptNames) assert.deepEqual(S.validate(readScript(n), clipDur), [], n); });
test('校验给出看得懂的问题：缺机位、动作不存在、超时长、开头就倒放、真机没留加速段', () => {
  const sc = readScript('duck-arm');
  const bad = S.clone(sc); delete bad.shots[0].cam; bad.shots[4].clip = 'moonwalk'; bad.shots[6].to = 99; bad.attack = 0;
  const E = S.validate(bad, clipDur).join('\n');
  assert.match(E, /第 1 个镜头.*缺 cam/); assert.match(E, /没有叫 moonwalk 的动作/); assert.match(E, /只有 \d+\.\d+ 秒/); assert.match(E, /attack 必须大于 0/);
  assert.match(S.validate({ subject: { type: 'duck' }, attack: 0.1, shots: [{ reverse: true, beats: 1 }] }).join(), /前面还没有/);
  assert.throws(() => S.compile(bad, clipDur), e => Array.isArray(e.issues) && e.issues.length >= 4);
});
test('编译：度转弧度，倒放 / 重复标记正确，静物没有动作片段', () => {
  const c = S.compile(readScript('duck-arm'), clipDur);
  assert.ok(Math.abs(c.shots[0].cam.az[0] - (-60 * Math.PI / 180)) < 1e-9);
  assert.equal(c.shots[1].rev, true); assert.equal(c.shots[2].again, true);
  const p = S.compile(readScript('product-arm'), clipDur); assert.equal(p.shots[0].clip, null); assert.equal(p.subject.type, 'product');
});
test('面板操作：加镜头 / 加倒放 / 删除，结果仍然合法，原脚本不变', () => {
  const sc = readScript('product-arm'), n0 = sc.shots.length;
  let n = S.addShot(sc, 0, 'reverse'); assert.equal(n.shots.length, n0 + 1); assert.equal(n.shots[1].reverse, true);
  n = S.addShot(n, 1, 'shot'); assert.ok(n.shots[2].cam); assert.deepEqual(S.validate(n, clipDur), []);
  n = S.removeShot(sc, 0); assert.ok(S.isBase(n.shots[0]), '删掉第一个镜头后不能以倒放开头'); assert.deepEqual(S.validate(n, clipDur), []);
  assert.equal(sc.shots.length, n0);
  assert.deepEqual(JSON.parse(S.stringify(sc)), sc);
});
test('静物脚本：机械臂全程可达，放慢倍数合理', () => {
  const { plan } = load('product-arm');
  for (const t of plan.takes) assert.ok(t.ok, `${t.name}: ${t.issues.join('、')}`);
  assert.ok(plan.slow >= 1 && plan.slow < 20);
});
test('自由镜头脚本不解机械臂；硬让机械臂去拍会如实报够不着', () => {
  const { c, tl, plan } = load('duck-free'); assert.equal(plan, null);
  const forced = A.plan(tl, () => [0, 0, 0.12], { base: c.rig.base || S.DEF_RIG.base, mount: 'invert' });
  assert.ok(forced.takes.some(t => !t.ok && t.issues.length));
});

test('挪镜头：正放镜头带着它的倒放 / 重复一起挪；倒放只在自己那组里换位置；挪不动时原样返回', () => {
  const sc = readScript('duck-arm'), names = s => s.shots.map(x => x.name);
  // 第 0 组 = 踢腿 + 倒放 + 再踢 + 倒放（4 个），第 1 组 = 坐下 + 倒放
  const a = S.moveShot(sc, 0, 1);
  assert.equal(a.sel, 2); assert.deepEqual(names(a.script).slice(0, 6), [names(sc)[4], names(sc)[5], ...names(sc).slice(0, 4)]);
  assert.deepEqual(S.validate(a.script, clipDur), []);
  assert.equal(S.moveShot(sc, 0, -1).sel, 0); assert.deepEqual(S.moveShot(sc, 0, -1).script, sc);
  const b = S.moveShot(sc, 1, 1); assert.equal(b.sel, 2); assert.ok(b.script.shots[1].repeat && b.script.shots[2].reverse);
  assert.equal(S.moveShot(sc, 1, -1).sel, 1, '倒放不能挪到它的来源镜头前面');
  assert.equal(S.moveShot(sc, 3, 1).sel, 3, '倒放不能挪进下一组');
  const last = sc.shots.length - 1; assert.equal(S.moveShot(sc, last, 1).sel, last);
});
