import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 精简版（*_lo.glb）是首屏用的：必须和精细版有同样的网格名（同一份关节 json 两个版本都能用），
// 面数和体积要明显更小，并且带法线（明暗和精细版一致）。
function glbJson(path) {
  const b = fs.readFileSync(new URL(path, import.meta.url));
  assert.equal(b.readUInt32LE(0), 0x46546C67, path + ' 不是 glb');
  const jl = b.readUInt32LE(12);
  return { g: JSON.parse(b.subarray(20, 20 + jl).toString('utf8')), size: b.length };
}
const tris = g => g.meshes.reduce((s, m) => s + m.primitives.reduce((t, p) => t + g.accessors[p.indices].count / 3, 0), 0);

for (const [hi, lo] of [['../assets/g1/g1.glb', '../assets/g1/g1_lo.glb'], ['../assets/duck/duck.glb', '../assets/duck/duck_lo.glb']]) {
  test(`精简版 ${lo}：网格名一致、面数与体积更小、带法线`, () => {
    const H = glbJson(hi), L = glbJson(lo);
    assert.deepEqual(L.g.meshes.map(m => m.name), H.g.meshes.map(m => m.name));
    assert.deepEqual(L.g.nodes.map(n => n.name), H.g.nodes.map(n => n.name));
    assert.ok(tris(L.g) < tris(H.g) * 0.3, `面数 ${tris(L.g)} / ${tris(H.g)}`);
    assert.ok(L.size < H.size * 0.25, `体积 ${L.size} / ${H.size}`);
    for (const m of L.g.meshes) for (const p of m.primitives) assert.ok('NORMAL' in p.attributes, m.name + ' 缺法线');
  });
}
