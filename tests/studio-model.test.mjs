// 导入模型：摆正（Y 向上 → Z 向上、长边沿 x、落地）、按实际长度缩放、抽稀、不支持的压缩格式
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Stage3D = require('../story/gl.js'), SM = require('../studio/model.js'), SS = require('../studio/script.js');

/** 拼一个最小的 glb：一组三角形，挂在带缩放 / 平移的节点下 */
function glb(pos, idx, node, extra = {}) {
  const P = Float32Array.from(pos), I = Uint32Array.from(idx), bin = new Uint8Array(P.byteLength + I.byteLength);
  bin.set(new Uint8Array(P.buffer), 0); bin.set(new Uint8Array(I.buffer), P.byteLength);
  const lo = [0, 1, 2].map(k => Math.min(...pos.filter((_, i) => i % 3 === k))), hi = [0, 1, 2].map(k => Math.max(...pos.filter((_, i) => i % 3 === k)));
  const json = Object.assign({ asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [Object.assign({ mesh: 0 }, node)],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: P.length / 3, type: 'VEC3', min: lo, max: hi }, { bufferView: 1, componentType: 5125, count: I.length, type: 'SCALAR' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: P.byteLength }, { buffer: 0, byteOffset: P.byteLength, byteLength: I.byteLength }],
    buffers: [{ byteLength: bin.length }] }, extra);
  let js = new TextEncoder().encode(JSON.stringify(json)); const pad = (4 - js.length % 4) % 4; js = Uint8Array.from([...js, ...new Array(pad).fill(32)]);
  const total = 12 + 8 + js.length + 8 + bin.length, b = new ArrayBuffer(total), dv = new DataView(b), u = new Uint8Array(b);
  dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, js.length, true); dv.setUint32(16, 0x4E4F534A, true); u.set(js, 20);
  dv.setUint32(20 + js.length, bin.length, true); dv.setUint32(24 + js.length, 0x004E4942, true); u.set(bin, 28 + js.length);
  return b;
}
// 一个长方体：x 方向 2、y 方向（glTF 的“上”）1、z 方向 4（单位：毫米 ×100），所以最长的水平边是 glTF 的 z
function box(sx, sy, sz) {
  const pos = [], idx = [];
  for (let i = 0; i < 8; i++) pos.push((i & 1 ? 1 : -1) * sx / 2, (i & 2 ? 1 : 0) * sy, (i & 4 ? 1 : -1) * sz / 2);
  [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]].forEach(([a, b, c, d]) => idx.push(a, b, c, a, c, d));
  return { pos, idx };
}

test('Y 向上的模型被立起来，长边转到 x，落地，按实际长度缩放', () => {
  const { pos, idx } = box(200, 100, 400);
  const parsed = Stage3D.parseGLB(glb(pos, idx, { translation: [1000, 500, -300], scale: [1, 1, 1] }));
  const N = SM.normalize(parsed, 'y', 0.46);
  assert.deepEqual(N.raw.map(v => +v.toFixed(3)), [400, 200, 100]);   // 长 = glTF 的 z，宽 = x，高 = glTF 的 y
  assert.deepEqual(N.dims.map(v => +v.toFixed(4)), [0.46, 0.23, 0.115]);
  // 把所有顶点变换过去：落地（最低 z = 0）、水平居中、长边在 x
  const M = N.M, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity], tr = parsed.json.nodes[0].translation;
  for (let i = 0; i < pos.length; i += 3) {
    const p = [pos[i] + tr[0], pos[i + 1] + tr[1], pos[i + 2] + tr[2]];
    for (let k = 0; k < 3; k++) { const v = M[k] * p[0] + M[4 + k] * p[1] + M[8 + k] * p[2] + M[12 + k]; lo[k] = Math.min(lo[k], v); hi[k] = Math.max(hi[k], v); }
  }
  assert.ok(Math.abs(lo[2]) < 1e-6 && Math.abs(hi[2] - 0.115) < 1e-6, '落地且高度对');
  assert.ok(Math.abs(lo[0] + 0.23) < 1e-6 && Math.abs(hi[0] - 0.23) < 1e-6, '长边沿 x 且居中');
  assert.ok(Math.abs(lo[1] + 0.115) < 1e-6 && Math.abs(hi[1] - 0.115) < 1e-6, '宽边沿 y 且居中');
});

test('选“Z 向上”时不再立起来', () => {
  const { pos, idx } = box(400, 200, 100);
  const N = SM.normalize(Stage3D.parseGLB(glb(pos, idx, {})), 'z', 0.4);
  assert.deepEqual(N.dims.map(v => +v.toFixed(3)), [0.4, 0.2, 0.1]);
});

test('面数超过上限时抽稀，留下的三角形都有效', () => {
  const pos = [], idx = [], n = 120;   // 一张 120×120 的细网格，约 2.9 万面
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i / n, 0, j / n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const a = j * (n + 1) + i; idx.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1); }
  const parsed = Stage3D.parseGLB(glb(pos, idx, {}));
  const d = SM.decimate(parsed, 5000);
  assert.equal(d.before, n * n * 2);
  assert.ok(d.after <= 5000 && d.after > 500, `抽稀到 ${d.after}`);
  const p = parsed.meshes[0].prims[0], nv = p.pos.length / 3;
  for (let i = 0; i < p.idx.length; i += 3) { const [a, b, c] = p.idx.slice(i, i + 3); assert.ok(a < nv && b < nv && c < nv && a !== b && b !== c && a !== c); }
  assert.equal(SM.decimate(parsed, 1e6).after, d.after, '没超上限就不动');
});

test('Draco / meshopt 压缩的模型给出说明', () => {
  assert.match(SM.unsupported({ extensionsRequired: ['KHR_draco_mesh_compression'] }), /Draco/);
  assert.equal(SM.unsupported({ extensionsRequired: ['KHR_mesh_quantization'] }), null);
});

test('脚本里的导入主体：按尺寸算碰撞包络，缺字段报错', () => {
  const sc = { bpm: 96, attack: 0.15, subject: { type: 'custom', name: 'w11.glb', hash: 'sha256-x', dims: [0.46, 0.17, 0.08] }, shots: [{ cam: { az: [0, 10], el: [5, 5], dist: [0.5, 0.5] }, beats: 2 }] };
  const c = SS.compile(sc, {});
  assert.ok(Math.abs(c.subject.radius - 0.085) < 1e-9 && Math.abs(c.subject.half - 0.145) < 1e-9 && Math.abs(c.subject.lookUp - 0.04) < 1e-9);
  assert.equal(c.subject.up, 'y');
  assert.ok(SS.validate(Object.assign({}, sc, { subject: { type: 'custom', dims: [0.46, 0.17, 0.08] } })).length > 0);
  assert.ok(SS.validate(Object.assign({}, sc, { subject: Object.assign({}, sc.subject, { dims: [3, 0.1, 0.1] }) })).length > 0);
});
