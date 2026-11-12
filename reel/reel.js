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

  /** 一组镜头：clip 素材、s 素材起止秒、beats 占几拍、cam 起止机位（az/el 弧度，dist 米，fov 度，roll 弧度）。
   *  rev:true 表示把上一段倒放回去（不用再写 clip/s/cam）。 */
  const SHOTS = [
    { name: '起步 · 环绕推近', clip: 'walk_forward', s: [0.6, 3.2], beats: 4, k: 3.4, cam: { az: [-2.5, -0.35], el: [0.55, 0.12], dist: [1.5, 0.52], fov: [34, 30], roll: [-0.22, 0] } },
    { name: '倒放 · 拉回', rev: true, beats: 2, k: 3.0 },
    { name: '左脚踢 · 低机位甩入', clip: 'kick_left', s: [0.55, 1.5], beats: 2, k: 3.2, cam: { az: [2.9, 1.15], el: [0.02, 0.1], dist: [0.95, 0.42], fov: [30, 26], roll: [0.3, 0] } },
    { name: '倒放', rev: true, beats: 1, k: 2.6 },
    { name: '再踢一次', rev: false, again: true, beats: 1, k: 2.6 },
    { name: '倒放', rev: true, beats: 1, k: 2.6 },
    { name: '翻滚 · 跟拍', clip: 'roll', s: [0.9, 3.5], beats: 4, k: 2.6, cam: { az: [-0.2, 1.9], el: [0.18, 0.4], dist: [0.6, 0.95], fov: [30, 34], roll: [0.18, -0.06] } },
    { name: '倒放 · 滚回来', rev: true, beats: 2, k: 3.0 },
    { name: '坐下 · 俯拍压下', clip: 'sit_stand', s: [1.2, 3.4], beats: 2, k: 3.0, cam: { az: [0.9, 2.2], el: [1.15, 0.32], dist: [1.2, 0.66], fov: [32, 28], roll: [-0.35, 0] } },
    { name: '倒放 · 站起', rev: true, beats: 2, k: 3.0 },
    { name: '低头抓地 · 贴地推近', clip: 'ground_pick', s: [1.0, 3.0], beats: 2, k: 3.2, cam: { az: [3.6, 2.2], el: [0.3, 0.04], dist: [1.0, 0.4], fov: [30, 24], roll: [0.2, 0] } },
    { name: '倒放', rev: true, beats: 2, k: 3.0 },
    { name: 'S 形走 · 大环绕收尾', clip: 'walk_s', s: [1.5, 7.0], beats: 6, k: 3.6, cam: { az: [-1.2, 2.6], el: [0.08, 0.34], dist: [0.45, 1.25], fov: [26, 34], roll: [0.16, 0] } },
  ];

  /** 把镜头表按 BPM 排成时间轴。返回 { bpm, beat（一拍几秒）, dur, segs }；每段 { t0, t1, clip, s0, s1, cam, k, rev, name, cut } */
  function build(shots, bpm) {
    shots = shots || SHOTS; bpm = bpm || 100;
    const beat = 60 / bpm, segs = [];
    let t = 0, base = null;
    for (const sh of shots) {
      let seg;
      if (sh.rev || sh.again) {
        if (!base) throw new Error('第一段不能是倒放');
        seg = { clip: base.clip, s0: base.s0, s1: base.s1, cam: base.cam, rev: !!sh.rev, cut: false };
      } else {
        if (!sh.clip || !sh.s || !sh.cam) throw new Error('镜头缺 clip / s / cam：' + (sh.name || ''));
        seg = { clip: sh.clip, s0: sh.s[0], s1: sh.s[1], cam: sh.cam, rev: false, cut: segs.length > 0 };
        base = seg;
      }
      seg.name = sh.name || ''; seg.k = sh.k || 3; seg.beats = sh.beats || 2;
      seg.t0 = t; t += seg.beats * beat; seg.t1 = t;
      segs.push(seg);
    }
    return { bpm, beat, dur: t, segs };
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
    const e = easeOut(u, g.k), p = g.rev ? 1 - e : e;
    out.i = i; out.seg = g; out.u = u; out.p = p;
    out.clip = g.clip; out.s = lerp(g.s0, g.s1, p);
    out.rate = (g.rev ? -1 : 1) * easeOutRate(u, g.k) * (g.s1 - g.s0) / d;
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

  const api = { SHOTS, build, evalAt, segAt, beats, easeOut, easeOutRate };
  root.Reel = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
