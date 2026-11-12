/* 运镜卡点时间轴（纯函数，无依赖，浏览器和 node 都能用）
 *
 * 想法来自剪辑里的“变速卡点”：每个节拍一段镜头，段内先快后慢；倒放段把同一段素材倒着放，同样先快后慢。
 * 这里不剪视频，而是直接算：
 *   - 素材时间 s（小鸭子动作播到第几秒）和镜头位置共用同一个进度 p；
 *   - 正放段 p = ease(u)，倒放段 p = 1 − ease(u)，u 是这一段里的输出进度 0…1；
 *   - ease(u) = 1 − (1 − u)^k：一开始最快（k 倍于平均速度），最后停住。段与段的交界就是节拍点，
 *     速度从 0 跳到最大，切镜头藏在这一下里；
 *   - 稳帧：镜头的注视点每一帧都取小鸭子身体的位置，所以主体永远在画面中心。
 */
(function (root) {
  'use strict';
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeOut = (u, k) => 1 - Math.pow(1 - Math.min(Math.max(u, 0), 1), k);
  const easeOutRate = (u, k) => k * Math.pow(1 - Math.min(Math.max(u, 0), 1), k - 1);   // d ease / du
  /** 起步段：真机不能瞬间达到最大速度，所以每段最前面留一小段加速（占这一段的 a）。a = 0 就是剪辑里那种“一上来就最快” */
  const attackW = (u, a) => a > 0 ? (u < a ? u * u / (2 * a) : u - a / 2) / (1 - a / 2) : u;
  const attackRate = (u, a) => a > 0 ? (u < a ? u / a : 1) / (1 - a / 2) : 1;
  /** 机位 → 镜头位置和“上”方向（和渲染器里的算法一致）。cam: az/el/dist/roll，target: 注视点 */
  function eyeUp(cam, target) {
    const ce = Math.cos(cam.el), d = [ce * Math.sin(cam.az), -ce * Math.cos(cam.az), Math.sin(cam.el)];
    const eye = [target[0] + cam.dist * d[0], target[1] + cam.dist * d[1], target[2] + cam.dist * d[2]];
    let up = [0, 0, 1];
    if (cam.roll) { const l = Math.hypot(d[0], d[1]) || 1, r = [-d[1] / l, d[0] / l, 0], c = Math.cos(cam.roll), s = Math.sin(cam.roll); up = [s * r[0], s * r[1], c]; }
    return { eye, up };
  }

  /** 把镜头表（studio/script.js 编译出来的内部格式）按 BPM 排成时间轴。返回 { bpm, beat（一拍几秒）, dur, segs }；每段 { t0, t1, clip, s0, s1, cam, k, rev, name, cut } */
  function build(shots, bpm, opt) {
    bpm = bpm || 100; opt = opt || {};
    const beat = 60 / bpm, segs = [];
    let t = 0, base = null;
    for (const sh of shots) {
      let seg;
      if (sh.rev || sh.again) {
        if (!base) throw new Error('第一段不能是倒放');
        seg = { clip: base.clip, s0: base.s0, s1: base.s1, cam: base.cam, rev: !!sh.rev, cut: false, base: base.base };
      } else {
        if (!sh.cam) throw new Error('镜头缺机位：' + (sh.name || ''));
        const ss = sh.s || [0, 1];   // 静物没有动作片段
        seg = { clip: sh.clip || null, s0: ss[0], s1: ss[1], cam: sh.cam, rev: false, cut: segs.length > 0, base: segs.length };
        base = seg;
      }
      seg.name = sh.name || ''; seg.k = sh.k || 3; seg.beats = sh.beats || 2;
      seg.t0 = t; t += seg.beats * beat; seg.t1 = t;
      segs.push(seg);
    }
    return { bpm, beat, dur: t, segs, attack: opt.attack || 0 };
  }

  function segAt(tl, t) {
    const S = tl.segs; let lo = 0, hi = S.length - 1;
    if (t <= 0) return 0; if (t >= tl.dur) return hi;
    while (lo < hi) { const m = (lo + hi) >> 1; if (t < S[m].t1) hi = m; else lo = m + 1; }
    return lo;
  }

  /** t 秒（输出时间）时的状态：素材时间 s、机位 cam、速率 rate（素材秒/输出秒，倒放为负）、所在段、离上一个节拍多久 */
  function evalAt(tl, t, out) {
    out = out || { cam: {} };
    t = Math.min(Math.max(t, 0), tl.dur);
    const i = segAt(tl, t), g = tl.segs[i], d = g.t1 - g.t0, u = d > 0 ? (t - g.t0) / d : 1;
    const a = tl.attack || 0, w = attackW(u, a), e = easeOut(w, g.k), p = g.rev ? 1 - e : e;
    out.i = i; out.seg = g; out.u = u; out.p = p;
    out.clip = g.clip; out.s = lerp(g.s0, g.s1, p);
    out.pRate = (g.rev ? -1 : 1) * easeOutRate(w, g.k) * attackRate(u, a) / d;   // 进度每秒变化多少
    out.rate = out.pRate * (g.s1 - g.s0);
    const c = g.cam, o = out.cam;
    for (const key of ['az', 'el', 'dist', 'fov', 'roll']) o[key] = c[key] ? lerp(c[key][0], c[key][1], p) : 0;
    out.sinceBeat = t - Math.floor(t / tl.beat + 1e-9) * tl.beat;
    out.sinceCut = t - g.t0;
    return out;
  }

  /** 节拍点（秒）；strong 标出换段的那些拍 */
  function beats(tl) {
    const n = Math.round(tl.dur / tl.beat), starts = new Set(tl.segs.map(g => Math.round(g.t0 / tl.beat)));
    return Array.from({ length: n }, (_, b) => ({ t: b * tl.beat, strong: starts.has(b), cut: tl.segs.some(g => g.cut && Math.round(g.t0 / tl.beat) === b) }));
  }

  const api = { build, evalAt, segAt, beats, easeOut, easeOutRate, eyeUp };
  root.Reel = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
