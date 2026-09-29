import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const M = createRequire(import.meta.url)('../story/motion.js');
const spec = JSON.parse(fs.readFileSync(new URL('../assets/g1/g1.json', import.meta.url)));

const jointsOf = [];
(function walk(n) { if (n.joint) jointsOf.push(n.joint); n.children.forEach(walk); })(spec.tree);

const row = (x, z, ang) => [x, 0, z, 0, 0, 0, 1, ...Array(29).fill(ang)].join(',');

test('关节顺序与 g1.json 一致，共 29 个', () => {
  assert.equal(M.JOINTS.length, 29);
  assert.deepEqual(new Set(M.JOINTS), new Set(jointsOf.map(j => j.name)));
});
test('解析：列数、帧数、数值', () => {
  const c = M.parseCsv([row(0, 0.79, 0.1), row(1, 0.8, 0.3), ''].join('\n'));
  assert.equal(c.n, 2); assert.equal(c.fps, 30);
  assert.ok(Math.abs(c.root[7] - 1) < 1e-6 && Math.abs(c.q[29] - 0.3) < 1e-6);
});
test('解析：列数不对或不是数字要报错并指出行号', () => {
  assert.throws(() => M.parseCsv('1,2,3'), /第 1 行有 3 列/);
  assert.throws(() => M.parseCsv(row(0, 0.8, 0) + '\n' + row(0, 0.8, 0).replace('0.79', 'x').replace(/^0,0,0.8/, 'a,0,0.8')), /不是数字/);
  assert.throws(() => M.parseCsv('  \n'), /空/);
});
test('采样：帧间线性插值，越界取端点', () => {
  const c = M.parseCsv([row(0, 0.8, 0), row(3, 0.8, 0.6)].join('\n')), o = M.makeOut();
  M.sample(c, 1 / 60, o); assert.ok(Math.abs(o.pos[0] - 1.5) < 1e-6 && Math.abs(o.q[0] - 0.3) < 1e-6);
  M.sample(c, 99, o); assert.ok(Math.abs(o.pos[0] - 3) < 1e-6);
  M.sample(c, -5, o); assert.equal(o.pos[0], 0);
  assert.ok(Math.abs(M.duration(c) - 1 / 30) < 1e-9);
});
test('采样：四元数走最短路径并保持单位长度', () => {
  const a = [0, 0, 0, 0, 0, 0, 1, ...Array(29).fill(0)].join(','), b = [0, 0, 0, 0, 0, 0, -1, ...Array(29).fill(0)].join(',');
  const c = M.parseCsv(a + '\n' + b), o = M.makeOut(); M.sample(c, 1 / 60, o);
  assert.ok(Math.abs(Math.hypot(...o.quat) - 1) < 1e-6);
  assert.ok(Math.abs(o.quat[3]) > 0.99, '不应插值到零附近的四元数');
});
test('片段目录：id 唯一', () => { assert.equal(new Set(M.CLIPS.map(c => c.id)).size, M.CLIPS.length); });

// 有本地数据时，用真实片段检查数据和模型对得上（CI 上没有数据就跳过）
const dir = process.env.LAFAN_G1_DIR;
for (const clip of M.CLIPS) {
  const file = dir ? `${dir}/${clip.id}.csv` : null;
  test(`真实片段 ${clip.id}：四元数归一、根高度、关节角在限位内`, { skip: !(file && fs.existsSync(file)) }, () => {
    const c = M.parseCsv(fs.readFileSync(file, 'utf8'));
    assert.ok(c.n > 1000);
    const low = 0.02;   // 只做合理性检查：舞蹈、格斗、摔倒里都有蹲地和倒地的动作
    let bad = 0, maxOver = 0;
    for (let i = 0; i < c.n; i += 7) {
      assert.ok(Math.abs(Math.hypot(c.root[i * 7 + 3], c.root[i * 7 + 4], c.root[i * 7 + 5], c.root[i * 7 + 6]) - 1) < 1e-3);
      assert.ok(c.root[i * 7 + 2] > low && c.root[i * 7 + 2] < 1.3, `高度 ${c.root[i * 7 + 2]}`);
      M.JOINTS.forEach((n, k) => { const j = jointsOf.find(x => x.name === n), v = c.q[i * 29 + k]; const over = Math.max(j.range[0] - v, v - j.range[1], 0); if (over > 0) { bad++; maxOver = Math.max(maxOver, over); } });
    }
    assert.ok(maxOver < 0.35, `最大越限 ${maxOver.toFixed(3)} rad（${bad} 个采样点）`);
  });
}
