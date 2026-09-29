import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const spec = JSON.parse(fs.readFileSync(new URL('../assets/duck/duck.json', import.meta.url)));
const glb = fs.readFileSync(new URL('../assets/duck/duck.glb', import.meta.url));
const joints = [];
const walk = n => { if (n.joint) joints.push(n.joint); n.children.forEach(walk); };
walk(spec.tree);
const geomMeshes = new Set();
const walkG = n => { n.geoms.forEach(g => geomMeshes.add(g.mesh)); n.children.forEach(walkG); };
walkG(spec.tree);

test('glb 头部与 JSON 块有效', () => {
  assert.equal(glb.readUInt32LE(0), 0x46546c67);
  assert.equal(glb.readUInt32LE(4), 2);
  assert.equal(glb.readUInt32LE(8), glb.length);
  const len = glb.readUInt32LE(12);
  const j = JSON.parse(glb.subarray(20, 20 + len).toString());
  assert.equal(j.meshes.length, spec.meshes.length);
  assert.ok(glb.length < 3e6, 'glb 应保持在 3 MB 以内');
});
test('14 个关节，左右成对，限位在合理范围', () => {
  assert.equal(joints.length, 14);
  const names = joints.map(j => j.name);
  ['hip_yaw', 'hip_roll', 'hip_pitch', 'knee', 'ankle'].forEach(k => ['left_', 'right_'].forEach(s => assert.ok(names.includes(s + k), s + k)));
  ['neck_pitch', 'head_pitch', 'head_yaw', 'head_roll'].forEach(k => assert.ok(names.includes(k), k));
  joints.forEach(j => { assert.ok(j.range && j.range[0] < j.range[1]); assert.ok(Math.abs(j.range[0]) <= 3.2 && Math.abs(j.range[1]) <= 3.2); assert.equal(j.axis.length, 3); });
});
test('每个几何引用的网格都在 glb 里', () => {
  const inList = new Set(spec.meshes);
  geomMeshes.forEach(m => assert.ok(inList.has(m), m));
  assert.equal(spec.tree.name, 'trunk_base');
});
test('来源与许可文件在位', () => {
  assert.match(fs.readFileSync(new URL('../assets/duck/LICENSE', import.meta.url), 'utf8'), /Apache License/);
  assert.match(fs.readFileSync(new URL('../assets/duck/NOTICE.md', import.meta.url), 'utf8'), /Pollen Robotics/);
  assert.match(spec.source, /Apache-2\.0/);
});
