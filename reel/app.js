/* 运镜页面：把 reel.js 算出来的“素材时间 + 机位”画出来。
 * 画面先由 WebGL 画到隐藏画布，再叠到 2D 画布上：一帧里在快门时间内画 N 次取平均，就是运动模糊。
 * 录制用 window.__reel.frame(t, N) 逐帧出图，和实时播放走同一条路径，所以成片和预览一致。 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const Q = new URLSearchParams(location.search);
  const W = 1280, H = 720, FPS = 30, SHUTTER = 0.8 / FPS;   // 快门开 80% 帧时长，拖影更顺
  const out = $('#out'), ctx = out.getContext('2d'), glc = $('#gl'), msg = $('#msg');
  const st = window.Stage3D.create(glc, { pixelRatio: 1, bg: [0.035, 0.04, 0.05] });
  const S = { t: 0, playing: false, lock: Q.get('lock') !== '0', blur: Q.get('blur') !== '0', hud: Q.get('hud') !== '0', snd: false, samples: +Q.get('samples') || 5 };
  let tl = Reel.build(Reel.SHOTS, +Q.get('bpm') || 100), bts = Reel.beats(tl);
  let duck = null; const clips = {};
  const ev = { cam: {} }, mo = G1Motion.makeOut(), pose = {}, anchor = G1Motion.makeOut();
  const cam = { target: [0, 0, 0.13], dist: 1, az: 0, el: 0.2, fov: 30, roll: 0 };

  const getJson = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
  const getBuf = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.arrayBuffer(); });

  async function load() {
    if (!st) throw new Error('这个浏览器不支持 WebGL2');
    const lo = Q.get('lod') === 'lo';
    const [spec, buf] = await Promise.all([getJson('../assets/duck/duck.json'), getBuf('../assets/duck/duck' + (lo ? '_lo' : '') + '.glb')]);
    duck = G1Model.build(st, Stage3D.parseGLB(buf), spec);
    const ids = [...new Set(tl.segs.map(g => g.clip))];
    await Promise.all(ids.map(async id => { clips[id] = G1Motion.fromJson(await getJson(`../assets/duck/motions/${id}.json`)); }));
  }

  /** 把场景摆到输出时间 t 并画一次 WebGL */
  function drawScene(t) {
    Reel.evalAt(tl, t, ev);
    const clip = clips[ev.clip];
    G1Motion.sample(clip, ev.s, mo);
    duck.root.base = Stage3D.M4.fromQT(mo.quat, mo.pos);
    duck.set(G1Motion.toPose(mo.q, pose, clip.joints));
    let tx = mo.pos[0], ty = mo.pos[1], tz = mo.pos[2];
    if (!S.lock) { G1Motion.sample(clip, ev.seg.s0, anchor); tx = anchor.pos[0]; ty = anchor.pos[1]; tz = anchor.pos[2]; }   // 不稳帧：镜头盯着这段开始时的位置
    cam.target[0] = tx; cam.target[1] = ty; cam.target[2] = tz + 0.015;
    cam.az = ev.cam.az; cam.el = ev.cam.el; cam.dist = ev.cam.dist; cam.fov = ev.cam.fov; cam.roll = ev.cam.roll;
    st.light.az = (cam.az - Math.PI / 2) * 180 / Math.PI - 42; st.light.el = 44; st.light.rim = 1.5; st.light.spec = 1.4;
    st.shadows.length = 0; st.shadows.push({ c: [mo.pos[0], mo.pos[1]], r: 0.14 });
    st.render({ roots: [duck.root], camera: cam, gridCenter: [mo.pos[0], mo.pos[1]], gridScale: 0.4, gridColor: [0.55, 0.66, 0.80] });
  }

  function hud(t) {
    Reel.evalAt(tl, t, ev);
    // 暗角
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 换镜头的闪白：只在切点后 90 毫秒内
    if (ev.seg.cut && ev.sinceCut < 0.09) { ctx.fillStyle = `rgba(255,255,255,${0.22 * (1 - ev.sinceCut / 0.09)})`; ctx.fillRect(0, 0, W, H); }
    if (!S.hud) return;
    ctx.textBaseline = 'alphabetic';
    ctx.font = '600 15px -apple-system, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(232,237,242,0.92)'; ctx.fillText(ev.seg.name, 40, H - 62);
    // 速率读数：素材秒 / 画面秒
    const r = ev.rate, mag = Math.abs(r);
    ctx.font = '700 30px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    ctx.fillStyle = r < 0 ? '#7cc4ff' : '#ff7a1a';
    const rtxt = (r < 0 ? '◀ ' : '▶ ') + mag.toFixed(1) + '×', rw = ctx.measureText(rtxt).width;
    ctx.fillText(rtxt, 40, H - 92);
    ctx.font = '500 12px -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif';
    ctx.fillStyle = 'rgba(139,151,165,0.95)';
    ctx.fillText(r < 0 ? '倒放 · 先快后慢' : '正放 · 先快后慢', 40 + rw + 14, H - 96);
    if (S.lock) ctx.fillText('稳帧：注视点锁定主体', 40, H - 126);
    // 节拍条：每拍一个点，换段的拍更大，换镜头的拍用强调色
    const x0 = 40, x1 = W - 40, y = H - 34;
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(x0, y - 1, x1 - x0, 2);
    for (const b of bts) {
      const x = x0 + (x1 - x0) * b.t / tl.dur, passed = b.t <= t + 1e-6;
      ctx.beginPath(); ctx.arc(x, y, b.strong ? 4.5 : 2.2, 0, 6.2832);
      ctx.fillStyle = b.cut ? (passed ? '#ff7a1a' : 'rgba(255,122,26,0.45)') : (passed ? 'rgba(232,237,242,0.95)' : 'rgba(232,237,242,0.32)');
      ctx.fill();
    }
    const px = x0 + (x1 - x0) * t / tl.dur, pulse = Math.max(0, 1 - ev.sinceBeat / 0.16);
    ctx.fillStyle = '#fff'; ctx.fillRect(px - 1, y - 9 - 4 * pulse, 2, 18 + 8 * pulse);
    // 取景中心的小十字：稳帧时主体压在它上面
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(W / 2 - 9, H / 2); ctx.lineTo(W / 2 + 9, H / 2); ctx.moveTo(W / 2, H / 2 - 9); ctx.lineTo(W / 2, H / 2 + 9); ctx.stroke();
  }

  /** 画出输出时间 t 的一帧；n = 快门内的采样次数（1 = 不模糊） */
  function frame(t, n) {
    n = Math.max(1, n | 0);
    for (let i = 0; i < n; i++) {
      drawScene(Math.min(t + SHUTTER * i / n, tl.dur));
      ctx.globalAlpha = 1 / (i + 1); ctx.drawImage(glc, 0, 0, W, H);
    }
    ctx.globalAlpha = 1; hud(t);
  }

  // ---- 节拍声（WebAudio，播放时才有）----
  let ac = null;
  function tick(strong) {
    if (!S.snd) return;
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain(), now = ac.currentTime;
    o.frequency.setValueAtTime(strong ? 150 : 90, now); o.frequency.exponentialRampToValueAtTime(42, now + 0.12);
    g.gain.setValueAtTime(strong ? 0.6 : 0.3, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    o.connect(g).connect(ac.destination); o.start(now); o.stop(now + 0.18);
  }

  // ---- 实时播放 ----
  const ui = { play: $('#play'), scrub: $('#scrub'), tc: $('#tc'), bpm: $('#bpm'), lock: $('#lock'), blur: $('#blur'), snd: $('#snd') };
  let last = 0, lastBeat = -1;
  function syncUi() {
    ui.play.textContent = S.playing ? '❚❚ 暂停' : '▶ 播放'; ui.play.setAttribute('aria-pressed', String(S.playing));
    ui.lock.setAttribute('aria-pressed', String(S.lock)); ui.blur.setAttribute('aria-pressed', String(S.blur)); ui.snd.setAttribute('aria-pressed', String(S.snd));
    ui.tc.textContent = `${S.t.toFixed(2)} / ${tl.dur.toFixed(2)}`;
    if (document.activeElement !== ui.scrub) ui.scrub.value = String(Math.round(1000 * S.t / tl.dur));
  }
  function loop(now) {
    requestAnimationFrame(loop);
    if (!duck) return;
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    if (S.playing) {
      S.t += dt; if (S.t >= tl.dur) { S.t = 0; lastBeat = -1; }
      const b = Math.floor(S.t / tl.beat + 1e-6);
      if (b !== lastBeat) { lastBeat = b; tick(bts[b] && bts[b].strong); }
    }
    frame(S.t, S.blur ? S.samples : 1); syncUi();
  }
  ui.play.addEventListener('click', () => { S.playing = !S.playing; });
  ui.scrub.addEventListener('input', () => { S.t = tl.dur * ui.scrub.value / 1000; lastBeat = Math.floor(S.t / tl.beat); });
  ui.bpm.addEventListener('change', () => { const f = S.t / tl.dur; tl = Reel.build(Reel.SHOTS, +ui.bpm.value); bts = Reel.beats(tl); S.t = f * tl.dur; });
  ui.lock.addEventListener('click', () => { S.lock = !S.lock; });
  ui.blur.addEventListener('click', () => { S.blur = !S.blur; });
  ui.snd.addEventListener('click', () => { S.snd = !S.snd; if (S.snd) tick(true); });
  if (Q.get('bpm')) ui.bpm.value = String(tl.bpm);

  const ready = load().then(() => {
    msg.hidden = true; frame(0, 1);
    if (Q.get('render') !== '1') { S.playing = !matchMedia('(prefers-reduced-motion: reduce)').matches && Q.get('autoplay') !== '0'; last = performance.now(); requestAnimationFrame(loop); }
    return true;
  }).catch(e => { msg.textContent = '加载失败：' + e.message; throw e; });

  window.__reel = {
    ready, S, fps: FPS, get tl() { return tl; }, frame,
    /** 录制用：画第 i 帧并返回 JPEG（base64） */
    shot(i, n) { frame(i / FPS, n || 12); return out.toDataURL('image/jpeg', 0.92).slice(23); },
  };
})();
