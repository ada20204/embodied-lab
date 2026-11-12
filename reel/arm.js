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
    lookUp: 0.03, subjectR: 0.11, speedPct: 100 };

  /** 进度 p 时镜头在机械臂坐标系里的位姿（4×4，行主序，KIN 的约定） */
  function lensPose(seg, p, rootAt, o) {
    const s = seg.s0 + (seg.s1 - seg.s0) * p, r = seg.clip ? rootAt(seg.clip, s) : [0, 0, 0], c = seg.cam, L = k => c[k] ? c[k][0] + (c[k][1] - c[k][0]) * p : 0;
    const tgt = [r[0], r[1], r[2] + o.lookUp];
    const eu = Reel.eyeUp({ az: L('az'), el: L('el'), dist: L('dist'), roll: L('roll') }, tgt), b = o.base;
    return { T: KIN.lookPose([eu.eye[0] - b[0], eu.eye[1] - b[1], eu.eye[2] - b[2]], [tgt[0] - b[0], tgt[1] - b[1], tgt[2] - b[2]], eu.up), subj: [tgt[0] - b[0], tgt[1] - b[1], tgt[2] - b[2]], eye: eu.eye };
  }
  const segDist = (a, b, p) => {   // 点到线段的距离
    const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const t = Math.min(1, Math.max(0, (ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2]) / (ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1)));
    return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
  };

  // ---- 干涉检测（沿用预演台的做法）：把机械臂和 Pocket 看成 7 段胶囊体，逐段检查 台面 / 主体 / 底座立柱 / 自碰撞 ----
  function segSeg(p1, q1, p2, q2) {   // 两条线段的最近距离
    const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cl = v => Math.max(0, Math.min(1, v));
    const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r); let sN, tN;
    if (a < 1e-12 && e < 1e-12) return Math.hypot(r[0], r[1], r[2]);
    if (a < 1e-12) { sN = 0; tN = cl(f / e); } else {
      const c = dot(d1, r);
      if (e < 1e-12) { tN = 0; sN = cl(-c / a); } else {
        const b = dot(d1, d2), den = a * e - b * b; sN = den > 1e-12 ? cl((b * f - c * e) / den) : 0; tN = (b * sN + f) / e;
        if (tN < 0) { tN = 0; sN = cl(-c / a); } else if (tN > 1) { tN = 1; sN = cl((b - c) / a); }
      }
    }
    return Math.hypot(p1[0] + d1[0] * sN - p2[0] - d2[0] * tN, p1[1] + d1[1] * sN - p2[1] - d2[1] * tN, p1[2] + d1[2] * sN - p2[2] - d2[2] * tN);
  }
  const SELF = [[0, 3], [0, 4], [0, 5], [0, 6], [1, 4], [1, 5], [1, 6], [2, 6]];   // 可能互相碰到的臂段
  const WHAT = { floor: '台面', subject: '主体', base: '底座', self: '自己' };
  /** 某个姿态下的干涉情况。F = 正运动学结果，subj = 主体位置（机械臂坐标系）。返回 { mask（第 i 位 = 第 i 段有干涉）, hits: [{part, what}], clr（离台面和主体的最小间隙） } */
  function collide(F, subj, o) {
    const C = KIN.capsules(F), hits = []; let mask = 0, clr = Infinity;
    const colA = [0, 0, -o.base[2]], colB = [0, 0, KIN.LAYOUT.baseH];
    const add = (i, what) => { mask |= 1 << i; hits.push({ part: i, what }); };
    C.forEach((c, i) => {
      const fl = Math.min(c.a[2], c.b[2]) + o.base[2] - c.r, sj = segDist(c.a, c.b, subj) - c.r - o.subjectR;
      clr = Math.min(clr, fl, sj);
      if (fl < 0.01) add(i, 'floor');
      if (sj < 0.01) add(i, 'subject');
      if (i >= 1 && segSeg(c.a, c.b, colA, colB) < c.r + KIN.LAYOUT.baseR + 0.01) add(i, 'base');
    });
    for (const [i, j] of SELF) if (segSeg(C[i].a, C[i].b, C[j].a, C[j].b) < C[i].r + C[j].r + 0.01) { mask |= (1 << i) | (1 << j); hits.push({ part: i, what: 'self', other: j }); }
    return { mask, hits, clr };
  }
  const hitText = h => h.what === 'self' ? `${KIN.PART[h.part]}碰到${KIN.PART[h.other]}` : `${KIN.PART[h.part]}碰到${WHAT[h.what]}`;

  /** 从一个初始解出发，沿进度解完整条路径 */
  function runPath(seg, q0, rootAt, o) {
    const Q = [], path = [], flags = [], seen = new Map(); let prev = q0, unreach = 0, limit = 0, minClr = Infinity, minSin = 1, hitN = 0;
    for (let i = 0; i <= M; i++) {
      const lp = lensPose(seg, i / M, rootAt, o), r = KIN.ik(lp.T, prev, i === 0 ? 200 : 60, [0, 0]);
      let fl = 0;                                        // 这个点的状态：1 够不着，2 超限位，4 干涉
      if (r.pe > 0.002 || r.re > 0.01) { unreach++; fl |= 1; }
      for (let j = 0; j < 6; j++) if (Math.abs(r.q[j]) > KIN.LIM[j] * D2R) { limit++; fl |= 2; }
      const col = collide(r.F, lp.subj, o); minClr = Math.min(minClr, col.clr);
      if (col.mask) { hitN++; fl |= 4; for (const h of col.hits) { const k = hitText(h); if (!seen.has(k)) seen.set(k, i / M); } }
      minSin = Math.min(minSin, Math.abs(Math.sin(r.q[4])));
      Q.push(r.q); path.push(lp.eye); flags.push(fl); prev = r.q;
    }
    let travel = 0; for (let i = 1; i <= M; i++) for (let j = 0; j < 6; j++) travel += Math.abs(Q[i][j] - Q[i - 1][j]);
    return { Q, path, flags, unreach, limit, minClr, minSin, travel, hitN, hitList: [...seen.keys()] };
  }

  /** 给一个镜头选一条最顺的逆解分支，并写明有什么问题 */
  function planShot(seg, rootAt, o) {
    const wrap = v => Math.atan2(Math.sin(v), Math.cos(v));
    {
      const T0 = lensPose(seg, 0, rootAt, o).T; let best = null;
      for (const sd of KIN.seedsFor(T0)) {
        const r0 = KIN.ik(T0, sd, 200, [0, 0]); if (r0.pe > 1e-3 || r0.re > 0.01) continue;
        const R = runPath(seg, r0.q.map(wrap), rootAt, o);
        R.cost = R.unreach * 1000 + R.limit * 100 + R.hitN * 20 + (R.minSin < 0.15 ? 50 : 0) + R.travel;
        if (!best || R.cost < best.cost) best = R;
      }
      if (!best) best = Object.assign(runPath(seg, KIN.seedsFor(T0)[0], rootAt, o), { cost: Infinity });
      best.issues = [];
      if (best.unreach) best.issues.push(`够不着（${Math.round(100 * best.unreach / (M + 1))}% 的路径）`);
      if (best.limit) best.issues.push('关节超出限位');
      if (!best.unreach && best.hitN) best.issues.push('干涉：' + best.hitList.slice(0, 3).join('、') + (best.hitList.length > 3 ? ' 等' : ''));
      best.warn = !best.unreach && best.minSin < 0.15 ? ['接近手腕奇异位形，实际会抖或很慢'] : [];
      best.ok = best.issues.length === 0;
      return best;
    }
  }

  /** 给时间轴上每个镜头选一条最顺的逆解分支。rootAt(clip, s) 返回小鸭子身体位置 [x,y,z] */
  function plan(tl, rootAt, opt) {
    const o = Object.assign({}, DEF, opt || {}); KIN.setMount(o.mount); KIN.setGimbal(false);
    const shots = {};
    tl.segs.forEach((seg, i) => { if (seg.base === i) shots[i] = planShot(seg, rootAt, o); });
    const P = { tl, opt: o, shots, rootAt };
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
      return { seg: i, name: seg.name, clip: seg.clip, ok: shots[i].ok, issues: shots[i].issues, warn: shots[i].warn, minClr: shots[i].minClr, unreach: shots[i].unreach, slow, realDur: (seg.t1 - seg.t0) * slow };
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

  /** 输出时间 t 这一刻的姿态和干涉情况（给自由视角里标红用） */
  function stateAt(P, t) {
    const e = Reel.evalAt(P.tl, t, _ev), seg = e.seg, p = e.p, q = qAt(P, t), F = KIN.fk(q, [0, 0]);
    return Object.assign({ q, F }, collide(F, lensPose(seg, p, P.rootAt, P.opt).subj, P.opt));
  }

  /** 自动修正：在原机位附近找一个机械臂拍得了的版本。尽量少改——距离（影响构图）改动代价最高，其次俯仰，再次方位。
   *  这是个生成器：每试一个候选就 yield 一次进度，方便页面边算边刷新；最后一次 yield 的 done:true 里带结果。 */
  function* repair(seg, rootAt, opt) {
    const o = Object.assign({}, DEF, opt || {}); KIN.setMount(o.mount); KIN.setGimbal(false);
    const KEYS = [['dist', 0.03, 0.2, 1.4, 3], ['el', 4 * D2R, 0, 85 * D2R, 1.2], ['az', 6 * D2R, -Math.PI, 2 * Math.PI, 1.5]];
    const orig = { az: seg.cam.az.slice(), el: seg.cam.el.slice(), dist: seg.cam.dist.slice() };
    const mk = c => Object.assign({}, seg, { cam: Object.assign({}, seg.cam, c) });
    const dev = c => KEYS.reduce((a, [k, st, , , w]) => a + (Math.abs(c[k][0] - orig[k][0]) + Math.abs(c[k][1] - orig[k][1])) / st * w, 0);
    const score = c => { const R = planShot(mk(c), rootAt, o); return { R, f: (R.ok ? 0 : 1000) + R.unreach * 60 + R.limit * 60 + R.hitN * 60 + (R.minSin < 0.15 ? 40 : 0) + dev(c) * 1.5 }; };
    let cur = { az: orig.az.slice(), el: orig.el.slice(), dist: orig.dist.slice() }, cv = score(cur), evals = 1;
    const before = cv.R;
    for (let round = 0; round < 6; round++) {
      let improved = false;
      for (const [k, st, lo, hi] of KEYS) for (const e2 of [0, 1]) for (const m of [1, -1, 2, -2, 4, -4, 8, -8, 16, -16]) {
        const v = cur[k][e2] + m * st; if (v < lo - 1e-9 || v > hi + 1e-9) continue;
        const c = { az: cur.az.slice(), el: cur.el.slice(), dist: cur.dist.slice() }; c[k][e2] = v;
        const pv = score(c); evals++;
        if (pv.f < cv.f - 1e-6) { cur = c; cv = pv; improved = true; }
        yield { done: false, evals };
      }
      if (!improved) break;
    }
    yield { done: true, evals, ok: cv.R.ok, cam: cur, changed: dev(cur) > 0, before, after: cv.R };
  }

  /** 导出某个镜头的真机轨迹 CSV（已按放慢倍数拉长，50 Hz） */
  function takeCsv(P, segIndex, hz) {
    hz = hz || 50; const seg = P.tl.segs[segIndex], take = P.takes.find(t => t.seg === segIndex), n = Math.ceil(take.realDur * hz), rows = ['t,j1,j2,j3,j4,j5,j6'];
    for (let i = 0; i <= n; i++) { const tr = i / hz, q = qAt(P, Math.min(seg.t0 + tr / take.slow, seg.t1 - 1e-9)); rows.push([tr.toFixed(3), ...q.map(v => (v / D2R).toFixed(3))].join(',')); }
    return rows.join('\n');
  }

  const api = { plan, planShot, qAt, stateAt, collide, hitText, repair, takeCsv, lensPose, DEF, M };
  root.ReelArm = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
