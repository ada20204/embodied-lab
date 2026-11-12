import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const R = createRequire(import.meta.url)('../reel/reel.js');
const tl = R.build(R.SHOTS, 100);
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

test('每段都落在整拍上，首尾相接', () => {
  let t = 0;
  for (const g of tl.segs) { assert.ok(near(g.t0, t)); assert.ok(near((g.t1 - g.t0) / tl.beat, Math.round((g.t1 - g.t0) / tl.beat))); t = g.t1; }
  assert.ok(near(tl.dur, t));
});
test('先快后慢：段首速率最大（k 倍平均），段尾为 0，进度单调', () => {
  for (const g of tl.segs) {
    const d = g.t1 - g.t0, avg = Math.abs(g.s1 - g.s0) / d;
    const a = R.evalAt(tl, g.t0 + 1e-9), rate0 = Math.abs(a.rate);
    assert.ok(near(rate0, g.k * avg, 1e-3), `${g.name} 段首 ${rate0} vs ${g.k * avg}`);
    assert.ok(Math.abs(R.evalAt(tl, g.t1 - 1e-7).rate) < 1e-3 * avg + 1e-6);
    let last = g.rev ? 2 : -1;
    for (let j = 0; j <= 20; j++) { const p = R.evalAt(tl, g.t0 + d * (j + 0.01) / 21).p; assert.ok(g.rev ? p <= last : p >= last); last = p; }
  }
});
test('倒放：从上一段停住的地方原路返回，机位和素材时间都连续，速率为负', () => {
  tl.segs.forEach((g, i) => {
    if (!g.rev) return;
    const a = R.evalAt(tl, g.t0 - 1e-7, { cam: {} }), b = R.evalAt(tl, g.t0 + 1e-7, { cam: {} });
    assert.equal(a.clip, b.clip);
    assert.ok(near(a.s, b.s, 1e-3)); for (const k of ['az', 'el', 'dist', 'fov', 'roll']) assert.ok(near(a.cam[k], b.cam[k], 1e-3), k);
    assert.ok(R.evalAt(tl, g.t0 + 0.01).rate < 0);
    assert.ok(near(R.evalAt(tl, g.t1 - 1e-7).s, g.s0, 1e-3), '倒放到头回到素材起点');
  });
});
test('镜头表引用的素材都存在，起止秒在片段时长内', () => {
  for (const g of tl.segs) {
    const d = JSON.parse(fs.readFileSync(new URL(`../assets/duck/motions/${g.clip}.json`, import.meta.url)));
    const dur = (d.frames.length - 1) / d.fps;
    assert.ok(g.s0 >= 0 && g.s1 <= dur && g.s1 > g.s0, `${g.clip} ${g.s0}–${g.s1} / ${dur}`);
  }
});
test('节拍表：换镜头的拍都是强拍；改 BPM 只改时长不改结构', () => {
  const b = R.beats(tl); assert.ok(b.filter(x => x.cut).every(x => x.strong));
  const t2 = R.build(R.SHOTS, 50); assert.ok(near(t2.dur, tl.dur * 2)); assert.equal(t2.segs.length, tl.segs.length);
  assert.throws(() => R.build([{ rev: true }], 100));
});
