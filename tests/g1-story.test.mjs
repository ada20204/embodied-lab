// 讲解员姿态与 G1 资源的检查：node --test tests/g1-story.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, statSync, existsSync } from 'node:fs';
const require = createRequire(import.meta.url);
const P = require('../story/g1-poses.js');
const GL = require('../story/gl.js');
const spec = JSON.parse(readFileSync(new URL('../assets/g1/g1.json', import.meta.url)));

// ---- 关节表与正运动学（MuJoCo 约定：四元数 wxyz，Z 向上） ----
const limits = {}, byName = {};
(function col(n) { if (n.joint) limits[n.joint.name] = n.joint.range; byName[n.name] = n; n.children.forEach(col); })(spec.tree);
const mm = (a, b) => { const o = Array(9).fill(0); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j]; return o; };
const mv = (m, v) => [0, 1, 2].map(i => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);
const qm = ([w, x, y, z]) => [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
const rot = (a, t) => { const l = Math.hypot(...a), [x, y, z] = a.map(v => v / l), c = Math.cos(t), s = Math.sin(t), C = 1 - c; return [c + x * x * C, x * y * C - z * s, x * z * C + y * s, y * x * C + z * s, c + y * y * C, y * z * C - x * s, z * x * C - y * s, z * y * C + x * s, c + z * z * C]; };
function fk(pose) {
  const out = {};
  (function w(n, R, t) {
    let R2 = mm(R, qm(n.quat)); const t2 = t.map((v, i) => v + mv(R, n.pos)[i]);
    if (n.joint) R2 = mm(R2, rot(n.joint.axis, pose[n.joint.name] || 0));
    out[n.name] = { t: t2, R: R2 }; n.children.forEach(c => w(c, R2, t2));
  })(spec.tree, [1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]);
  return out;
}
const hand = (F, side) => { const w = F[`${side}_wrist_yaw_link`]; const d = mv(w.R, [0.1, 0, 0]); return w.t.map((v, i) => v + d[i]); };
const inTorso = p => p[0] > -0.10 && p[0] < 0.11 && Math.abs(p[1]) < 0.16 && p[2] > 0.80 && p[2] < 1.30;

test('每个手势的每个关节都在限位内，且关节名存在', () => {
  for (const [name, pose] of P.allPoses()) for (const [j, v] of Object.entries(pose)) {
    assert.ok(limits[j], `${name}: 找不到关节 ${j}`);
    assert.ok(v >= limits[j][0] && v <= limits[j][1], `${name}: ${j}=${v} 超出 [${limits[j]}]`);
  }
});

test('左右臂镜像：待机与展示的左右关节互为镜像', () => {
  for (const id of ['idle', 'present', 'clap']) {
    const p = P.poseFor(id, 0);
    P.ARM.forEach((n, i) => assert.ok(Math.abs(p[`left_${n}_joint`] - P.MIRROR[i] * p[`right_${n}_joint`]) < 1e-9, `${id} ${n}`));
  }
});

test('动作编号都在参考项目的白名单里，没有对应项的手势不写编号', () => {
  const allow = new Set([99, 11, 13, 12, 15, 17, 18, 19, 22, 23, 24, 25, 26, 27]);
  for (const [id, g] of Object.entries(P.GESTURES)) if (g.action) assert.ok(allow.has(g.action.id), `${id} 的动作编号 ${g.action.id} 不在白名单`);
  assert.equal(P.GESTURES.point.action, null); assert.equal(P.GESTURES.present.action, null);
});

test('所有手势的肘和腕不穿进躯干', () => {
  for (const [name, pose] of P.allPoses()) {
    const F = fk(pose);
    for (const side of ['left', 'right']) for (const b of [`${side}_elbow_link`, `${side}_wrist_roll_link`]) assert.ok(!inTorso(F[b].t), `${name}: ${b} 在躯干内 ${F[b].t.map(v => v.toFixed(2))}`);
  }
});

test('手势的几何意图：挥手举过肩、鼓掌合拢时双手靠近、指向时手臂伸向侧方', () => {
  const sh = fk(P.poseFor('idle', 0)).right_shoulder_pitch_link.t[2];
  assert.ok(hand(fk(P.poseFor('wave', 0)), 'right')[2] > sh + 0.2, '挥手应高过肩');
  const closed = fk(P.poseFor('clap', 0.5 / P.GESTURES.clap.f)), open = fk(P.poseFor('clap', 0));
  const gap = F => Math.abs(hand(F, 'left')[1] - hand(F, 'right')[1]);
  assert.ok(gap(closed) < 0.10, `合拢时双手间距 ${gap(closed)}`); assert.ok(gap(open) > gap(closed) + 0.08, '张开应比合拢宽');
  const pt = hand(fk(P.poseFor('point', 0)), 'right'); assert.ok(pt[1] < -0.35, `指向应伸向右侧 ${pt}`);
});

test('平滑逼近会收敛到目标且不越过', () => {
  const cur = { a: 0 }; for (let i = 0; i < 300; i++) P.approach(cur, { a: 1 }, 0.016, 6);
  assert.ok(cur.a > 0.999 && cur.a <= 1);
});

test('g1.glb 可解析，体积合理，网格数与关节树一致', () => {
  const p = '../assets/g1/g1.glb', size = statSync(new URL(p, import.meta.url)).size;
  assert.ok(size < 4e6, `g1.glb ${size} 字节`);
  const b = readFileSync(new URL(p, import.meta.url)); const g = GL.parseGLB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  assert.equal(g.meshes.length, spec.meshes.length);
  const names = new Set(g.meshes.map(m => m.name)); spec.meshes.forEach(n => assert.ok(names.has(n), `缺网格 ${n}`));
  for (const m of g.meshes) for (const q of m.prims) { assert.ok(q.pos.every(Number.isFinite)); assert.ok(Math.max(...q.idx) < q.pos.length / 3); }
  assert.equal(Object.keys(limits).length, 29);
});

test('Nova 资源（若存在）可解析，关节表引用的节点都在', { skip: !existsSync(new URL('../assets/nova/nova5.glb', import.meta.url)) }, () => {
  const b = readFileSync(new URL('../assets/nova/nova5.glb', import.meta.url)); const g = GL.parseGLB(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const names = new Set(g.json.nodes.map(n => n.name)); const js = JSON.parse(readFileSync(new URL('../assets/nova/nova5_joints.json', import.meta.url)));
  js.joints.forEach(j => assert.ok(names.has(j.name), `缺节点 ${j.name}`));
});
