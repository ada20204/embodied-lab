/* 滚动叙事页：固定的 3D 画布 + 章节卡片。滚动进度驱动镜头和模型动作。 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const mobile = () => innerWidth < 820;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const smooth = x => x * x * (3 - 2 * x);
  const lerp = (a, b, k) => a + (b - a) * k;

  /* ---------------- 数据：平台矩阵（出自 edge-ai 的能力快照，2026-09-28） ---------------- */
  const MATRIX = [
    { p: 'S100 / ACT', s: 'part', pill: '历史验收', ev: '历史部署包、推理与控制集成', todo: '最近服务未运行；当前实机闭环未复验，部分候选精度失败' },
    { p: 'S100 / SAM2（CPU+BPU 混合）', s: 'ok', pill: '通过（历史）', ev: '历史 CPU+BPU 混合流程；外部 mask IoU 约 0.993–0.998', todo: '历史结果，本轮未复验' },
    { p: 'S100 / SAM2（全 BPU）', s: 'fail', pill: '失败', ev: '全 BPU 方案未达标', todo: '不作为成功配方继承' },
    { p: 'S100 / SmolVLA', s: 'fail', pill: '未过阈值', ev: 'denoise 子图历史板测，cosine 约 0.98928', todo: '未过 0.99；不是完整 VLA 验收' },
    { p: 'S100 / YOLO（面包）', s: 'todo', pill: '未闭环', ev: '历史产线集成记录', todo: '源 ONNX 和校准数据缺失，重建与精度未闭环' },
    { p: '8550 / SAM2 memory encoder', s: 'part', pill: '能跑，数值未过', ev: 'QNN 2.36 FP16 转换、模型库和 context 生成成功；HTP 完成 165 次调用', todo: '原严格数值门失败；完整 SAM2 仍未验证' },
    { p: '8550 / ACT to_square vision', s: 'part', pill: '能跑，数值未过', ev: 'CPU 基线、QNN236 FP16 转换、75 次 HTP 调用成功；invoke 约 12.36 ms', todo: '三组原严格数值门未过；不是完整 ACT 策略验收' },
    { p: '8550 / 原生 QNN', s: 'ok', pill: '执行可复现', ev: '官方 qnn-net-run 完成 100 次调用；SAM2 及 3 组 ACT 的保存输出与 AidLite 字节一致', todo: '原 CPU 严格门仍失败；不能用不同配置的计时推断封装开销' },
    { p: '8550 / YOLOv5 随板样例', s: 'ok', pill: '对照成功', ev: 'QNN236 HTP 对照执行成功', todo: '与 S100 面包模型不同，不能做同模型跨平台性能比较' },
    { p: '7870 / Qwen', s: 'part', pill: '有实现，未复测', ev: 'llm-chat-lite 已有量化、NPU CLI、JNI/Service 及部署记录', todo: '本轮未重新板测；结论需绑定原始评测条件' },
    { p: '3080 / 5090', s: 'part', pill: '环境已验证', ev: '3080 GPU 修复和 CUDA 计算已验证；5090 有模型服务历史记录', todo: '逐案例补齐条件与验收证据；环境可用不等于模型验收' },
    { p: 'Jetson Orin', s: 'todo', pill: '待定位', ev: '有部署经历', todo: '项目位置、模型、软件栈和证据待定位' },
  ];
  const STLABEL = { ok: '通过', part: '部分', fail: '未通过', todo: '待补' };

  /* ---------------- 3D ---------------- */
  const canvas = $('#stage');
  let st = null;
  try { st = window.Stage3D.create(canvas); } catch (e) { console.warn('WebGL 初始化失败', e); }
  if (!st) { $('#nogl').hidden = false; document.body.classList.add('nogl-on'); }
  let g1 = null, nova = null;

  const fetchBuf = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.arrayBuffer(); });
  const fetchJson = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });

  async function loadModels() {
    if (!st) return;
    const a = Promise.all([fetchBuf('../assets/g1/g1.glb'), fetchJson('../assets/g1/g1.json')])
      .then(([b, s]) => { g1 = G1Model.build(st, Stage3D.parseGLB(b), s); });
    const b = Promise.all([fetchBuf('../assets/nova/nova5.glb'), fetchJson('../assets/nova/nova5_joints.json')])
      .then(([bf, s]) => {
        nova = NovaModel.build(st, Stage3D.parseGLB(bf), s);
        // 台面偏亮，压暗一点，不抢主体
        const plat = nova.root.byName.platform; if (plat) plat.color = [0.42, 0.45, 0.50];
      });
    await Promise.allSettled([a, b]);
    if (!g1) console.warn('G1 模型加载失败');
    if (!nova) { document.body.classList.add('no-nova'); console.info('Nova 模型不可用：双臂章节只显示文字'); }
  }

  // 镜头：sx/sy 把主体推到右侧（桌面）或上方（手机），给卡片让位
  const CAM = {
    g1: { target: [0, 0, 0.70], dist: 3.0, az: Math.PI / 2 + 0.30, el: 0.10, fov: 32, sx: 0.26, sy: 0 },
    g1b: { target: [0, 0, 0.70], dist: 2.6, az: Math.PI / 2 - 0.25, el: 0.08, fov: 32, sx: 0.26, sy: 0 },
    nova: { target: [0, 0, 0.52], dist: 3.9, az: 0.85, el: 0.24, fov: 32, sx: 0.08, sy: 0 },
    novaFar: { target: [0, 0, 0.52], dist: 4.6, az: 1.3, el: 0.30, fov: 32, sx: 0, sy: 0 },
  };
  const CHAPTERS = [
    { cam: 'g1', main: 'g1' },
    { cam: 'nova', main: 'nova', pip: true },
    { cam: 'g1b', main: 'g1' },
    { cam: 'novaFar', main: 'nova', pip: true, dim: true, pipMinW: 1180 },
    { cam: 'nova', main: 'nova', pip: true },
  ];
  const PIP_CAM = { target: [0, 0, 1.0], dist: 2.4, az: Math.PI / 2 + 0.28, el: 0.06, fov: 30, sx: 0, sy: 0 };
  const pipRect = () => mobile() ? [0.60, 0.085, 0.38, 0.25] : [0.80, 0.42, 0.19, 0.52];

  function camFor(name) {
    const c = CAM[name], m = mobile();
    return Object.assign({}, c, { sx: m ? 0 : c.sx, sy: m ? 0.20 * (c.sx ? 1 : 0.4) : c.sy, dist: m ? c.dist * 1.25 : c.dist });
  }
  function blendCam(a, b, k) {
    return { target: a.target.map((v, i) => lerp(v, b.target[i], k)), dist: lerp(a.dist, b.dist, k), az: lerp(a.az, b.az, k), el: lerp(a.el, b.el, k), fov: lerp(a.fov, b.fov, k), sx: lerp(a.sx, b.sx, k), sy: lerp(a.sy, b.sy, k) };
  }

  /* ---------------- 滚动状态 ---------------- */
  const chaps = $$('.chap'), beats = $$('.beat');
  let S = { u: 0, ch: 0, p: 0, beat: null };
  function computeScroll() {
    const vh = innerHeight, line = vh * 0.5;
    let ch = 0, p = 0;
    chaps.forEach((el, i) => { const r = el.getBoundingClientRect(); if (r.top <= line) { ch = i; p = clamp((line - r.top) / Math.max(1, r.height), 0, 1); } });
    let best = null, bd = 1e9;
    beats.forEach(b => { const r = b.getBoundingClientRect(), d = Math.abs((r.top + r.bottom) / 2 - line); if (d < bd) { bd = d; best = b; } });
    S = { u: ch + p, ch, p, beat: best };
  }

  /* ---------------- 讲解员 ---------------- */
  const cur = {};       // 当前关节角
  let gesture = 'idle', override = null, lastBeat = null;
  const hudSay = $('#hudSay'), hudGest = $('#hudGest'), hudAct = $('#hudAct');
  let voiceOn = false;

  function setGesture(id, say) {
    gesture = id;
    const g = G1Poses.GESTURES[id] || G1Poses.GESTURES.idle;
    hudGest.textContent = g.label;
    hudAct.textContent = g.action ? `动作 ${g.action.id} · ${g.action.name}` : '页面自定手势（不在白名单内）';
    if (say !== undefined) { hudSay.textContent = say; if (voiceOn && say) speak(say); }
  }
  function speak(t) {
    try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(t); u.lang = 'zh-CN'; u.rate = 1.02; speechSynthesis.speak(u); } catch (e) { /* 浏览器不支持则忽略 */ }
  }

  /* 动作白名单（来自参考项目 reply_action_policy.py） */
  const ACTIONS = [[99, '释放手臂'], [11, '双手飞吻'], [13, '右手飞吻'], [12, '左手飞吻'], [15, '举双手'], [17, '鼓掌'], [18, '击掌'], [19, '拥抱'], [22, '拒绝摆手'], [23, '举右手'], [24, 'x-ray'], [25, '面前挥手'], [26, '高位挥手'], [27, '握手']];
  const byAction = {}; Object.keys(G1Poses.GESTURES).forEach(k => { const a = G1Poses.GESTURES[k].action; if (a) byAction[a.id] = k; });
  (function buildChips() {
    const box = $('#actionChips'); if (!box) return;
    ACTIONS.forEach(([id, name]) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = `${id} ${name}`;
      if (byAction[id]) b.className = 'ready'; else b.title = '这个动作的示意姿态还没做';
      b.addEventListener('click', () => {
        $$('#actionChips button').forEach(x => x.classList.remove('active'));
        if (!byAction[id]) { hudSay.textContent = `「${name}」的示意姿态还没做。`; return; }
        b.classList.add('active'); override = { id: byAction[id], until: performance.now() + 4500 };
        setGesture(byAction[id], `演示：${name}`);
      });
      box.appendChild(b);
    });
  })();

  /* ---------------- Nova 双臂：随滚动进度做示意动作 ---------------- */
  function novaPose(p, t) {
    const ph = p * Math.PI * 3 + (reduce ? 0 : t * 0.25), o = {};
    ['L', 'R'].forEach((s, i) => {
      const sg = i ? -1 : 1, q = ph + i * 0.9;
      o[`${s}_J1`] = sg * 0.55 * Math.sin(q * 0.8);
      o[`${s}_J2`] = 0.25 + 0.35 * Math.sin(q);
      o[`${s}_J3`] = 1.0 + 0.55 * Math.sin(q + 1.2);
      o[`${s}_J4`] = 0.5 * Math.sin(q * 0.7 + 0.5);
      o[`${s}_J5`] = 0.6 * Math.sin(q * 1.1);
      o[`${s}_J6`] = q * 0.9;
    });
    return o;
  }


  /* ---------------- 交互：旋转、选中、手动控制关节 ---------------- */
  const orbit = { az: 0, el: 0, zoom: 1, taz: 0, tel: 0, tzoom: 1 };
  const manual = {};                 // 关节名 → 弧度；被手动控制的关节不再跟随动画
  let freezeUntil = 0, animT = 0, sel = null, hov = null, hoverT = 0, curRoots = [], curPip = false, drag = null, lastCh = 0, inspT = 0;
  const SEL_TINT = { c: [0.49, 0.77, 1], k: 0.62 }, HOV_TINT = { c: [1, 1, 1], k: 0.16 };
  const hintEl = $('#hint'); let hintGone = false;
  const hideHint = () => { if (!hintGone) { hintGone = true; hintEl.classList.add('gone'); } };
  setTimeout(hideHint, 12000);
  const deg = r => r * 180 / Math.PI, rad = d => d * Math.PI / 180;
  const jointOf = n => { while (n && !n.axis) n = n.parent; return n; };
  const modelOf = n => { while (n && n.parent) n = n.parent; return (g1 && n === g1.root) ? 'g1' : (nova && n === nova.root) ? 'nova' : null; };
  const G1_PART = { hip_pitch: '髋俯仰', hip_roll: '髋滚转', hip_yaw: '髋偏航', knee: '膝', ankle_pitch: '踝俯仰', ankle_roll: '踝滚转', waist_yaw: '腰偏航', waist_roll: '腰滚转', waist_pitch: '腰俯仰', shoulder_pitch: '肩俯仰', shoulder_roll: '肩滚转', shoulder_yaw: '肩偏航', elbow: '肘', wrist_roll: '腕滚转', wrist_pitch: '腕俯仰', wrist_yaw: '腕偏航' };
  const jointNames = new Map();      // 节点 → 关节名
  function indexJoints() {
    if (g1) Object.keys(g1.joints).forEach(k => jointNames.set(g1.joints[k], k));
    if (nova) Object.keys(nova.joints).forEach(k => jointNames.set(nova.joints[k], k));
  }
  function labelOf(name, model) {
    if (model === 'nova') return (name[0] === 'L' ? '左' : '右') + '臂 ' + name.slice(2);
    const side = name.startsWith('left_') ? '左' : name.startsWith('right_') ? '右' : '';
    const key = name.replace(/^(left|right)_/, '').replace(/_joint$/, '');
    return side + (G1_PART[key] || key);
  }
  const axisOf = a => ['X', 'Y', 'Z'][[0, 1, 2].sort((i, j) => Math.abs(a[j]) - Math.abs(a[i]))[0]];
  function hlNodes(n) {
    if (n.isLed) return [n];
    if (modelOf(n) === 'g1') { const b = n.isGeom ? n.parent : n; return b ? b.children.filter(c => c.isGeom) : [n]; }
    return [jointOf(n) || n];
  }
  const setTint = (list, t) => list.forEach(x => { x.tintSelf = t; });
  const nodeInfo = n => {
    if (n.isLed) return { model: 'g1', joint: null, name: null, label: '头部指示灯（示意位置）' };
    const model = modelOf(n), j = model === 'g1' ? jointOf(n.isGeom ? n.parent : n) : jointOf(n);
    const name = j ? jointNames.get(j) : null;
    return { model, joint: j, name, label: name ? labelOf(name, model) : (model === 'g1' ? '骨盆（浮动基座）' : (n.name || '部件')) };
  };

  function pickAt(x, y) {
    if (!st) return null;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (curPip && g1) {
      const r = pipRect();
      if (x >= r[0] * W && x <= (r[0] + r[2]) * W && y >= r[1] * H && y <= (r[1] + r[3]) * H) {
        const n = st.pick(x, y, { roots: [g1.root], camera: PIP_CAM, viewport: r }); if (n) return n;
      }
    }
    return st.pick(x, y, { roots: curRoots });
  }

  function openPanel(id) { const p = $('#' + id); p.hidden = false; const b = $('#' + ({ lightPanel: 'lightBtn', ledPanel: 'ledBtn' }[id] || '')); if (b) b.setAttribute('aria-expanded', 'true'); hideHint(); }
  const insp = { box: $('#inspect'), title: $('#inspTitle'), sub: $('#inspSub'), ctl: $('#inspCtl'), slider: $('#inspSlider'), val: $('#inspVal'), range: $('#inspRange') };
  function select(n) {
    if (sel) setTint(sel.nodes, null);
    if (!n) { sel = null; insp.box.hidden = true; return; }
    if (n.isLed) { sel = null; insp.box.hidden = true; openPanel('ledPanel'); return; }
    const info = nodeInfo(n); sel = Object.assign({ nodes: hlNodes(n) }, info);
    setTint(sel.nodes, SEL_TINT);
    insp.box.hidden = false; insp.title.textContent = info.label;
    insp.sub.textContent = (info.model === 'g1' ? '宇树 G1' : '越疆 Nova5 双臂') + (info.name ? ' · ' + info.name : '');
    insp.ctl.hidden = !info.joint;
    if (info.joint) {
      const r = info.joint.range || [-Math.PI, Math.PI];
      insp.slider.min = Math.floor(deg(r[0])); insp.slider.max = Math.ceil(deg(r[1]));
      insp.range.textContent = `轴 ${axisOf(info.joint.axis)} · 限位 ${deg(r[0]).toFixed(0)}° … ${deg(r[1]).toFixed(0)}°`;
      syncSlider(true);
    } else insp.sub.textContent += ' · 这个部件没有可动关节';
    hideHint();
  }
  function syncSlider(force) {
    if (!sel || !sel.joint) return;
    if (!force && document.activeElement === insp.slider) return;
    const v = manual[sel.name] !== undefined ? manual[sel.name] : sel.joint.angle;
    insp.slider.value = Math.round(deg(v)); insp.val.textContent = `${deg(v).toFixed(0)}°` + (manual[sel.name] !== undefined ? ' · 手动' : ' · 跟随动画');
  }
  insp.slider.addEventListener('input', () => { if (sel && sel.joint) { manual[sel.name] = rad(+insp.slider.value); syncSlider(true); } });
  $('#inspReset').addEventListener('click', () => { if (sel && sel.name) { delete manual[sel.name]; syncSlider(true); } });
  $('#inspResetAll').addEventListener('click', () => { Object.keys(manual).forEach(k => delete manual[k]); syncSlider(true); });
  $$('[data-close]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.close; if (id === 'inspect') select(null); else { $('#' + id).hidden = true; const bb = { lightPanel: '#lightBtn', ledPanel: '#ledBtn' }[id]; if (bb) $(bb).setAttribute('aria-expanded', 'false'); }
  }));

  const tip = $('#tip');
  function hoverAt(x, y) {
    const now = performance.now(); if (now - hoverT < 90) return; hoverT = now;
    const n = pickAt(x, y), key = n ? hlNodes(n)[0] : null;
    if (n) freezeUntil = now + 600;   // 悬停在部件上时暂停动画，方便点中
    if (key === (hov && hov[0])) { if (n) { tip.style.left = x + 'px'; tip.style.top = y + 'px'; } return; }
    if (hov) hov.forEach(h => { if (!sel || !sel.nodes.includes(h)) h.tintSelf = null; });
    hov = n ? hlNodes(n) : null;
    if (hov) hov.forEach(h => { if (!sel || !sel.nodes.includes(h)) h.tintSelf = HOV_TINT; });
    canvas.classList.toggle('over', !!n);
    if (n) { tip.hidden = false; tip.textContent = nodeInfo(n).label; tip.style.left = x + 'px'; tip.style.top = y + 'px'; } else tip.hidden = true;
  }
  function resetOrbit() { orbit.taz = orbit.tel = 0; orbit.tzoom = 1; }
  if (canvas) {
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      freezeUntil = performance.now() + 700;
      drag = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, moved: false, id: e.pointerId };
      try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
    });
    canvas.addEventListener('pointermove', e => {
      if (drag && drag.id === e.pointerId) {
        const dx = e.clientX - drag.lx, dy = e.clientY - drag.ly; drag.lx = e.clientX; drag.ly = e.clientY;
        if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 5) { drag.moved = true; canvas.classList.add('grabbing'); tip.hidden = true; hideHint(); }
        if (drag.moved) {
          orbit.taz = orbit.az = orbit.az - dx * 0.008;
          if (e.pointerType !== 'touch') orbit.tel = orbit.el = clamp(orbit.el + dy * 0.006, -0.6, 0.9);
        }
      } else if (e.pointerType === 'mouse') hoverAt(e.clientX, e.clientY);
    });
    const end = e => {
      if (!drag || drag.id !== e.pointerId) return;
      const d = drag; drag = null; canvas.classList.remove('grabbing');
      if (!d.moved && e.type === 'pointerup') select(pickAt(e.clientX, e.clientY));
    };
    canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => { tip.hidden = true; });
    canvas.addEventListener('dblclick', () => { resetOrbit(); hideHint(); });
    canvas.addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); orbit.tzoom = clamp(orbit.tzoom * Math.exp(e.deltaY * 0.01), 0.55, 1.7); hideHint(); }, { passive: false });
  }

  /* ---------------- 灯光 ---------------- */
  const LIGHT_DEFAULT = { az: -48, el: 46, key: 1, amb: 1, fill: 1, rim: 1, spec: 1, temp: 0 };
  const LIGHT_PRESETS = [
    ['影棚', LIGHT_DEFAULT],
    ['暖光', { az: -30, el: 30, key: 1.25, amb: 0.9, fill: 0.8, rim: 0.7, spec: 1.2, temp: 0.75 }],
    ['冷蓝', { az: -60, el: 35, key: 1, amb: 0.8, fill: 1, rim: 1.8, spec: 1.4, temp: -0.8 }],
    ['逆光', { az: 180, el: 28, key: 1.3, amb: 0.55, fill: 0.4, rim: 2.4, spec: 1.6, temp: 0 }],
    ['顶光', { az: 0, el: 82, key: 1.2, amb: 0.6, fill: 0.5, rim: 0.6, spec: 0.8, temp: 0 }],
    ['侧光', { az: 90, el: 18, key: 1.6, amb: 0.3, fill: 0.2, rim: 1, spec: 1.2, temp: 0.15 }],
  ];
  const LSLIDERS = [['key', '主光', 0, 2, 0.05], ['el', '主光高度', 5, 85, 1], ['amb', '环境光', 0, 2, 0.05], ['fill', '补光', 0, 2, 0.05], ['rim', '轮廓光', 0, 3, 0.05], ['spec', '高光', 0, 3, 0.05], ['temp', '色温', -1, 1, 0.05]];
  const LKEY = 'embodied-lab.light';
  const lightUI = { sl: {}, pre: [] };
  const norm180 = a => ((a + 180) % 360 + 360) % 360 - 180;
  function saveLight() { try { localStorage.setItem(LKEY, JSON.stringify(st.light)); } catch (_) { /* 忽略 */ } }
  function syncLight() {
    if (!st) return;
    const L = st.light;
    LSLIDERS.forEach(([k, , , , step]) => { const s = lightUI.sl[k]; s.input.value = L[k]; s.out.textContent = k === 'el' ? `${Math.round(L[k])}°` : (k === 'temp' ? (L[k] > 0 ? '暖' : L[k] < 0 ? '冷' : '中') + (L[k] ? Math.abs(L[k]).toFixed(1) : '') : L[k].toFixed(1)); });
    const a = rad(L.az), dx = 50 - 40 * Math.sin(a), dy = 50 - 40 * Math.cos(a);
    $('#dialSun').setAttribute('cx', dx); $('#dialSun').setAttribute('cy', dy); $('#dialLine').setAttribute('x2', dx); $('#dialLine').setAttribute('y2', dy);
    $('#dial').setAttribute('aria-valuenow', Math.round(L.az));
    lightUI.pre.forEach(([b, p]) => b.setAttribute('aria-pressed', String(Object.keys(p).every(k => Math.abs(p[k] - L[k]) < 0.026))));
  }
  function setLight(part) { Object.assign(st.light, part); syncLight(); saveLight(); }
  function buildLight() {
    if (!st) { $('#lightBtn').hidden = true; return; }
    const box = $('#lightSliders');
    LSLIDERS.forEach(([k, name, lo, hi, step]) => {
      const row = document.createElement('div'); row.className = 'sl';
      row.innerHTML = `<label for="ls_${k}">${name}</label><input id="ls_${k}" type="range" min="${lo}" max="${hi}" step="${step}"><output></output>`;
      const input = row.querySelector('input'), out = row.querySelector('output');
      input.addEventListener('input', () => setLight({ [k]: +input.value }));
      lightUI.sl[k] = { input, out }; box.appendChild(row);
    });
    const pb = $('#lightPresets');
    LIGHT_PRESETS.forEach(([name, p]) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = name; b.addEventListener('click', () => setLight(p)); pb.appendChild(b); lightUI.pre.push([b, p]); });
    $('#lightReset').addEventListener('click', () => setLight(LIGHT_DEFAULT));
    const dial = $('#dial');
    const fromEvent = e => { const r = dial.getBoundingClientRect(); setLight({ az: Math.round(norm180(deg(Math.atan2(-(e.clientX - (r.left + r.width / 2)), -(e.clientY - (r.top + r.height / 2)))))) }); };
    let dd = false;
    dial.addEventListener('pointerdown', e => { dd = true; dial.setPointerCapture(e.pointerId); fromEvent(e); });
    dial.addEventListener('pointermove', e => { if (dd) fromEvent(e); });
    dial.addEventListener('pointerup', () => { dd = false; }); dial.addEventListener('pointercancel', () => { dd = false; });
    dial.addEventListener('keydown', e => { const d = e.key === 'ArrowLeft' ? 5 : e.key === 'ArrowRight' ? -5 : 0; if (d) { e.preventDefault(); setLight({ az: norm180(st.light.az + d) }); } });
    $('#lightBtn').addEventListener('click', () => { const p = $('#lightPanel'); p.hidden = !p.hidden; $('#lightBtn').setAttribute('aria-expanded', String(!p.hidden)); hideHint(); });
    try { const saved = JSON.parse(localStorage.getItem(LKEY) || 'null'); if (saved && typeof saved === 'object') Object.keys(LIGHT_DEFAULT).forEach(k => { if (typeof saved[k] === 'number') st.light[k] = saved[k]; }); } catch (_) { /* 忽略 */ }
    syncLight();
  }


  /* ---------------- 头部指示灯 ---------------- */
  const led = { rgb: [0, 0, 0], effect: 'solid', demo: null, step: -1 };
  const ledUI = { sl: {}, pre: [] };
  const LED_PRESETS = [['灭', [0, 0, 0]], ['红 · 聆听', [255, 0, 0]], ['蓝 · 回复', [0, 0, 255]], ['绿', [0, 255, 0]], ['黄', [255, 190, 0]], ['白', [255, 255, 255]]];
  const ledStepEl = $('#ledStep');
  function syncLed() {
    ['r', 'g', 'b'].forEach((k, i) => { ledUI.sl[k].input.value = led.rgb[i]; ledUI.sl[k].out.textContent = led.rgb[i]; });
    $('#ledCall').textContent = G1Led.call(led.rgb);
    $('#ledFx').textContent = led.effect === 'blink' ? '闪烁 · 约 1 Hz' : '常亮';
    $$('#ledEffects button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.fx === led.effect)));
    ledUI.pre.forEach(([b, rgb]) => b.setAttribute('aria-pressed', String(rgb.every((v, i) => v === led.rgb[i]))));
  }
  function setLed(part, manual) {
    if (manual && led.demo) { led.demo = null; led.step = -1; ledStepEl.textContent = ''; }
    if (part.rgb) led.rgb = part.rgb.map(G1Led.clamp255);
    if (part.effect) led.effect = part.effect;
    syncLed();
  }
  function buildLed() {
    if (!st) { $('#ledBtn').hidden = true; return; }
    const box = $('#ledSliders');
    [['r', 'R 红'], ['g', 'G 绿'], ['b', 'B 蓝']].forEach(([k, name], i) => {
      const row = document.createElement('div'); row.className = 'sl';
      row.innerHTML = `<label for="led_${k}">${name}</label><input id="led_${k}" type="range" min="0" max="255" step="1"><output></output>`;
      const input = row.querySelector('input'), out = row.querySelector('output');
      input.addEventListener('input', () => { const rgb = led.rgb.slice(); rgb[i] = +input.value; setLed({ rgb }, true); });
      ledUI.sl[k] = { input, out }; box.appendChild(row);
    });
    LED_PRESETS.forEach(([name, rgb]) => {
      const b = document.createElement('button'); b.type = 'button'; b.innerHTML = `<i class="swatch" style="background:rgb(${rgb})"></i>`; b.append(name);
      b.addEventListener('click', () => setLed({ rgb }, true)); $('#ledPresets').appendChild(b); ledUI.pre.push([b, rgb]);
    });
    $$('#ledEffects button').forEach(b => b.addEventListener('click', () => setLed({ effect: b.dataset.fx }, true)));
    $('#ledDemo').addEventListener('click', () => { led.demo = { t0: performance.now() }; led.step = -1; });
    $('#ledBtn').addEventListener('click', () => { const p = $('#ledPanel'); if (p.hidden) openPanel('ledPanel'); else { p.hidden = true; $('#ledBtn').setAttribute('aria-expanded', 'false'); } });
    $$('[data-open]').forEach(b => b.addEventListener('click', () => openPanel(b.dataset.open)));
    syncLed();
  }
  /** 每帧：演示序列推进；把灯色写到模型的自发光和光晕上 */
  function updateLed(now) {
    if (led.demo) {
      const i = G1Led.stepAt((now - led.demo.t0) / 1000);
      if (i < 0) { led.demo = null; led.step = -1; ledStepEl.textContent = '演示结束。'; setLed({ rgb: G1Led.STATES.off.rgb, effect: 'solid' }); }
      else if (i !== led.step) {
        led.step = i; const d = G1Led.DEMO[i], sttt = G1Led.STATES[d.state];
        led.rgb = sttt.rgb.slice(); led.effect = sttt.effect; syncLed();
        ledStepEl.innerHTML = ''; ledStepEl.append(`${i + 1}/${G1Led.DEMO.length}　${d.text}`);
        if (d.why) { const sm = document.createElement('small'); sm.textContent = d.why; ledStepEl.appendChild(sm); }
      }
    }
    if (!g1 || !g1.led) return null;
    const lv = G1Led.levelAt(led.effect, now / 1000), c = led.rgb.map(v => v / 255 * lv), any = c.some(v => v > 0.001), nd = g1.led.node, w = nd.world, k = g1.led.center;
    nd.emissive = any ? c.map(v => Math.min(1, v * 1.2)) : null;
    nd.color = any ? c.map(v => 0.06 + v * 0.35) : [0.13, 0.13, 0.15];
    return { pos: [w[0] * k[0] + w[4] * k[1] + w[8] * k[2] + w[12], w[1] * k[0] + w[5] * k[1] + w[9] * k[2] + w[13], w[2] * k[0] + w[6] * k[1] + w[10] * k[2] + w[14]], col: c.map(v => v * 0.9) };
  }

  /* ---------------- 渲染循环 ---------------- */
  let prev = performance.now(), t0 = prev, visible = true;
  document.addEventListener('visibilitychange', () => { visible = !document.hidden; prev = performance.now(); });

  function frame(now) {
    requestAnimationFrame(frame);
    if (!st || !visible) return;
    const dt = Math.min(0.05, (now - prev) / 1000); prev = now; if (now > freezeUntil) animT += dt; const t = animT;
    const chc = CHAPTERS[S.ch] || CHAPTERS[0];

    // 镜头：章节内保持，靠近边界时混合
    const k = Math.round(S.u), d = S.u - k, Z = 0.14;
    let cam;
    if (Math.abs(d) < Z && k > 0 && k < CHAPTERS.length) cam = blendCam(camFor(CHAPTERS[k - 1].cam), camFor(CHAPTERS[k].cam), smooth(clamp((d + Z) / (2 * Z), 0, 1)));
    else cam = camFor(CHAPTERS[clamp(k, 0, CHAPTERS.length - 1)].cam);
    if (!reduce) cam.az += Math.sin(S.p * Math.PI) * 0.12;
    const kO = 1 - Math.exp(-8 * dt);
    if (!(drag && drag.moved)) { orbit.az += (orbit.taz - orbit.az) * kO; orbit.el += (orbit.tel - orbit.el) * kO; }
    orbit.zoom += (orbit.tzoom - orbit.zoom) * kO;
    cam.az += orbit.az; cam.el = clamp(cam.el + orbit.el, -0.12, 1.3); cam.dist *= orbit.zoom;
    Object.assign(st.camera, cam);

    // 讲解员
    if (override && performance.now() > override.until) override = null;
    if (g1) {
      const target = G1Poses.poseFor(override ? override.id : gesture, reduce ? 0 : t);
      if (!reduce) target.waist_pitch_joint = 0.025 * Math.sin(t * 1.3);
      G1Poses.approach(cur, target, dt, 5.5);
      g1.set(Object.assign({}, cur, manual));
    }
    if (nova) nova.set(Object.assign(novaPose(S.p + S.ch * 0.3, t), manual));

    // 哪些模型在主视口
    const wantNova = chc.main === 'nova' && nova, wantG1 = chc.main === 'g1' && g1;
    const roots = [];
    if (wantNova) { nova.root.tint = chc.dim ? { c: [0.05, 0.06, 0.09], k: 0.62 } : null; roots.push(nova.root); }
    if (wantG1) roots.push(g1.root);
    st.shadows.length = 0;
    if (wantG1) st.shadows.push({ c: [0, 0], r: 0.55 });
    if (wantNova) st.shadows.push({ c: [0, 0], r: 0.95 });
    curRoots = roots; curPip = !!(chc.pip && g1 && innerWidth >= (chc.pipMinW || 0));
    const glow = updateLed(performance.now()) || undefined;
    st.render({ roots, glow: wantG1 ? glow : undefined });
    if (sel && now - inspT > 200) { inspT = now; syncSlider(false); }
    if (chc.pip && g1 && innerWidth >= (chc.pipMinW || 0)) st.render({ roots: [g1.root], camera: PIP_CAM, viewport: pipRect(), clearColor: false, grid: false, glow });
  }

  /* ---------------- 章节导航、卡片出现、当前节 ---------------- */
  const io = new IntersectionObserver(es => es.forEach(e => e.target.classList.toggle('in', e.isIntersecting)), { threshold: 0.25 });
  beats.forEach(b => io.observe(b));
  let ticking = false;
  function onScroll() {
    if (ticking) return; ticking = true;
    requestAnimationFrame(() => {
      ticking = false; computeScroll();
      if (S.ch !== lastCh) { lastCh = S.ch; resetOrbit(); }
      $$('.dots a').forEach(a => a.classList.toggle('on', +a.dataset.go === S.ch));
      if (S.beat && S.beat !== lastBeat) {
        lastBeat = S.beat;
        if (!override) setGesture(S.beat.dataset.gesture || 'idle', S.beat.dataset.say || '');
      }
    });
  }
  addEventListener('scroll', onScroll, { passive: true }); addEventListener('resize', onScroll);

  $('#voice').addEventListener('click', e => {
    voiceOn = !voiceOn; e.currentTarget.setAttribute('aria-pressed', String(voiceOn)); e.currentTarget.textContent = voiceOn ? '🔊 朗读' : '🔇 朗读';
    if (voiceOn && hudSay.textContent) speak(hudSay.textContent); else try { speechSynthesis.cancel(); } catch (_) { /* 忽略 */ }
  });

  /* ---------------- 矩阵 ---------------- */
  (function buildMatrix() {
    const tb = $('#matrix tbody'); if (!tb) return;
    MATRIX.forEach((r, i) => {
      const tr = document.createElement('tr'); tr.className = 'row'; tr.dataset.s = r.s; tr.tabIndex = 0; tr.setAttribute('aria-expanded', 'false');
      tr.innerHTML = `<td class="plat"></td><td><span class="st st-${r.s}"></span></td><td></td>`;
      tr.children[0].textContent = r.p; tr.querySelector('.st').textContent = r.pill; tr.children[2].textContent = r.ev;
      const more = document.createElement('tr'); more.className = 'more'; more.hidden = true; more.dataset.s = r.s;
      more.innerHTML = '<td colspan="3"><div></div></td>'; more.querySelector('div').textContent = '尚未完成：' + r.todo;
      const toggle = () => { more.hidden = !more.hidden; tr.setAttribute('aria-expanded', String(!more.hidden)); };
      tr.addEventListener('click', toggle); tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      tb.append(tr, more);
    });
    const n = k => MATRIX.filter(r => r.s === k).length;
    $('#matrixSummary').textContent = `${MATRIX.length} 个案例：${n('ok')} 通过 · ${n('part')} 部分 · ${n('fail')} 未通过 · ${n('todo')} 待补`;
    $$('#matrixFilters button').forEach(b => b.addEventListener('click', () => {
      $$('#matrixFilters button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      const f = b.dataset.f;
      $$('#matrix tbody tr').forEach(tr => { const show = f === 'all' || tr.dataset.s === f; tr.style.display = show ? '' : 'none'; if (tr.classList.contains('more') && !show) tr.hidden = true; });
    }));
  })();

  /* ---------------- 启动 ---------------- */
  computeScroll(); onScroll();
  setGesture('wave', $('.beat').dataset.say || '');
  buildLight(); buildLed();
  loadModels().finally(() => { indexJoints(); $('#loading').classList.add('done'); });
  requestAnimationFrame(frame);

  // 供本地测试使用
  window.__story = { get state() { return { ch: S.ch, p: S.p, gesture, nova: !!nova, g1: !!g1, sel: sel && { model: sel.model, name: sel.name, label: sel.label }, manual: Object.assign({}, manual), light: st && Object.assign({}, st.light), orbit: Object.assign({}, orbit) }; }, MATRIX, pickAt, select, led, setLed, orbit };
})();
