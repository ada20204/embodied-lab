/* 让 Nova 5 “拿着”运镜里的那台摄影机：把镜头轨迹解成六个关节的轨迹，并算出真机要放慢几倍才拍得下来。
 * 纯函数，依赖 previz/kin.js（KIN）和 reel.js（Reel）。浏览器和 node 都能用。
 *
 * 做法：每个镜头（不含倒放段）的机位只跟进度 p 有关，所以先沿 p 均匀取点，逐点做逆运动学，得到 Q(p)；
 * 任意时刻的关节角 = Q(p(t))，关节速度 = dQ/dp × dp/dt。倒放段和“再来一次”直接复用同一张表。
 * 真机拍摄时整条轨迹线性放慢 N 倍：速度变成 1/N，加速度变成 1/N²；成片再线性加速 N 倍。 */
(function (root) {
  'use strict';
  const KIN = root.KIN || (typeof require !== 'undefined' ? require('../previz/kin.js') : null);
  const Reel = root.Reel || (typeof require !== 'undefined' ? require('./reel.js') : null);
  const D2R = Math.PI / 180, M = 96;                     // 每个镜头沿进度取 M+1 个点
  const DEF = { base: [0.05, -0.9, 0.3], mount: 'invert',   // 底座垫高 30 cm、离主体约 0.9 m、Pocket 倒挂：试算里这样全部镜头可达且放慢倍数最小
    lookUp: 0.03, duckR: 0.11, speedPct: 100 };

  /** 进度 p 时镜头在机械臂坐标系里的位姿（4×4，行主序，KIN 的约定） */
  function lensPose(seg, p, rootAt, o) {
    const s = seg.s0 + (seg.s1 - seg.s0) * p, r = rootAt(seg.clip, s), c = seg.cam, L = k => c[k] ? c[k][0] + (c[k][1] - c[k][0]) * p : 0;
    const tgt = [r[0], r[1], r[2] + o.lookUp];
    const eu = Reel.eyeUp({ az: L('az'), el: L('el'), dist: L('dist'), roll: L('roll') }, tgt), b = o.base;
    return { T: KIN.lookPose([eu.eye[0] - b[0], eu.eye[1] - b[1], eu.eye[2] - b[2]], [tgt[0] - b[0], tgt[1] - b[1], tgt[2] - b[2]], eu.up), duck: [r[0] - b[0], r[1] - b[1], r[2] - b[2]] };
  }
  const segDist = (a, b, p) => {   // 点到线段的距离
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const t = Math.min(1, Math.max(0, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1)));
    return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
  };

  /** 从一个初始解出发，沿进度解完整条路径 */
  function runPath(seg, q0, rootAt, o) {
    const Q = []; let prev = q0, unreach = 0, limit = 0, minClr = Infinity, minSin = 1;
    for (let i = 0; i <= M; i++) {
      const lp = lensPose(seg, i / M, rootAt, o), r = KIN.ik(lp.T, prev, i === 0 ? 200 : 60, [0, 0]);
      if (r.pe > 0.002 || r.re > 0.01) unreach++;
      for (let j = 0; j < 6; j++) if (Math.abs(r.q[j]) > KIN.LIM[j] * D2R) limit++;
      for (const c of KIN.capsules(r.F)) {
        minClr = Math.min(minClr, Math.min(c.a[2], c.b[2]) + o.base[2] - c.r);                    // 离地面
        minClr = Math.min(minClr, segDist(c.a, c.b, lp.duck) - c.r - o.duckR);                      // 离小鸭子（按一个球估）
      }
      minSin = Math.min(minSin, Math.abs(Math.sin(r.q[4])));
      Q.push(r.q); prev = r.q;
    }
    let travel = 0; for (let i = 1; i <= M; i++) for (let j = 0; j < 6; j++) travel += Math.abs(Q[i][j] - Q[i - 1][j]);
    return { Q, unreach, limit, minClr, minSin, travel };
  }

  /** 给时间轴上每个镜头选一条最顺的逆解分支。rootAt(clip, s) 返回小鸭子身体位置 [x,y,z] */
  function plan(tl, rootAt, opt) {
    const o = Object.assign({}, DEF, opt || {}); KIN.setMount(o.mount); KIN.setGimbal(false);
    const wrap = v => Math.atan2(Math.sin(v), Math.cos(v)), shots = {};
    tl.segs.forEach((seg, i) => {
      if (seg.base !== i) return;
      const T0 = lensPose(seg, 0, rootAt, o).T; let best = null;
      for (const sd of KIN.seedsFor(T0)) {
        const r0 = KIN.ik(T0, sd, 200, [0, 0]); if (r0.pe > 1e-3 || r0.re > 0.01) continue;
        const R = runPath(seg, r0.q.map(wrap), rootAt, o);
        R.cost = R.unreach * 1000 + R.limit * 100 + (R.minClr < 0.01 ? 500 : 0) + (R.minSin < 0.15 ? 50 : 0) + R.travel;
        if (!best || R.cost < best.cost) best = R;
      }
      if (!best) best = Object.assign(runPath(seg, KIN.seedsFor(T0)[0], rootAt, o), { cost: Infinity });
      best.ok = best.unreach === 0 && best.limit === 0 && best.minClr >= 0.01;
      shots[i] = best;
    });
    const P = { tl, opt: o, shots };
    // 每段的峰值关节速度 / 加速度（按输出时间，也就是成片速度），以及需要放慢的倍数
    const vlim = KIN.VMAX.map(v => v * o.speedPct / 100 * D2R), alim = KIN.AMAX.map(a => a * o.speedPct / 100 * D2R), dt = 1 / 240;
    P.segs = tl.segs.map(seg => {
      const n = Math.round((seg.t1 - seg.t0) / dt), pv = [0, 0, 0, 0, 0, 0], pa = [0, 0, 0, 0, 0, 0]; let q0 = null, v0 = null;
      for (let i = 0; i <= n; i++) {
        const q = qAt(P, seg.t0 + (seg.t1 - seg.t0) * i / n + (i === n ? -1e-9 : 0));
        if (q0) { const v = q.map((x, j) => (x - q0[j]) / dt); v.forEach((x, j) => { pv[j] = Math.max(pv[j], Math.abs(x)); if (v0) pa[j] = Math.max(pa[j], Math.abs(x - v0[j]) / dt); }); v0 = v; }
        q0 = q;
      }
      const nv = Math.max(...pv.map((v, j) => v / vlim[j])), na = Math.sqrt(Math.max(...pa.map((a, j) => a / alim[j])));
      return { peakV: pv, peakA: pa, slowV: nv, slowA: na, slow: Math.max(1, nv, na) };
    });
    P.takes = Object.keys(shots).map(k => {   // 每个镜头拍一条：取用到它的各段里最苛刻的放慢倍数
      const i = +k, mine = tl.segs.map((g, j) => g.base === i ? j : -1).filter(j => j >= 0);
      const slow = Math.max(...mine.map(j => P.segs[j].slow)), seg = tl.segs[i];
      return { seg: i, name: seg.name, clip: seg.clip, ok: shots[i].ok, minClr: shots[i].minClr, unreach: shots[i].unreach, slow, realDur: (seg.t1 - seg.t0) * slow };
    });
    P.slow = Math.max(...P.takes.map(t => t.slow)); P.ok = P.takes.every(t => t.ok);
    return P;
  }

  /** 输出时间 t 的六个关节角（弧度） */
  const _ev = { cam: {} };
  function qAt(P, t, out) {
    const e = Reel.evalAt(P.tl, t, _ev), Q = P.shots[e.seg.base].Q, f = Math.min(Math.max(e.p, 0), 1) * M, i = Math.min(M - 1, Math.floor(f)), a = f - i;
    // 三次插值（Catmull-Rom）：关节速度连续，算出来的加速度才不是折线拐点造成的假尖峰
    const A0 = Q[Math.max(i - 1, 0)], A1 = Q[i], A2 = Q[i + 1], A3 = Q[Math.min(i + 2, M)], a2 = a * a, a3 = a2 * a;
    out = out || new Array(6);
    for (let j = 0; j < 6; j++) out[j] = 0.5 * (2 * A1[j] + (A2[j] - A0[j]) * a + (2 * A0[j] - 5 * A1[j] + 4 * A2[j] - A3[j]) * a2 + (3 * A1[j] - A0[j] - 3 * A2[j] + A3[j]) * a3);
    return out;
  }

  /** 导出某个镜头的真机轨迹 CSV（已按放慢倍数拉长，50 Hz） */
  function takeCsv(P, segIndex, hz) {
    hz = hz || 50; const seg = P.tl.segs[segIndex], take = P.takes.find(t => t.seg === segIndex), n = Math.ceil(take.realDur * hz), rows = ['t,j1,j2,j3,j4,j5,j6'];
    for (let i = 0; i <= n; i++) { const tr = i / hz, q = qAt(P, Math.min(seg.t0 + tr / take.slow, seg.t1 - 1e-9)); rows.push([tr.toFixed(3), ...q.map(v => (v / D2R).toFixed(3))].join(',')); }
    return rows.join('\n');
  }

  const api = { plan, qAt, takeCsv, lensPose, DEF, M };
  root.ReelArm = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
