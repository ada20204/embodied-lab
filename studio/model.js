/* 导入的 glb 模型：摆正、量尺寸、抽稀。纯函数，浏览器和 node 都能用。
 *
 * 网上下载的模型单位和朝向五花八门。这里把它变成 Studio 的约定：
 *   Z 向上、米为单位、原点在底面中心（模型“落地”）、最长的水平方向沿 x（车头 / 车尾朝 ±x）。
 * 只问用户一个问题：这个东西实际多长（米）。其余都从包围盒算。
 *
 * 碰撞包络在 script.js 里按尺寸算（脚本里记了尺寸，模型不在内存里也能规划）。 */
(function (root) {
  'use strict';

  // 列主序 4×4
  const mul = (a, b) => { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; };
  const id = () => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  function fromTRS(n) {
    if (n.matrix) return Float64Array.from(n.matrix);
    const [x, y, z, w] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1], t = n.translation || [0, 0, 0];
    return Float64Array.from([
      (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
      (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
      (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
      t[0], t[1], t[2], 1]);
  }
  /** 场景里每个挂了网格的节点 → { mesh 序号, 世界矩阵 }（glTF 原坐标） */
  function meshInstances(json) {
    const out = [], sc = (json.scenes || [])[json.scene || 0], roots = sc ? sc.nodes : (json.nodes || []).map((_, i) => i);
    const walk = (i, P) => { const n = json.nodes[i], M = mul(P, fromTRS(n)); if (n.mesh !== undefined) out.push({ mesh: n.mesh, M }); (n.children || []).forEach(c => walk(c, M)); };
    roots.forEach(i => walk(i, id()));
    return out;
  }
  const UNSUPPORTED = { KHR_draco_mesh_compression: 'Draco 压缩', EXT_meshopt_compression: 'meshopt 压缩', KHR_texture_basisu: 'Basis 贴图' };
  /** glb 里有渲染器读不了的必需扩展就返回说明，否则返回 null */
  function unsupported(json) {
    const bad = (json.extensionsRequired || []).filter(e => UNSUPPORTED[e]);
    return bad.length ? `这个模型用了${bad.map(e => UNSUPPORTED[e]).join('、')}，页面还读不了。请在 Blender 里重新导出 glb（导出时关掉压缩）。` : null;
  }
  function countTris(parsed) { let n = 0; for (const m of parsed.meshes) for (const p of m.prims) n += p.idx.length / 3; return n; }

  /** 摆正矩阵：up = 'y'（glTF 规范）或 'z'（有些导出工具写错了）；length = 实际长度（米）。
   *  返回 { M: 列主序 Float32Array（模型原坐标 → Studio 坐标），dims: [长, 宽, 高]（米），raw: 摆正后、缩放前的尺寸 } */
  function normalize(parsed, up, length) {
    const R = up === 'z' ? id() : Float64Array.from([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);   // 绕 x 转 +90°：(x, y, z) → (x, −z, y)
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const { mesh, M } of meshInstances(parsed.json)) {
      const T = mul(R, M);
      for (const p of parsed.meshes[mesh].prims) {
        const P = p.pos;
        for (let i = 0; i < P.length; i += 3) {
          const x = P[i], y = P[i + 1], z = P[i + 2];
          for (let k = 0; k < 3; k++) { const v = T[k] * x + T[4 + k] * y + T[8 + k] * z + T[12 + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
        }
      }
    }
    if (!(hi[0] >= lo[0])) throw new Error('模型里没有可以显示的网格');
    let ex = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]];
    let Rz = id();
    if (ex[1] > ex[0] * 1.02) { Rz = Float64Array.from([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); c = [-c[1], c[0], c[2]]; ex = [ex[1], ex[0], ex[2]]; }   // 绕 z 转 90°，让长边沿 x
    const k = length > 0 ? length / ex[0] : 1;
    const S = Float64Array.from([k, 0, 0, 0, 0, k, 0, 0, 0, 0, k, 0, -c[0] * k, -c[1] * k, -c[2] * k, 1]);
    return { M: Float32Array.from(mul(S, mul(Rz, R))), dims: ex.map(v => v * k), raw: ex };
  }

  /** 顶点聚类抽稀（就地改 parsed.meshes）：面数超过 maxTris 时，把落在同一个小格子里的顶点并成一个。
   *  不追求保形最优，只为让几十万上百万面的模型在浏览器里流畅；返回 { before, after, cell }（cell 是相对每个网格包围盒对角线的比例） */
  function decimate(parsed, maxTris) {
    const before = countTris(parsed);
    if (before <= maxTris) return { before, after: before, cell: 0 };
    let q = 600, after = before, out = null;
    for (let iter = 0; iter < 12 && after > maxTris; iter++, q = Math.round(q / 1.35)) {
      out = parsed.meshes.map(m => m.prims.map(p => cluster(p, q)));
      after = 0; for (const ps of out) for (const p of ps) after += p.idx.length / 3;
    }
    parsed.meshes.forEach((m, i) => { m.prims = out[i]; });
    return { before, after, cell: 1 / q };
  }
  function cluster(p, q) {
    const P = p.pos, nV = P.length / 3, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { if (P[i + k] < lo[k]) lo[k] = P[i + k]; if (P[i + k] > hi[k]) hi[k] = P[i + k]; }
    const cell = Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / q, 1e-9);
    const key = new Map(), remap = new Int32Array(nV), sum = [], nsum = [], cnt = [];
    for (let v = 0; v < nV; v++) {
      const a = Math.floor((P[v * 3] - lo[0]) / cell), b = Math.floor((P[v * 3 + 1] - lo[1]) / cell), c = Math.floor((P[v * 3 + 2] - lo[2]) / cell);
      // 法线朝向差太多的顶点不合并（保住锐边两侧），按法线大致方向再分一层
      const N = p.nrm, oct = N ? (N[v * 3] > 0 ? 1 : 0) | (N[v * 3 + 1] > 0 ? 2 : 0) | (N[v * 3 + 2] > 0 ? 4 : 0) : 0;
      const k = a + ',' + b + ',' + c + ',' + oct;
      let j = key.get(k);
      if (j === undefined) { j = cnt.length; key.set(k, j); sum.push(0, 0, 0); nsum.push(0, 0, 0); cnt.push(0); }
      remap[v] = j; cnt[j]++;
      for (let t = 0; t < 3; t++) { sum[j * 3 + t] += P[v * 3 + t]; if (N) nsum[j * 3 + t] += N[v * 3 + t]; }
    }
    const pos = new Float32Array(cnt.length * 3), nrm = new Float32Array(cnt.length * 3);
    for (let j = 0; j < cnt.length; j++) {
      const l = Math.hypot(nsum[j * 3], nsum[j * 3 + 1], nsum[j * 3 + 2]) || 1;
      for (let t = 0; t < 3; t++) { pos[j * 3 + t] = sum[j * 3 + t] / cnt[j]; nrm[j * 3 + t] = nsum[j * 3 + t] / l; }
    }
    const idx = [], I = p.idx;
    for (let i = 0; i < I.length; i += 3) { const a = remap[I[i]], b = remap[I[i + 1]], c = remap[I[i + 2]]; if (a !== b && b !== c && a !== c) idx.push(a, b, c); }
    return { pos, nrm, idx: Uint32Array.from(idx), color: p.color };
  }

  /** 文件指纹（脚本里只记它和文件名，不记模型本身） */
  async function fingerprint(buf) {
    try { if (root.crypto && root.crypto.subtle) { const h = new Uint8Array(await root.crypto.subtle.digest('SHA-256', buf)); return 'sha256-' + Array.from(h.slice(0, 12), b => b.toString(16).padStart(2, '0')).join(''); } } catch (e) { /* 不安全的上下文里没有 subtle，退回下面的 */ }
    const u = new Uint8Array(buf); let h = 0x811c9dc5; for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 0x01000193) >>> 0; }
    return 'fnv-' + h.toString(16) + '-' + u.length;
  }

  const api = { meshInstances, unsupported, countTris, normalize, decimate, fingerprint };
  root.StudioModel = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
