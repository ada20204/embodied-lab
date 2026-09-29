// 运镜预演台计算核心的回归测试：node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const K = require('../previz/kin.js');

K.setProduct(0.6, -0.4);
const F = Math.round(K.facing());
const PRESETS = {
  orbit:  { mount: 'side',   type: 'orbit',  dur: 6, ease: 'smooth', p: { r: 0.28, h: 0.14, a0: F - 45, a1: F + 45 } },
  dolly:  { mount: 'invert', type: 'dolly',  dur: 5, ease: 'out',    p: { az: F, d0: 0.36, d1: 0.2, h: 0.03 } },
  reveal: { mount: 'invert', type: 'reveal', dur: 6, ease: 'smooth', p: { az0: F - 30, az1: F + 25, r: 0.3, h0: 0, h1: 0.16 } },
  top:    { mount: 'side',   type: 'top',    dur: 6, ease: 'smooth', p: { h: 0.3, s0: 0, s1: 90 } },
};
const run = (S, gimbal = false) => { K.setMount(S.mount); K.setGimbal(gimbal); const R = K.compile(S, 0.02, 70); K.setGimbal(false); return R; };

for (const [name, S] of Object.entries(PRESETS)) {
  test(`预设 ${name} 在云台锁定模式下全部通过`, () => {
    const R = run(S);
    assert.equal(R.errN, 0, JSON.stringify(R.count));
    assert.equal(R.warnN, 0, JSON.stringify(R.count));
    assert.ok(R.minClr > 0.03, `最小间隙 ${R.minClr}`);
  });
}

test('所有速度曲线从静止起步、回到静止', () => {
  for (const e of ['smooth', 'linear', 'out', 'in']) {
    const R = run({ ...PRESETS.orbit, ease: e });
    assert.equal(R.count.shock, 0, `速度曲线 ${e} 有起停冲击`);
  }
});

test('低机位推近正挂会撞台面，倒挂不会', () => {
  assert.ok(run({ ...PRESETS.dolly, mount: 'side' }).count.collide > 0);
  assert.equal(run(PRESETS.dolly).count.collide, 0);
});

test('云台分担显著减少手腕行程', () => {
  const locked = run(PRESETS.orbit);
  K.setMount('side');
  const plan = K.planGimbal(PRESETS.orbit, 70);
  const shared = run({ ...PRESETS.orbit, gim: plan.gim }, true);
  assert.equal(shared.errN + shared.warnN, 0);
  assert.ok(shared.wristTravel < locked.wristTravel * 0.3, `${shared.wristTravel} vs ${locked.wristTravel}`);
});

test('自动修正能把一条近奇异的环绕修成可执行', () => {
  const S = { mount: 'side', type: 'orbit', dur: 10, ease: 'linear', p: { r: 0.28, h: 0.06, a0: 70, a1: 220 } };
  const before = run(S);
  assert.ok(before.errN + before.warnN > 0);
  K.setMount(S.mount);
  const fix = K.repair(S, 70);
  const after = run({ ...S, mount: fix.mount, p: fix.p, dur: fix.dur });
  assert.equal(after.errN + after.warnN, 0, JSON.stringify(after.count));
  assert.ok(after.minSin >= K.SING_MIN);
});
