import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const L = createRequire(import.meta.url)('../story/g1-led.js');

test('红/蓝对应 LedControl 参数', () => {
  assert.equal(L.call(L.STATES.listen.rgb), 'LedControl(255, 0, 0)');
  assert.equal(L.call(L.STATES.reply.rgb), 'LedControl(0, 0, 255)');
});
test('闪烁约 1 Hz：0.5 s 一次亮灭', () => {
  assert.equal(L.levelAt('blink', 0.1), 1);
  assert.equal(L.levelAt('blink', 0.6), 0);
  assert.equal(L.levelAt('blink', 1.1), 1);
  assert.equal(L.levelAt('solid', 0.6), 1);
});
test('演示序列只用 关/红/蓝，且首尾合理', () => {
  const ok = new Set(['off', 'listen', 'reply']);
  L.DEMO.forEach(d => assert.ok(ok.has(d.state)));
  assert.equal(L.DEMO[0].state, 'off');
  assert.equal(L.DEMO.at(-1).state, 'reply');
});
test('stepAt 与总时长', () => {
  assert.equal(L.stepAt(0), 0);
  assert.equal(L.stepAt(1.7), 1);
  assert.equal(L.stepAt(L.demoLength() + 0.1), -1);
  assert.ok(Math.abs(L.demoLength() - 14.0) < 1e-9);
});
test('clamp255', () => {
  assert.equal(L.clamp255(300), 255);
  assert.equal(L.clamp255(-5), 0);
  assert.equal(L.clamp255('abc'), 0);
});
