import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const M = createRequire(import.meta.url)('../story/motion.js');
const dir = new URL('../assets/duck/motions/', import.meta.url);
const spec = JSON.parse(fs.readFileSync(new URL('../assets/duck/duck.json', import.meta.url)));
const names = [];
(function walk(n) { if (n.joint) names.push(n.joint.name); n.children.forEach(walk); })(spec.tree);

test('目录里的每个片段都能解析，关节名都在 duck.json 里，数值有限', () => {
  for (const c of M.DUCK_CLIPS) {
    const clip = M.fromJson(JSON.parse(fs.readFileSync(new URL(c.id + '.json', dir))));
    assert.equal(clip.fps, 50); assert.equal(clip.nj, 14); assert.ok(clip.n > 100, c.id);
    for (const j of clip.joints) assert.ok(names.includes(j), j);
    for (const v of clip.q) assert.ok(Number.isFinite(v));
    const z = Array.from({ length: clip.n }, (_, i) => clip.root[i * 7 + 2]);
    assert.ok(Math.min(...z) > 0.02 && Math.max(...z) < 0.3, c.id + ' 高度');
  }
});
test('目录里没有多余或缺失的文件', () => {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
  assert.deepEqual(files, M.DUCK_CLIPS.map(c => c.id).sort());
});
test('fromJson 拒绝长度不对的数据；采样用 14 个关节', () => {
  assert.throws(() => M.fromJson({ fps: 50, joints: ['a'], frames: [[1, 2, 3], [1, 2, 3]] }), /应有 8 个数/);
  const d = { fps: 50, joints: ['a', 'b'], frames: [[0, 0, 0.1, 0, 0, 0, 1, 0, 1], [1, 0, 0.1, 0, 0, 0, 1, 1, 0]] };
  const c = M.fromJson(d), o = M.makeOut(); M.sample(c, 0.01, o);
  assert.ok(Math.abs(o.q[0] - 0.5) < 1e-6 && Math.abs(o.q[1] - 0.5) < 1e-6);
  assert.deepEqual(M.toPose(o.q, {}, c.joints), { a: o.q[0], b: o.q[1] });
});
