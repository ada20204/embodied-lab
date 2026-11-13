/* Nova 拍摄 Studio：一份镜头脚本 → 摄影机画面 + 机械臂小窗 + 两条轨道 + 拍摄表。
 * 人只改脚本（面板上的滑块改的也是脚本）；稳帧、逆解、可达性、放慢倍数、出图都是自动的。
 * 录制用 window.__reel.shot(i, n) 逐帧出图，和实时预览同一条路径。 */
(function () {
  'use strict';
  const $ = s => document.querySelector(s), el = (tag, props, kids) => { const e = document.createElement(tag); Object.assign(e, props || {}); (kids || []).forEach(k => e.append(k)); return e; };
  const Q = new URLSearchParams(location.search), SS = window.StudioScript;
  const W = 1280, H = 720, FPS = 30, SHUTTER = 0.8 / FPS;
  const SCRIPTS = ['duck-arm', 'car-arm', 'product-arm', 'duck-free'];
  const out = $('#out'), ctx = out.getContext('2d'), glc = $('#gl'), msg = $('#msg');
  const stOpt = { pixelRatio: 1, bg: [0.035, 0.04, 0.05] }, st = window.Stage3D.create(glc, stOpt);   // 导出高分辨率时临时调大 pixelRatio
  const S = { t: 0, playing: false, lock: Q.get('lock') !== '0', blur: Q.get('blur') !== '0', hud: Q.get('hud') !== '0', pip: Q.get('pip') !== '0', snd: false, samples: +Q.get('samples') || 5, sel: 0, end: 0, view: Q.get('view') === 'free' ? 'free' : 'cam', name: SCRIPTS.includes(Q.get('script')) ? Q.get('script') : SCRIPTS[0] };
  const examples = {}, clips = {}, clipDur = {};
  let script = null, C = null, tl = null, bts = [], plan = null, duck = null, product = null, car = null, nova = null;
  const ev = { cam: {} }, mo = G1Motion.makeOut(), pose = {}, anchor = G1Motion.makeOut(), _ro = G1Motion.makeOut();
  const cam = { target: [0, 0, 0.13], dist: 1, az: 0, el: 0.2, fov: 30, roll: 0 };
  const DUCK_CLIPS = G1Motion.DUCK_CLIPS.map(c => c.id), CLIP_NAME = Object.fromEntries(G1Motion.DUCK_CLIPS.map(c => [c.id, c.name]));

  const getJson = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
  const getBuf = u => fetch(u).then(r => { if (!r.ok) throw new Error(u + ' ' + r.status); return r.arrayBuffer(); });
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 存不了就算了 */ } }, del(k) { try { localStorage.removeItem(k); } catch (e) { /* 同上 */ } } };

  async function load() {
    if (!st) throw new Error('这个浏览器不支持 WebGL2');
    const [spec, buf] = await Promise.all([getJson('../assets/duck/duck.json'), getBuf('../assets/duck/duck' + (Q.get('lod') === 'lo' ? '_lo' : '') + '.glb')]);
    duck = G1Model.build(st, Stage3D.parseGLB(buf), spec);
    await Promise.all(DUCK_CLIPS.map(async id => { clips[id] = G1Motion.fromJson(await getJson(`../assets/duck/motions/${id}.json`)); clipDur[id] = G1Motion.duration(clips[id]); }));
    await Promise.all(SCRIPTS.map(async n => { examples[n] = await getJson(`scripts/${n}.json`); }));
    buildArm(); buildProduct(); buildCar();
  }
  // 真实的 Nova 5 外形：后台加载，到了就替换掉胶囊体（模型里是双臂，只用左臂；夹爪是占位几何，不显示）
  const NOVA_MAP = { s: [1, -1, -1, -1, 1, -1], o: [0, -Math.PI / 2, 0, -Math.PI / 2, 0, 0] };   // 运动学关节角 → 模型关节角（数值标定，法兰位置误差 < 1 mm）
  async function loadNova() {
    try {
      const [spec, buf] = await Promise.all([getJson('../assets/nova/nova5_joints.json'), getBuf('../assets/nova/nova5.glb')]);
      const r = st.instantiate(Stage3D.parseGLB(buf), {}), B = r.byName, AX = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
      ['L_gripper_base', 'L_gripper_finger_left', 'L_gripper_finger_right'].forEach(k => { if (B[k]) B[k].visible = false; });
      const J = [1, 2, 3, 4, 5, 6].map(i => { const n = B['L_J' + i], sp = spec.joints.find(j => j.name === 'L_J' + i); n.axis = AX[sp.axis]; n.angle = 0; return n; });
      if (!B.L_BASE || J.some(n => !n)) throw new Error('模型里找不到左臂');
      nova = { base: B.L_BASE, J };
      armRoot.children.push(B.L_BASE);
      armParts.parts.forEach((P3, i) => { if (i <= 5) P3.c.visible = P3.a.visible = P3.b.visible = false; });
    } catch (e) { nova = null; }   // 没有这个文件就继续用简化外形
  }
  const rootAt = (clip, s) => { G1Motion.sample(clips[clip], s, _ro); return [_ro.pos[0], _ro.pos[1], _ro.pos[2]]; };

  // ---- 程序化外形：机械臂（按运动学里的胶囊体）和静物（一只瓶子）----
  let armRoot = null, armParts = null, lensW = null;
  function unitMesh(kind) {
    const N = 28, pos = [], nrm = [], idx = [];
    if (kind === 'cyl') {
      for (let i = 0; i < N; i++) { const a = i / N * 6.2832, c = Math.cos(a), s2 = Math.sin(a); pos.push(c, s2, 0, c, s2, 1); nrm.push(c, s2, 0, c, s2, 0); const j = (i + 1) % N; idx.push(i * 2, j * 2, i * 2 + 1, j * 2, j * 2 + 1, i * 2 + 1); }
      for (const z of [0, 1]) { const c0 = pos.length / 3; pos.push(0, 0, z); nrm.push(0, 0, z ? 1 : -1); for (let i = 0; i < N; i++) { const a = i / N * 6.2832; pos.push(Math.cos(a), Math.sin(a), z); nrm.push(0, 0, z ? 1 : -1); } for (let i = 0; i < N; i++) { const j = (i + 1) % N; if (z) idx.push(c0, c0 + 1 + i, c0 + 1 + j); else idx.push(c0, c0 + 1 + j, c0 + 1 + i); } }
    } else if (kind === 'box') {
      for (const [ax, sg] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
        const u = (ax + 1) % 3, v = (ax + 2) % 3, c0 = pos.length / 3, n = [0, 0, 0]; n[ax] = sg;
        for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const p = [0, 0, 0]; p[ax] = sg * 0.5; p[u] = a * 0.5; p[v] = b * 0.5 * sg; pos.push(...p); nrm.push(...n); }
        idx.push(c0, c0 + 1, c0 + 2, c0, c0 + 2, c0 + 3);
      }
    } else {
      const R = 14;
      for (let r = 0; r <= R; r++) for (let i = 0; i <= N; i++) { const th = r / R * Math.PI, a = i / N * 6.2832, x = Math.sin(th) * Math.cos(a), y = Math.sin(th) * Math.sin(a), z = Math.cos(th); pos.push(x, y, z); nrm.push(x, y, z); }
      for (let r = 0; r < R; r++) for (let i = 0; i < N; i++) { const a = r * (N + 1) + i, b = a + N + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
    }
    const m = { name: kind, prims: [{ pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: Uint32Array.from(idx), color: [0.8, 0.8, 0.8] }] };
    st.uploadMesh(m); return m;
  }
  let CYL, SPH, BOX;
  function setSeg(node, a, b, r) {   // 单位圆柱（半径 1、沿 +Z 长 1）→ 从 a 到 b、半径 r
    let d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const L = Math.hypot(d[0], d[1], d[2]) || 1e-6; d = d.map(v => v / L);
    let x = Math.abs(d[2]) < 0.9 ? [d[1], -d[0], 0] : [0, d[2], -d[1]]; const xl = Math.hypot(x[0], x[1], x[2]); x = x.map(v => v / xl);
    const y = [d[1] * x[2] - d[2] * x[1], d[2] * x[0] - d[0] * x[2], d[0] * x[1] - d[1] * x[0]];
    node.base = new Float32Array([x[0] * r, x[1] * r, x[2] * r, 0, y[0] * r, y[1] * r, y[2] * r, 0, d[0] * L, d[1] * L, d[2] * L, 0, a[0], a[1], a[2], 1]);
  }
  const setBall = (node, p, r, rz) => { node.base = new Float32Array([r, 0, 0, 0, 0, r, 0, 0, 0, 0, rz || r, 0, p[0], p[1], p[2], 1]); };
  function buildArm() {
    CYL = unitMesh('cyl'); SPH = unitMesh('sph');
    const parts = [], kids = [], WHITE = [0.86, 0.87, 0.89], DARK = [0.16, 0.17, 0.2], BLUE = [0.2, 0.42, 0.85];
    const mk = (mesh, color) => { const n = st.node({ name: 'arm', meshes: [mesh], color }); kids.push(n); return n; };
    for (let i = 0; i < 8; i++) { const col = i === 0 ? DARK : i <= 5 ? WHITE : DARK; parts.push({ c: mk(CYL, col), a: mk(SPH, i >= 1 && i <= 5 ? BLUE : col), b: mk(SPH, col) }); }
    const ped = mk(CYL, [0.22, 0.24, 0.28]);
    armRoot = st.node({ name: 'armRoot', children: kids }); armParts = { parts, ped };
  }
  function buildProduct() {   // 香水瓶的大致样子：瓶身、瓶肩、瓶颈、瓶盖
    const kids = [], mk = (mesh, color, f) => { const n = st.node({ name: 'product', meshes: [mesh], color }); f(n); kids.push(n); };
    mk(CYL, [0.78, 0.5, 0.2], n => setSeg(n, [0, 0, 0.004], [0, 0, 0.115], 0.04));
    mk(SPH, [0.78, 0.5, 0.2], n => setBall(n, [0, 0, 0.115], 0.04, 0.018));
    mk(SPH, [0.62, 0.38, 0.14], n => setBall(n, [0, 0, 0.004], 0.04, 0.004));
    mk(CYL, [0.85, 0.72, 0.4], n => setSeg(n, [0, 0, 0.125], [0, 0, 0.142], 0.014));
    mk(CYL, [0.12, 0.12, 0.14], n => setSeg(n, [0, 0, 0.14], [0, 0, 0.175], 0.021));
    mk(SPH, [0.12, 0.12, 0.14], n => setBall(n, [0, 0, 0.175], 0.021, 0.006));
    product = { root: st.node({ name: 'productRoot', children: kids }) };
  }
  // ---- 导入的模型（只放内存，刷新就没了；脚本里只记文件名、指纹和尺寸） ----
  const models = new Map();   // 指纹 → { node, meshes, name, tris, before }
  let placeholder = null;
  function customRoot() {
    const m = models.get(C.subject.hash);
    if (m) return m.node;
    if (!placeholder) placeholder = { root: st.node({ name: 'placeholder', meshes: [BOX], color: [0.42, 0.46, 0.52] }) };
    return placeholder.root;
  }
  function placeCustom() {   // 主体在原点，绕竖轴转 yaw；导入的模型再乘上摆正矩阵
    const cy = Math.cos(C.subject.yaw), sy = Math.sin(C.subject.yaw), Rz = new Float32Array([cy, sy, 0, 0, -sy, cy, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), m = models.get(C.subject.hash);
    if (m) {
      const key = C.subject.up + ':' + C.subject.dims[0];   // 摆正矩阵要扫一遍顶点，只在长度或上方改了时重算
      if (m.key !== key) { m.key = key; m.M = StudioModel.normalize(m.parsed, C.subject.up, C.subject.dims[0]).M; }
      m.node.base = Stage3D.M4.mul(Rz, m.M);
    } else {
      const [L, Wd, H] = C.subject.dims;
      placeholder.root.base = Stage3D.M4.mul(Rz, new Float32Array([L, 0, 0, 0, 0, Wd, 0, 0, 0, 0, H, 0, 0, 0, H / 2, 1]));
    }
  }
  const MAX_TRIS = 400000;
  /** 读一个 glb：检查、抽稀、上传，返回要写进脚本的主体字段。不改脚本 */
  async function importModel(file, say) {
    if (!/\.glb$/i.test(file.name)) throw new Error('只支持 .glb（二进制 glTF）。.gltf + 贴图文件夹、.fbx、.obj 请先在 Blender 里导出成 glb。');
    say(`正在读 ${file.name}（${(file.size / 1048576).toFixed(1)} MB）……`); await new Promise(r => setTimeout(r, 0));
    const buf = await file.arrayBuffer(), hash = await StudioModel.fingerprint(buf);
    let m = models.get(hash);
    if (!m) {
      const parsed = Stage3D.parseGLB(buf), why = StudioModel.unsupported(parsed.json); if (why) throw new Error(why);
      say('正在整理网格……'); await new Promise(r => setTimeout(r, 0));
      const d = StudioModel.decimate(parsed, MAX_TRIS);
      const node = st.instantiate(parsed, {});
      m = { node, parsed, name: file.name, tris: d.after, before: d.before, hasTex: !!(parsed.json.textures && parsed.json.textures.length) };
      models.set(hash, m);
    }
    const up = 'y', raw = StudioModel.normalize(m.parsed, up, 0).raw;
    // 初始长度：模型自己的单位看起来像米（0.05–1.2）就照用，否则先按 0.3 m 放，再请用户填实际长度
    const L = raw[0] >= 0.05 && raw[0] <= 1.2 ? raw[0] : 0.3, k = L / raw[0];
    return { model: m, subject: { type: 'custom', name: file.name, hash, up, dims: raw.map(v => +(v * k).toFixed(4)), yaw: 0 }, guessed: L !== raw[0], raw };
  }
  async function loadModelFile(file) {
    const say = t => { const e = $('#mdlInfo'); if (e) e.textContent = t; setStatus('free', t); };
    try {
      const r = await importModel(file, say), n = SS.clone(script);
      n.subject = r.subject;
      const errs = applyScript(n); if (errs.length) throw new Error(errs[0]);
      $('#tab-rig').click();
      const m = r.model, notes = [`已导入 ${m.name}`, m.before > m.tris ? `面数 ${(m.before / 1e4).toFixed(0)} 万 → 抽稀到 ${(m.tris / 1e4).toFixed(0)} 万` : `${(m.tris / 1e4).toFixed(1)} 万面`];
      if (r.guessed) notes.push('文件里的单位看不出实际大小，先按 0.3 m 长摆着：请在下面填实际长度');
      if (m.hasTex) notes.push('模型带贴图，现在只显示材质的基础色');
      say(notes.join('；') + '。');
    } catch (e) { say('没有导入：' + e.message); }
  }

  // 方程式赛车：程序化拼出来的通用开轮赛车外形（1:12，长约 0.46 m，车头朝 +x），不是任何一台真实赛车的复刻
  function buildCar() {
    BOX = unitMesh('box');
    const kids = [], BODY = [0.07, 0.11, 0.2], ACC = [1, 0.42, 0.08], CARBON = [0.05, 0.055, 0.065], TYRE = [0.03, 0.03, 0.035], RIM = [0.62, 0.64, 0.68], WHITE = [0.9, 0.91, 0.93];
    const add = (mesh, color, f) => { const n = st.node({ name: 'car', meshes: [mesh], color }); f(n); kids.push(n); };
    const ell = (p, r, c) => add(SPH, c, n => { n.base = new Float32Array([r[0], 0, 0, 0, 0, r[1], 0, 0, 0, 0, r[2], 0, p[0], p[1], p[2], 1]); });
    const box = (p, s, c) => add(BOX, c, n => { n.base = new Float32Array([s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, p[0], p[1], p[2], 1]); });
    const rod = (a, b, r, c) => add(CYL, c, n => setSeg(n, a, b, r));
    box([0, 0, 0.011], [0.31, 0.1, 0.006], CARBON);                                   // 底板
    ell([0.02, 0, 0.034], [0.175, 0.034, 0.022], BODY);                               // 单体壳
    ell([0.155, 0, 0.03], [0.085, 0.017, 0.013], BODY); ell([0.228, 0, 0.026], [0.014, 0.012, 0.008], ACC);   // 鼻锥
    for (const s of [1, -1]) { ell([-0.045, s * 0.05, 0.03], [0.09, 0.026, 0.02], BODY); ell([0.035, s * 0.052, 0.033], [0.012, 0.017, 0.013], CARBON); box([-0.05, s * 0.074, 0.033], [0.1, 0.002, 0.012], ACC); }   // 侧箱、进气口、侧面色带
    ell([-0.1, 0, 0.044], [0.105, 0.021, 0.03], BODY); ell([-0.03, 0, 0.076], [0.03, 0.013, 0.013], CARBON); box([-0.13, 0, 0.066], [0.1, 0.003, 0.03], BODY);   // 引擎盖、进气箱、鲨鱼鳍
    ell([0.012, 0, 0.052], [0.036, 0.017, 0.008], CARBON); ell([0.004, 0, 0.06], [0.013, 0.012, 0.012], ACC);   // 座舱、头盔
    rod([0.05, 0, 0.05], [0.036, 0, 0.071], 0.003, CARBON); for (const s of [1, -1]) rod([0.036, 0, 0.071], [-0.026, s * 0.023, 0.066], 0.003, CARBON);   // Halo
    box([0.215, 0, 0.011], [0.036, 0.165, 0.004], WHITE); box([0.204, 0, 0.019], [0.022, 0.15, 0.003], ACC);   // 前翼
    for (const s of [1, -1]) { box([0.213, s * 0.082, 0.02], [0.046, 0.003, 0.022], BODY); box([-0.215, s * 0.044, 0.056], [0.05, 0.003, 0.056], BODY); }   // 前后翼端板
    box([-0.215, 0, 0.08], [0.032, 0.086, 0.004], WHITE); box([-0.218, 0, 0.067], [0.024, 0.086, 0.003], ACC); rod([-0.2, 0, 0.03], [-0.212, 0, 0.066], 0.003, CARBON);   // 尾翼
    box([-0.2, 0, 0.022], [0.05, 0.075, 0.012], CARBON);                              // 扩散器
    for (const [x, r, w0] of [[0.15, 0.028, 0.057], [-0.15, 0.029, 0.05]]) for (const s of [1, -1]) {   // 车轮和悬挂
      rod([x, s * w0, r], [x, s * 0.083, r], r, TYRE); rod([x, s * (w0 - 0.001), r], [x, s * 0.0838, r], r * 0.52, RIM); rod([x, s * (w0 - 0.0015), r], [x, s * 0.0845, r], r * 0.16, ACC);
      for (const dx of [0.03, -0.03]) { rod([x + dx * (x > 0 ? 1 : 0.6), 0, 0.04], [x, s * w0, r + 0.012], 0.0018, CARBON); rod([x + dx * (x > 0 ? 1 : 0.6), 0, 0.022], [x, s * w0, r - 0.012], 0.0018, CARBON); }
    }
    car = { root: st.node({ name: 'carRoot', children: kids }) };
  }
  const _q = new Array(6), pipCam = { target: [0, 0, 0.3], dist: 2.0, az: -2.5, el: 0.4, fov: 30 }, PIP = [0.69, 0.035, 0.29, 0.36];
  const _ev2 = { cam: {} }, RED = { c: [1, 0.2, 0.16], k: 0.78 }, freeCam = { target: [0, 0, 0.28], dist: 2.5, az: -2.45, el: 0.42, fov: 32 }; let armNow = null, freeKey = '';
  function poseArm(t, subjW) {
    const b = plan.opt.base, F = KIN.fk(ReelArm.qAt(plan, t, _q), [0, 0]), Cp = KIN.capsules(F), Wd = p => [p[0] + b[0], p[1] + b[1], p[2] + b[2]];
    [{ a: [0, 0, 0], b: KIN.P(F[1]), r: 0.062 }].concat(Cp).forEach((c, i) => { const P3 = armParts.parts[i], A = Wd(c.a), B = Wd(c.b); setSeg(P3.c, A, B, c.r); setBall(P3.a, A, c.r * (i >= 1 && i <= 5 ? 1.12 : 1)); setBall(P3.b, B, c.r); });
    setSeg(armParts.ped, [b[0], b[1], 0], [b[0], b[1], Math.max(b[2], 0.01)], 0.11);
    lensW = Wd(KIN.P(F[7]));
    if (nova) { nova.base.base = new Float32Array([0.001, 0, 0, 0, 0, 0.001, 0, 0, 0, 0, 0.001, 0, b[0], b[1], b[2], 1]); nova.J.forEach((n, j) => { n.angle = NOVA_MAP.s[j] * _q[j] + NOVA_MAP.o[j]; }); }
    // 干涉：碰到东西的那几段标红（和规划时用的是同一个检测函数）
    const e = Reel.evalAt(tl, t, _ev2), fl = plan.shots[e.seg.base].flags[Math.round(Math.min(Math.max(e.p, 0), 1) * ReelArm.M)];
    const col = ReelArm.collide(F, [subjW[0] - b[0], subjW[1] - b[1], subjW[2] - b[2]], plan.opt);
    armParts.parts.forEach((P3, i) => { const hit = i >= 1 && (col.mask >> (i - 1) & 1) ? RED : null; P3.c.tintSelf = P3.a.tintSelf = P3.b.tintSelf = hit; if (nova && i >= 1 && i <= 5) nova.J[i].tintSelf = hit; });
    armNow = { flag: fl, hits: col.hits, clr: col.clr };
  }
  function resetFree() {
    const b = plan ? plan.opt.base : null;
    Object.assign(freeCam, b ? { target: [b[0] / 2, b[1] / 2, 0.28], dist: 2.5, az: -2.45, el: 0.42 } : { target: [0, 0, 0.14], dist: 1.9, az: 0.9, el: 0.5 });
  }
  // 自由镜头没有机械臂方案，镜头路径自己算一遍
  const _paths = new WeakMap();
  function eyePath(seg) {
    let p = _paths.get(seg); if (p) return p; p = []; const c = seg.cam, N = 48;
    for (let i = 0; i <= N; i++) { const u = i / N, L = k => c[k] ? c[k][0] + (c[k][1] - c[k][0]) * u : 0, r = seg.clip ? rootAt(seg.clip, seg.s0 + (seg.s1 - seg.s0) * u) : [0, 0, 0]; p.push(Reel.eyeUp({ az: L('az'), el: L('el'), dist: L('dist'), roll: L('roll') }, [r[0], r[1], r[2] + C.subject.lookUp]).eye); }
    _paths.set(seg, p); return p;
  }

  // ---- 脚本 → 时间轴 → 机械臂方案 ----
  function applyScript(next, opts) {
    opts = opts || {};
    let c;
    try { c = SS.compile(next, clipDur); } catch (e) { return e.issues || [e.message]; }
    if (script && !opts.noHistory && !opts.fromEdit) pushHistory(script);
    if (opts.sel != null) S.sel = opts.sel;
    script = next; C = c;
    tl = Reel.build(C.shots, C.bpm, { attack: C.attack }); bts = Reel.beats(tl);
    plan = C.rig.arm ? ReelArm.plan(tl, rootAt, { base: C.rig.base, mount: C.rig.mount, lookUp: C.subject.lookUp, subjectR: C.subject.radius, subjectHalf: C.subject.half || 0, subjectYaw: C.subject.yaw || 0 }) : null;
    S.sel = Math.min(S.sel, script.shots.length - 1); S.t = Math.min(S.t, tl.dur);
    const fk = S.name + '|' + (plan ? plan.opt.base.join(',') : 'free'); if (fk !== freeKey) { freeKey = fk; resetFree(); }
    if (!opts.keepCode) $('#code').value = SS.stringify(script);
    if (!opts.noStore) store.set('studio.' + S.name, JSON.stringify(script));
    $('#codeErrs').textContent = '';
    renderTracks(); if (!opts.keepPanel) renderShotPane(); else refreshShotStatus(); renderRigPane(opts.keepPanel); renderTakes();
    $('#sub').textContent = script.note || '';
    return [];
  }
  let pending = null;
  const later = (fn) => { clearTimeout(pending); pending = setTimeout(fn, 140); };   // 拖滑块时别每一下都重算逆解
  // ---- 撤销：每次改动前把旧脚本记下来；连续拖同一个滑块只记一次 ----
  const history = []; let editOpen = false, editTimer = null, drag = null;
  function pushHistory(sc) { history.push({ name: S.name, text: JSON.stringify(sc), sel: S.sel }); if (history.length > 60) history.shift(); $('#undo').disabled = false; }
  function undo() {
    const h = history.pop(); if (!h) return; $('#undo').disabled = !history.length;
    clearTimeout(pending); editOpen = false;
    if (h.name !== S.name) { S.name = h.name; pick.value = h.name; }
    S.sel = h.sel; const errs = applyScript(JSON.parse(h.text), { noHistory: true }); if (!errs.length) seek(tl.segs[S.sel].t0 + 1e-4);
  }
  function edit(mut, seek) {
    const n = SS.clone(script); mut(n);
    const errs = SS.validate(n, clipDur); if (errs.length) { setStatus('bad', errs[0]); return; }
    if (!editOpen) { pushHistory(script); editOpen = true; }
    clearTimeout(editTimer); editTimer = setTimeout(() => { if (!drag) editOpen = false; }, 900);   // 一次拖动算一步
    script = n; $('#code').value = SS.stringify(script);
    later(() => { applyScript(script, { keepPanel: true, fromEdit: true }); if (seek) seek(); });
  }
  function shotStatus(i) {
    if (!plan) return { st: 'free', text: '自由镜头：不受机械臂限制，也没有检查能不能拍' };
    const b = tl.segs[i].base, k = plan.takes.find(x => x.seg === b);
    if (!k.ok) return { st: 'bad', text: '机械臂拍不了：' + k.issues.join('；') };
    const base = `机械臂可达 · 最小间隙 ${(k.minClr * 100).toFixed(1)} cm · 真机放慢 ${k.slow.toFixed(1)}× 拍`;
    return k.warn.length ? { st: 'warn', text: base + ' · ' + k.warn.join('；') } : { st: 'ok', text: base };
  }

  // ---- 画面 ----
  function drawScene(t) {
    Reel.evalAt(tl, t, ev);
    const isDuck = C.subject.type === 'duck'; let sx = 0, sy = 0, sz = 0;
    if (isDuck) {
      const clip = clips[ev.clip]; G1Motion.sample(clip, ev.s, mo);
      duck.root.base = Stage3D.M4.fromQT(mo.quat, mo.pos); duck.set(G1Motion.toPose(mo.q, pose, clip.joints));
      sx = mo.pos[0]; sy = mo.pos[1]; sz = mo.pos[2];
    }
    let tx = sx, ty = sy, tz = sz;
    if (isDuck && !S.lock) { G1Motion.sample(clips[ev.clip], ev.seg.s0, anchor); tx = anchor.pos[0]; ty = anchor.pos[1]; tz = anchor.pos[2]; }   // 不稳帧：盯着这段开始时的位置
    cam.target[0] = tx; cam.target[1] = ty; cam.target[2] = tz + C.subject.lookUp;
    cam.az = ev.cam.az; cam.el = ev.cam.el; cam.dist = ev.cam.dist; cam.fov = ev.cam.fov; cam.roll = ev.cam.roll;
    st.light.az = (cam.az - Math.PI / 2) * 180 / Math.PI - 42; st.light.el = 44; st.light.rim = 1.5; st.light.spec = 1.4;
    const isCar = C.subject.type === 'car', isCustom = C.subject.type === 'custom', subj = isDuck ? duck.root : isCar ? car.root : isCustom ? customRoot() : product.root;
    if (isCustom) placeCustom();
    if (isCar) { const cy = Math.cos(C.subject.yaw), sy2 = Math.sin(C.subject.yaw); car.root.base = new Float32Array([cy, sy2, 0, 0, -sy2, cy, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
    st.shadows.length = 0; st.shadows.push({ c: [sx, sy], r: isDuck ? 0.14 : isCar ? 0.24 : isCustom ? Math.max(C.subject.dims[0], C.subject.dims[1]) * 0.55 : 0.09 });
    if (plan) poseArm(t, [sx, sy, sz + C.subject.lookUp]); else armNow = null;
    if (S.view === 'free') {   // 自由视角：主画面是站在旁边看整个场景，小窗才是摄影机拍到的
      const la = st.light.az;
      st.light.az = (freeCam.az - Math.PI / 2) * 180 / Math.PI - 42; if (plan) st.shadows.push({ c: [plan.opt.base[0], plan.opt.base[1]], r: 0.3 });
      st.render({ roots: plan ? [subj, armRoot] : [subj], camera: freeCam, gridCenter: [freeCam.target[0], freeCam.target[1]], gridScale: 0.6, gridColor: [0.45, 0.55, 0.68] });
      st.light.az = la; st.shadows.length = 1;
      if (S.pip) st.render({ roots: [subj], camera: cam, viewport: PIP, gridCenter: [sx, sy], gridScale: 0.4, gridColor: [0.55, 0.66, 0.80] });
      return;
    }
    st.render({ roots: [subj], camera: cam, gridCenter: [sx, sy], gridScale: 0.4, gridColor: [0.55, 0.66, 0.80] });
    if (S.pip) {   // 小窗：站在旁边看现场。有机械臂就把它也框进来；自由镜头只有主体，机位路径和视锥在叠加层里画
      if (plan) { const b = plan.opt.base; pipCam.target[0] = (b[0] + sx) / 2; pipCam.target[1] = (b[1] + sy) / 2; pipCam.target[2] = 0.3; pipCam.dist = 2.0; st.shadows.push({ c: [b[0], b[1]], r: 0.3 }); }
      else {   // 自由镜头：把这个镜头的整条机位路径和主体一起框进小窗
        const P2 = eyePath(tl.segs[ev.seg.base]), lo = [sx, sy, 0], hi = [sx, sy, sz + 0.25];
        for (const q of P2) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], q[i]); hi[i] = Math.max(hi[i], q[i]); }
        const r = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
        for (let i = 0; i < 3; i++) pipCam.target[i] = (lo[i] + hi[i]) / 2;
        pipCam.dist = Math.max(1.0, r / Math.tan(pipCam.fov * Math.PI / 360) * 1.05);
      }
      st.light.az = -60;
      st.render({ roots: plan ? [subj, armRoot] : [subj], camera: pipCam, viewport: PIP, gridCenter: [pipCam.target[0], pipCam.target[1]], gridScale: 0.6, gridColor: [0.45, 0.55, 0.68] });
    }
  }
  const FONT = '-apple-system, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
  function overlay(t) {
    Reel.evalAt(tl, t, ev);
    if (S.view === 'free') { overlayFree(t); if (S.hud) hudBar(t); return; }
    const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.95);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.55)'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (ev.seg.cut && ev.sinceCut < 0.09) { ctx.fillStyle = `rgba(255,255,255,${0.22 * (1 - ev.sinceCut / 0.09)})`; ctx.fillRect(0, 0, W, H); }
    ctx.textBaseline = 'alphabetic';
    if (S.pip) {   // 小窗：现场全景 + 这个镜头的机位路径和此刻的视锥；有机械臂时再标放慢倍数
      const x = PIP[0] * W, y = PIP[1] * H, w = PIP[2] * W, h = PIP[3] * H, k = plan ? plan.takes.find(q => q.seg === ev.seg.base) : null;
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
      drawRig(projector(pipCam, x, y, w, h), 0.55);
      ctx.restore();
      ctx.strokeStyle = !k || k.ok ? 'rgba(255,255,255,0.35)' : 'rgba(255,133,133,0.9)'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      ctx.font = '600 13px ' + FONT; ctx.fillStyle = 'rgba(232,237,242,0.95)'; ctx.fillText(!plan ? '现场 · 自由镜头（没有机械臂）' : nova ? '现场 · Nova 5 + Pocket 3' : '现场 · Nova 5 + Pocket 3（简化外形）', x + 10, y + 20);
      if (k) { ctx.fillStyle = k.ok ? '#ffb27a' : '#ff8585'; ctx.fillText(k.ok ? `真机放慢 ${k.slow.toFixed(1)}× 拍，成片线性加速` : '这个镜头机械臂拍不了：' + k.issues[0], x + 2, y + h + 20); }
    }
    if (!S.hud) return;
    hudBar(t);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(W / 2 - 9, H / 2); ctx.lineTo(W / 2 + 9, H / 2); ctx.moveTo(W / 2, H / 2 - 9); ctx.lineTo(W / 2, H / 2 + 9); ctx.stroke();
  }
  const projector = (camObj, x, y, w, h) => { const vp = st.viewProj(camObj, w / h); return p => { const Wc = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15]; if (Wc < 0.02) return null; return [x + ((vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12]) / Wc * 0.5 + 0.5) * w, y + (0.5 - (vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13]) / Wc * 0.5) * h]; }; };
  const FLAGTXT = fl => fl & 1 ? '够不着' : fl & 2 ? '关节超出限位' : '';
  // 这个镜头的机位路径（绿 = 拍得了，红 = 够不着 / 超限位 / 干涉，蓝 = 自由镜头不检查）和此刻的视锥；k 是线宽和视锥的缩放
  function drawRig(pr, k) {
    const seg = tl.segs[ev.seg.base], R = plan ? plan.shots[ev.seg.base] : null, path = R ? R.path : eyePath(seg);
    const line = (a, b) => { if (a && b) { ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke(); } };
    ctx.lineWidth = 3 * k; ctx.lineCap = 'round';
    for (let i = 1; i < path.length; i++) { const bad = R && (R.flags[i] || R.flags[i - 1]); ctx.strokeStyle = !R ? 'rgba(124,196,255,0.9)' : bad ? 'rgba(255,110,110,0.95)' : 'rgba(95,208,138,0.9)'; line(pr(path[i - 1]), pr(path[i])); }
    const dot = (p, r, c) => { const q = pr(p); if (q) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, 6.2832); ctx.fill(); } };
    dot(path[0], 5 * k, 'rgba(232,237,242,0.95)'); dot(path[path.length - 1], 5 * k, 'rgba(232,237,242,0.45)');
    // 这一刻的摄影机：视线和视锥
    const eu = Reel.eyeUp(cam, cam.target), E = eu.eye, f = [cam.target[0] - E[0], cam.target[1] - E[1], cam.target[2] - E[2]], fl = Math.hypot(f[0], f[1], f[2]) || 1; f[0] /= fl; f[1] /= fl; f[2] /= fl;
    let r = [f[1] * eu.up[2] - f[2] * eu.up[1], f[2] * eu.up[0] - f[0] * eu.up[2], f[0] * eu.up[1] - f[1] * eu.up[0]]; const rl = Math.hypot(r[0], r[1], r[2]) || 1; r = r.map(v => v / rl);
    const u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]], d = 0.16, th = Math.tan(cam.fov * Math.PI / 360) * d, tw = th * W / H;
    const cs = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => pr([E[0] + f[0] * d + r[0] * tw * a + u[0] * th * b, E[1] + f[1] * d + r[1] * tw * a + u[1] * th * b, E[2] + f[2] * d + r[2] * tw * a + u[2] * th * b])), e0 = pr(E);
    ctx.lineWidth = 1.5 * Math.max(k, 0.7); ctx.strokeStyle = 'rgba(255,122,26,0.95)'; cs.forEach((c, i) => { line(e0, c); line(c, cs[(i + 1) % 4]); });
    ctx.setLineDash([6 * k, 5 * k]); line(e0, pr(cam.target)); ctx.setLineDash([]);
    dot(cam.target, 4 * k, '#ff7a1a');
  }
  function drawEnvelope(pr) {   // 导入模型的碰撞包络（横放胶囊体）：画腰线和两端的竖圈
    const s = C.subject, h = s.half || 0, r = s.radius, cz = s.lookUp, cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
    const P = (x, y, z) => pr([x * cy - y * sy, x * sy + y * cy, z]);
    ctx.strokeStyle = 'rgba(242,193,78,0.75)'; ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]);
    const path = pts => { ctx.beginPath(); let first = true; for (const q of pts) { if (!q) { first = true; continue; } if (first) { ctx.moveTo(q[0], q[1]); first = false; } else ctx.lineTo(q[0], q[1]); } ctx.stroke(); };
    const N = 40, ring = [];
    for (let i = 0; i <= N; i++) { const a = i / N * Math.PI * 2, c = Math.cos(a), si = Math.sin(a); ring.push(c >= 0 ? P(h + r * c, r * si, cz) : P(-h + r * c, r * si, cz)); }
    path(ring);
    for (const x0 of [h, -h]) { const R2 = []; for (let i = 0; i <= N; i++) { const a = i / N * Math.PI * 2; R2.push(P(x0, r * Math.cos(a), cz + r * Math.sin(a))); } path(R2); }
    ctx.setLineDash([]);
  }
  function overlayFree(t) {
    if (C.subject.type === 'custom') drawEnvelope(projector(freeCam, 0, 0, W, H));
    drawRig(projector(freeCam, 0, 0, W, H), 1);
    // 小窗：摄影机拍到的画面
    const x = PIP[0] * W, y = PIP[1] * H, w = PIP[2] * W, h = PIP[3] * H;
    ctx.textBaseline = 'alphabetic';
    if (S.pip) { ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1); ctx.font = '600 13px ' + FONT; ctx.fillStyle = 'rgba(232,237,242,0.95)'; ctx.fillText('摄影机画面', x + 10, y + 20); }
    // 这一刻的状态
    let txt, bad = false;
    if (!plan) txt = '自由镜头：只画机位路径，不检查机械臂';
    else if (armNow.flag & 3) { txt = '这一刻：' + FLAGTXT(armNow.flag); bad = true; }
    else if (armNow.hits.length) { txt = '这一刻干涉：' + [...new Set(armNow.hits.map(ReelArm.hitText))].slice(0, 3).join('、'); bad = true; }
    else txt = `这一刻无干涉 · 离台面和主体最近 ${(armNow.clr * 100).toFixed(1)} cm`;
    ctx.font = '600 14px ' + FONT; const tw2 = ctx.measureText(txt).width;
    ctx.fillStyle = 'rgba(11,13,16,0.72)'; ctx.fillRect(x + w - tw2 - 20, y + h + 8, tw2 + 20, 28);
    ctx.fillStyle = bad ? '#ff8585' : plan ? '#5fd08a' : 'rgba(139,151,165,0.95)'; ctx.fillText(txt, x + w - tw2 - 10, y + h + 27);
    if (plan) { const k = plan.takes.find(q => q.seg === ev.seg.base); if (!k.ok) { const t2 = '整个镜头：' + k.issues.join('；'), w2 = ctx.measureText(t2).width; ctx.fillStyle = 'rgba(11,13,16,0.72)'; ctx.fillRect(x + w - w2 - 20, y + h + 40, w2 + 20, 28); ctx.fillStyle = '#ff8585'; ctx.fillText(t2, x + w - w2 - 10, y + h + 59); } }
  }
  function hudBar(t) {
    ctx.font = '600 15px ' + FONT; ctx.fillStyle = 'rgba(232,237,242,0.92)'; ctx.fillText(ev.seg.name, 40, H - 62);
    const r = ev.seg.clip ? ev.rate : ev.pRate * (ev.seg.t1 - ev.seg.t0), mag = Math.abs(r);   // 静物没有素材时间，显示“相对平均速度的倍数”
    ctx.font = '700 30px ui-monospace, "SF Mono", Menlo, Consolas, monospace'; ctx.fillStyle = r < 0 ? '#7cc4ff' : '#ff7a1a';
    const rtxt = (r < 0 ? '◀ ' : '▶ ') + mag.toFixed(1) + '×', rw = ctx.measureText(rtxt).width; ctx.fillText(rtxt, 40, H - 92);
    ctx.font = '500 12px ' + FONT; ctx.fillStyle = 'rgba(139,151,165,0.95)';
    ctx.fillText(r < 0 ? '倒放 · 先快后慢' : '正放 · 先快后慢', 40 + rw + 14, H - 96);
    if (S.lock) ctx.fillText('稳帧：注视点锁定主体', 40, H - 126);
    const x0 = 40, x1 = W - 40, y = H - 34;
    ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(x0, y - 1, x1 - x0, 2);
    for (const b of bts) { const x = x0 + (x1 - x0) * b.t / tl.dur, passed = b.t <= t + 1e-6; ctx.beginPath(); ctx.arc(x, y, b.strong ? 4.5 : 2.2, 0, 6.2832); ctx.fillStyle = b.cut ? (passed ? '#ff7a1a' : 'rgba(255,122,26,0.45)') : (passed ? 'rgba(232,237,242,0.95)' : 'rgba(232,237,242,0.32)'); ctx.fill(); }
    const px = x0 + (x1 - x0) * t / tl.dur, pulse = Math.max(0, 1 - ev.sinceBeat / 0.16);
    ctx.fillStyle = '#fff'; ctx.fillRect(px - 1, y - 9 - 4 * pulse, 2, 18 + 8 * pulse);
  }
  function frame(t, n) {
    n = S.view === 'free' ? 1 : Math.max(1, n | 0);   // 自由视角是工作视图，不做运动模糊
    for (let i = 0; i < n; i++) { drawScene(Math.min(t + SHUTTER * i / n, tl.dur)); ctx.globalAlpha = 1 / (i + 1); ctx.drawImage(glc, 0, 0, W, H); }
    ctx.globalAlpha = 1; overlay(t);
  }

  // ---- 轨道 ----
  function seek(t) { S.t = Math.min(Math.max(t, 0), tl.dur - 1e-6); lastBeat = Math.floor(S.t / tl.beat); }
  function renderTracks() {
    const ls = $('#laneShots'), lj = $('#laneSubj'), rl = $('#ruler'); ls.textContent = ''; lj.textContent = ''; rl.textContent = '';
    tl.segs.forEach((g, i) => {
      const sh = script.shots[i], stt = shotStatus(i), b = el('button', { type: 'button', className: 'blk', title: stt.text });
      b.style.flex = `${g.beats} 1 0`; b.dataset.st = stt.st; b.setAttribute('aria-pressed', String(i === S.sel));
      b.append(el('span', { className: g.rev ? 'rv' : '', textContent: (g.rev ? '◀ ' : '') + (sh.name || `镜头 ${i + 1}`) }), el('small', { textContent: `${g.beats} 拍 · ${stt.st === 'ok' ? '可达' : stt.st === 'warn' ? '可达，有提醒' : stt.st === 'bad' ? '拍不了' : '自由'}` }));
      b.addEventListener('click', () => { S.sel = i; S.end = 0; S.playing = false; seek(g.t0 + 1e-4); renderTracks(); renderShotPane(); });
      ls.append(b);
      const d = el('div', { className: 'blk', textContent: g.clip ? `${g.rev ? '◀ ' : ''}${CLIP_NAME[g.clip] || g.clip} ${g.s0.toFixed(1)}–${g.s1.toFixed(1)} 秒` : '静止' }); d.style.flex = `${g.beats} 1 0`; lj.append(d);
    });
    for (const b of bts) { const i = el('i', { className: (b.strong ? 's' : '') + (b.cut ? ' c' : '') }); i.style.left = (100 * b.t / tl.dur) + '%'; rl.append(i); }
  }
  $('#ruler').addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); S.playing = false; seek(tl.dur * (e.clientX - r.left) / r.width); });

  // ---- 面板：镜头 ----
  function setStatus(kind, text) { const s = $('#shotStatus'); if (s) { s.className = 'status ' + kind; s.textContent = text; } }
  function refreshShotStatus() { const s = shotStatus(S.sel); setStatus(s.st, s.text); const f = $('#fixRow'); if (f) f.hidden = s.st !== 'bad'; }
  const fmt = (v, step) => step < 1 ? v.toFixed(step < 0.1 ? 2 : 1) : String(Math.round(v));
  function slider(id, label, key, get, set) {
    const R = SS.RANGE[key], inp = el('input', { type: 'range', id, min: R[0], max: R[1], step: R[2], value: get() }), o = el('output', { textContent: fmt(get(), R[2]) + R[3] });
    inp.addEventListener('input', () => { o.textContent = fmt(+inp.value, R[2]) + R[3]; set(+inp.value); });
    return el('div', { className: 'row' }, [el('label', { htmlFor: id, textContent: label }), inp, o]);
  }
  function renderShotPane() {
    const p = $('#pane-shot'), i = S.sel, sh = script.shots[i], base = SS.isBase(sh), g = tl.segs[i]; p.textContent = '';
    const stt = shotStatus(i);
    p.append(el('div', { id: 'shotStatus', className: 'status ' + stt.st, textContent: stt.text }));
    if (plan) {
      const fb = el('button', { type: 'button', id: 'fixBtn', textContent: '自动修正这个镜头' }), fi = el('span', { className: 'note', id: 'fixInfo', textContent: '在原机位附近找一个拍得了的版本，尽量少改构图。' });
      fb.addEventListener('click', () => runRepair(S.sel));
      p.append(el('div', { className: 'fix', id: 'fixRow', hidden: stt.st !== 'bad' }, [fb, fi]));
    }
    const nm = el('input', { type: 'text', id: 'sh-name', value: sh.name || '' }); nm.addEventListener('input', () => edit(n => { n.shots[i].name = nm.value; }));
    p.append(el('div', { className: 'row wide' }, [el('label', { htmlFor: 'sh-name', textContent: '名字' }), nm]));
    p.append(slider('sh-beats', '占几拍', 'beats', () => sh.beats, v => edit(n => { n.shots[i].beats = v; })));
    p.append(slider('sh-ease', '先快后慢', 'ease', () => sh.ease || 3, v => edit(n => { n.shots[i].ease = v; })));
    if (!base) p.append(el('p', { className: 'note', textContent: sh.reverse ? '倒放：把前一个镜头的动作和机位原路放回去。机位在它的来源镜头里改。' : '重复：把前一个镜头再正放一遍。机位在它的来源镜头里改。' }));
    else {
      if (C.subject.clips) {
        const sel = el('select', { id: 'sh-clip' }); DUCK_CLIPS.forEach(id => sel.append(el('option', { value: id, textContent: `${CLIP_NAME[id]}（${clipDur[id].toFixed(1)} 秒）`, selected: id === sh.clip })));
        sel.addEventListener('change', () => edit(n => { const s2 = n.shots[i]; s2.clip = sel.value; const d = clipDur[sel.value]; s2.to = Math.min(s2.to, d); s2.from = Math.min(s2.from, Math.max(0, s2.to - 0.3)); }, renderShotPane));
        p.append(el('div', { className: 'row wide' }, [el('label', { htmlFor: 'sh-clip', textContent: '动作' }), sel]));
        const f = el('input', { type: 'number', id: 'sh-from', min: 0, max: clipDur[sh.clip], step: 0.05, value: sh.from, 'aria-label': '从第几秒' }), t2 = el('input', { type: 'number', id: 'sh-to', min: 0, max: clipDur[sh.clip], step: 0.05, value: sh.to });
        f.addEventListener('change', () => edit(n => { n.shots[i].from = +f.value; }, () => seek(g.t0 + 1e-4)));
        t2.addEventListener('change', () => edit(n => { n.shots[i].to = +t2.value; }, () => seek(tl.segs[i].t1 - 1e-3)));
        p.append(el('div', { className: 'row two' }, [el('label', { htmlFor: 'sh-from', textContent: '第几秒' }), f, t2]));
      }
      const cg = el('div', { className: 'camgrid' }); cg.append(el('div', { className: 'hd' }, [el('span', { textContent: '机位' }), el('span', { textContent: '起点' }), el('span', { textContent: '终点' })]));
      const KEYS = [['az', '方位'], ['el', '俯仰'], ['dist', '距离'], ['roll', '倾斜']]; if (!C.rig.arm) KEYS.push(['fov', '视角']);
      for (const [key, label] of KEYS) {
        const R = SS.RANGE[key], cur = () => (script.shots[i].cam[key] || (key === 'fov' ? [C.rig.fov, C.rig.fov] : [0, 0])), row = el('div', { className: 'pairrow' }, [el('span', { textContent: label })]);
        [0, 1].forEach(e2 => {
          const inp = el('input', { type: 'range', id: `cam-${key}-${e2}`, min: R[0], max: R[1], step: R[2], value: cur()[e2] }), o = el('output', { textContent: fmt(cur()[e2], R[2]) });
          inp.setAttribute('aria-label', `${label}${e2 ? '终点' : '起点'}（${R[3].trim()}）`);
          inp.addEventListener('input', () => { o.textContent = fmt(+inp.value, R[2]); S.playing = false; S.end = e2; syncEnds(); edit(n => { const c = n.shots[i].cam; c[key] = (c[key] || cur()).slice(); c[key][e2] = +inp.value; }, () => seek(e2 ? tl.segs[i].t1 - 1e-3 : tl.segs[i].t0 + 1e-4)); });
          row.append(el('div', {}, [inp, o]));
        });
        cg.append(row);
      }
      p.append(cg, el('p', { className: 'note', textContent: '方位 0° = 从主体右侧看，90° = 正前方；俯仰 0° = 平视，90° = 正俯拍。拖“起点”画面跳到这个镜头开头，拖“终点”跳到结尾。' }));
    }
    const mkB = (txt, fn, dis) => { const b = el('button', { type: 'button', textContent: txt, disabled: !!dis }); b.addEventListener('click', fn); return b; };
    const restruct = (next, sel) => { const errs = applyScript(next, { sel }); if (errs.length) setStatus('bad', errs[0]); else { S.end = 0; seek(tl.segs[S.sel].t0 + 1e-4); } };
    p.append(el('div', { className: 'btns' }, [
      mkB('＋ 镜头', () => restruct(SS.addShot(script, i, 'shot'), i + 1)), mkB('＋ 倒放', () => restruct(SS.addShot(script, i, 'reverse'), i + 1)), mkB('＋ 重复', () => restruct(SS.addShot(script, i, 'repeat'), i + 1)),
      mkB('删除', () => restruct(SS.removeShot(script, i), Math.max(0, i - 1)), script.shots.length <= 1),
    ]));
    const mv = dir => { const r = SS.moveShot(script, i, dir); restruct(r.script, r.sel); }, can = dir => SS.moveShot(script, i, dir).sel !== i;
    p.append(el('div', { className: 'btns' }, [mkB('◀ 前移', () => mv(-1), !can(-1)), mkB('后移 ▶', () => mv(1), !can(1))]));
    syncEnds();
  }

  // ---- 直接拖画面改机位：左右 = 方位，上下 = 俯仰，滚轮 = 距离，按住 Shift 左右 = 倾斜 ----
  const endsBox = $('#ends'), endBt = [$('#end0'), $('#end1')];
  function baseSel() { return SS.baseIndex(script, S.sel); }
  function syncEnds() { endsBox.hidden = S.view === 'free' || !script || !SS.isBase(script.shots[S.sel]); $('#freeHint').hidden = S.view !== 'free'; endBt.forEach((b, k) => b.setAttribute('aria-pressed', String(S.end === k))); }
  function gotoEnd() { const g = tl.segs[S.sel]; S.playing = false; seek(S.end ? g.t1 - 1e-3 : g.t0 + 1e-4); }
  endBt.forEach((b, k) => b.addEventListener('click', () => { S.end = k; syncEnds(); gotoEnd(); }));
  function nudgeCam(key, delta) {
    const i = S.sel; if (!SS.isBase(script.shots[i])) return;
    const R = SS.RANGE[key], e2 = S.end;
    edit(n => { const c = n.shots[i].cam, cur = (c[key] || [0, 0]).slice(); cur[e2] = Math.min(R[1], Math.max(R[0], Math.round((cur[e2] + delta) / R[2]) * R[2])); cur[e2] = +cur[e2].toFixed(3); c[key] = cur; },
      () => { const g = tl.segs[i]; seek(e2 ? g.t1 - 1e-3 : g.t0 + 1e-4); syncCamSliders(i); });
  }
  function syncCamSliders(i) {   // 拖画面之后把面板上的滑块对齐
    const c = script.shots[i].cam; if (!c) return;
    for (const key of ['az', 'el', 'dist', 'roll']) [0, 1].forEach(e2 => { const inp = $(`#cam-${key}-${e2}`); if (inp && c[key]) { inp.value = c[key][e2]; inp.nextElementSibling.textContent = fmt(c[key][e2], SS.RANGE[key][2]); } });
  }
  // 自由视角：拖动旋转、滚轮或双指缩放、双击复位（不改脚本）
  const touches = new Map(); let pinch = 0;
  const zoomFree = k => { freeCam.dist = Math.min(7, Math.max(0.5, freeCam.dist * k)); };
  out.addEventListener('pointerdown', e => {
    if (S.view !== 'free') return; e.stopImmediatePropagation();
    touches.set(e.pointerId, [e.clientX, e.clientY]); out.setPointerCapture(e.pointerId); out.classList.add('dragging'); pinch = 0;
  });
  out.addEventListener('pointermove', e => {
    if (S.view !== 'free') return; e.stopImmediatePropagation();
    const p0 = touches.get(e.pointerId); if (!p0) return;
    if (touches.size >= 2) {
      touches.set(e.pointerId, [e.clientX, e.clientY]); const [a, b] = [...touches.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch > 0 && d > 0) zoomFree(pinch / d); pinch = d; return;
    }
    const k = 1280 / out.getBoundingClientRect().width;   // 小屏上同样的手指位移转得一样多
    freeCam.az -= (e.clientX - p0[0]) * 0.0045 * k; freeCam.el = Math.min(1.5, Math.max(0.03, freeCam.el + (e.clientY - p0[1]) * 0.0035 * k));
    touches.set(e.pointerId, [e.clientX, e.clientY]);
  });
  const endFree = e => { if (S.view !== 'free') return; e.stopImmediatePropagation(); touches.delete(e.pointerId); pinch = 0; if (!touches.size) out.classList.remove('dragging'); };
  out.addEventListener('pointerup', endFree); out.addEventListener('pointercancel', endFree);
  out.addEventListener('wheel', e => { if (S.view !== 'free') return; e.stopImmediatePropagation(); e.preventDefault(); zoomFree(Math.exp(e.deltaY * 0.0012)); }, { passive: false });
  out.addEventListener('dblclick', () => { if (S.view === 'free') resetFree(); });
  function setView(v) {
    S.view = v; touches.clear(); out.classList.toggle('free', v === 'free'); out.classList.remove('dragging');
    $('#vcam').setAttribute('aria-pressed', String(v === 'cam')); $('#vfree').setAttribute('aria-pressed', String(v === 'free'));
    out.setAttribute('aria-label', v === 'free' ? '自由视角：整个拍摄现场，右上角小窗是摄影机画面' : '摄影机画面，右上角小窗是机械臂');
    syncEnds();
  }
  // 把 .glb 拖到画面上 = 换主体
  const wrap = out.parentElement;
  wrap.addEventListener('dragover', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); wrap.classList.add('dropping'); } });
  wrap.addEventListener('dragleave', () => wrap.classList.remove('dropping'));
  wrap.addEventListener('drop', e => { e.preventDefault(); wrap.classList.remove('dropping'); const f = e.dataTransfer.files[0]; if (f) loadModelFile(f); });
  $('#vcam').addEventListener('click', () => setView('cam')); $('#vfree').addEventListener('click', () => setView('free'));

  // ---- 自动修正：机械臂拍不了的镜头，在原机位附近找一个拍得了的 ----
  let repairing = false;
  function runRepair(sel) {
    if (repairing || !plan) return;
    const i = SS.baseIndex(script, sel), say = t => { const f = $('#fixInfo'); if (f) f.textContent = t; }, bt = $('#fixBtn');
    repairing = true; if (bt) bt.disabled = true; clearTimeout(pending);
    const it = ReelArm.repair(tl.segs[i], rootAt, plan.opt), was = script.shots[i].cam, D = 180 / Math.PI;
    const finish = r => {
      repairing = false; const b2 = $('#fixBtn'); if (b2) b2.disabled = false;
      if (!r.ok) { say(`试了 ${r.evals} 个机位，原机位附近没有拍得了的。可以到“场景”里点“自动找摆位”，或者手动把机位拉近机械臂一侧。`); return; }
      const n = SS.clone(script), c = n.shots[i].cam, diff = [];
      for (const [k, name, unit] of [['dist', '距离', ' m'], ['el', '俯仰', '°'], ['az', '方位', '°']]) {
        const Rg = SS.RANGE[k], nv = r.cam[k].map(v => { const x = k === 'dist' ? v : v * D; return +Math.min(Rg[1], Math.max(Rg[0], Math.round(x / Rg[2]) * Rg[2])).toFixed(3); });
        [0, 1].forEach(e2 => { if (Math.abs(nv[e2] - was[k][e2]) > 1e-6) diff.push(`${name}${e2 ? '终点' : '起点'} ${fmt(was[k][e2], Rg[2])} → ${fmt(nv[e2], Rg[2])}${unit}`); });
        c[k] = nv;
      }
      const errs = applyScript(n, { sel });
      if (errs.length) { say('修正出来的机位不合规：' + errs[0]); return; }
      seek(tl.segs[sel].t0 + 1e-4);
      const ok = shotStatus(sel).st !== 'bad';
      setStatus(shotStatus(sel).st, (ok ? '已自动修正（可撤销）：' : '改了机位但仍有问题：') + diff.join('，') + '。' + shotStatus(sel).text);
    };
    const step = () => {
      const t0 = performance.now(); let r;
      do { r = it.next().value; } while (!r.done && performance.now() - t0 < 60);
      if (r.done) finish(r); else { say(`正在试第 ${r.evals} 个机位……`); setTimeout(step, 0); }
    };
    say('正在找拍得了的机位……'); setTimeout(step, 0);
  }

  out.addEventListener('pointerdown', e => { if (!script || !SS.isBase(script.shots[S.sel])) return; drag = { x: e.clientX, y: e.clientY, ax: 0, ay: 0 }; out.setPointerCapture(e.pointerId); out.classList.add('dragging'); gotoEnd(); });
  out.addEventListener('pointermove', e => {
    if (!drag) return;
    drag.ax += e.clientX - drag.x; drag.ay += e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    const sx = Math.trunc(drag.ax / 3), sy = Math.trunc(drag.ay / 4);   // 每 3 像素 1°
    if (sx) { drag.ax -= sx * 3; nudgeCam(e.shiftKey ? 'roll' : 'az', -sx); }
    if (sy && !e.shiftKey) { drag.ay -= sy * 4; nudgeCam('el', sy); }
  });
  const endDrag = () => { drag = null; editOpen = false; out.classList.remove('dragging'); };
  out.addEventListener('pointerup', endDrag); out.addEventListener('pointercancel', endDrag);
  out.addEventListener('wheel', e => { if (!script || !SS.isBase(script.shots[S.sel])) return; e.preventDefault(); nudgeCam('dist', e.deltaY > 0 ? 0.02 : -0.02); }, { passive: false });
  $('#undo').addEventListener('click', undo);
  document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) { e.preventDefault(); undo(); } });

  // ---- 自动找摆位：在一圈候选位置里挑“全部镜头可达、放慢倍数最小”的 ----
  let placing = false;
  async function autoPlace(bt, info) {
    if (placing) return; placing = true; bt.disabled = true;
    const cands = []; for (const mount of SS.MOUNTS) for (const y of [-0.55, -0.65, -0.75, -0.85, -0.95]) for (const z of [0, 0.15, 0.3]) for (const x of [-0.15, 0.05, 0.25]) cands.push({ base: [x, y, z], mount });
    let best = null;
    for (let k = 0; k < cands.length; k++) {
      const c = cands[k], P = ReelArm.plan(tl, rootAt, { base: c.base, mount: c.mount, lookUp: C.subject.lookUp, subjectR: C.subject.radius, subjectHalf: C.subject.half || 0, subjectYaw: C.subject.yaw || 0 });
      const clr = Math.min(...P.takes.map(t => t.minClr));
      if (P.ok && clr > 0.04 && (!best || P.slow < best.slow)) best = { slow: P.slow, clr, base: c.base, mount: c.mount };
      if (k % 6 === 5) { info.textContent = `正在试第 ${k + 1} / ${cands.length} 种摆法……`; await new Promise(r => setTimeout(r, 0)); }
    }
    placing = false; bt.disabled = false;
    if (!best) { info.textContent = '试了 ' + cands.length + ' 种摆法，没有一种能让全部镜头都拍到。把机位拉近一些、或减小方位的变化范围再试。'; return; }
    const n = SS.clone(script); n.rig = Object.assign({}, n.rig, { base: best.base, mount: best.mount });
    applyScript(n); renderRigPane();
    $('#rigInfo').textContent = `已选：底座 (${best.base.join(', ')})，全部镜头可达，最慢的镜头放慢 ${best.slow.toFixed(1)} 倍，最小间隙 ${(best.clr * 100).toFixed(1)} cm。`;
  }

  // ---- 面板：场景 ----
  function renderRigPane(keep) {
    if (keep && $('#pane-rig').childElementCount) return;
    const p = $('#pane-rig'); p.textContent = '';
    const row = (label, ctl) => el('div', { className: 'row wide' }, [el('label', { htmlFor: ctl.id, textContent: label }), ctl]);
    const numIn = (id, v, min, max, step, fn) => { const x = el('input', { type: 'number', id, value: v, min, max, step }); x.addEventListener('change', () => { if (x.value !== '' && Number.isFinite(+x.value)) fn(+x.value); }); return x; };
    const structural = mut => { const n = SS.clone(script); mut(n); if (JSON.stringify(n) === JSON.stringify(script)) return; const errs = applyScript(n); if (errs.length) { $('#rigErrs').textContent = errs.join('\n'); renderRigPane(); $('#rigErrs').textContent = errs.join('\n'); } };
    p.append(el('h2', { textContent: '主体与节奏' }));
    const kind = el('select', { id: 'rg-subj' });
    [['duck', '小鸭子（仿真动作）'], ['product', '静物 / 瓶子'], ['car', '赛车（程序化替身）'], ['custom', C.subject.type === 'custom' ? '导入的模型：' + C.subject.name : '导入模型（.glb）……']].forEach(([v, t]) => kind.append(el('option', { value: v, textContent: t, selected: v === C.subject.type })));
    const pickFile = el('input', { type: 'file', id: 'rg-file', accept: '.glb,model/gltf-binary', hidden: true });
    pickFile.addEventListener('change', () => { const f = pickFile.files[0]; pickFile.value = ''; if (f) loadModelFile(f); else kind.value = C.subject.type; });
    kind.addEventListener('change', () => {
      if (kind.value === 'custom') { kind.value = C.subject.type; pickFile.click(); return; }
      structural(n => {
        n.subject = { type: kind.value, yaw: n.subject.yaw || 0 };
        if (kind.value === 'duck') n.shots.forEach(sh => { if (SS.isBase(sh) && !(sh.clip in clipDur)) { sh.clip = DUCK_CLIPS[0]; sh.from = 0; sh.to = +Math.min(clipDur[sh.clip], 2).toFixed(2); } });
      });
    });
    p.append(row('主体', kind), pickFile);
    if (C.subject.type !== 'duck') p.append(row('朝向', numIn('rg-yaw', +(C.subject.yaw * 180 / Math.PI).toFixed(1), -180, 180, 5, v => structural(n => { n.subject = Object.assign({}, n.subject, { yaw: Math.max(-180, Math.min(180, v)) }); }))));
    if (C.subject.type === 'custom') {
      const d = C.subject.dims, m = models.get(C.subject.hash);
      p.append(row('实际长度', numIn('rg-len', d[0], 0.01, 1.5, 0.01, v => structural(n => { const k = v / n.subject.dims[0]; n.subject = Object.assign({}, n.subject, { dims: n.subject.dims.map(x => +(x * k).toFixed(4)) }); }))));
      const up = el('select', { id: 'rg-up' }); [['y', 'Y 向上（glTF 标准）'], ['z', 'Z 向上（模型躺倒时选这个）']].forEach(([v, t]) => up.append(el('option', { value: v, textContent: t, selected: v === C.subject.up })));
      up.addEventListener('change', () => {
        const mm = models.get(C.subject.hash); if (!mm) return;
        const raw = StudioModel.normalize(mm.parsed, up.value, 0).raw, k = C.subject.dims[0] / raw[0];
        structural(n => { n.subject = Object.assign({}, n.subject, { up: up.value, dims: raw.map(x => +(x * k).toFixed(4)) }); });
      });
      p.append(row('模型上方', up));
      const again = el('button', { type: 'button', id: 'rg-reimport', textContent: m ? '换一个模型' : '重新选择 ' + C.subject.name });
      again.addEventListener('click', () => pickFile.click());
      p.append(el('div', { className: 'btns' }, [again]));
      p.append(el('p', { className: 'note', id: 'mdlInfo', textContent: (m ? `尺寸 ${d.map(v => (v * 100).toFixed(1)).join(' × ')} cm（长 × 宽 × 高），${(m.tris / 1e4).toFixed(1)} 万面。` : `模型不在内存里（刷新页面后要重新选择文件），现在用同尺寸的灰色方块代替，规划和干涉照常按尺寸算。`) + '机械臂按一根横放的胶囊体检查干涉，在自由视角里能看到它。' }));
    } else p.append(el('p', { className: 'note', id: 'mdlInfo', textContent: '也可以把 .glb 文件直接拖到画面上，换成你自己的模型。镜头参数都是相对主体写的，换模型不用重写镜头。' }));
    p.append(row('节奏', numIn('rg-bpm', C.bpm, 30, 240, 1, v => structural(n => { n.bpm = v; }))));
    p.append(row('起步加速', numIn('rg-att', C.attack, 0, 0.6, 0.01, v => structural(n => { n.attack = v; }))));
    p.append(el('h2', { textContent: '机械臂与摄影机' }));
    const arm = el('select', { id: 'rg-arm' }); [['1', '用 Nova 5 拍（检查能不能拍）'], ['0', '自由镜头（不检查）']].forEach(([v, t]) => arm.append(el('option', { value: v, textContent: t, selected: (v === '1') === !!C.rig.arm })));
    arm.addEventListener('change', () => structural(n => { n.rig = Object.assign({}, n.rig || {}, { arm: arm.value === '1' }); if (arm.value === '1' && !(n.attack > 0)) n.attack = 0.12; }));
    p.append(row('拍摄方式', arm));
    if (C.rig.arm) {
      const b = C.rig.base, three = el('div', { className: 'row' }); three.style.gridTemplateColumns = '74px repeat(3, minmax(0, 1fr))';
      three.append(el('span', { className: 'lb', textContent: '底座 x y z' }));
      [0, 1, 2].forEach(k => { const x = numIn('rg-b' + k, b[k], -2, 2, 0.01, v => structural(n => { n.rig = Object.assign({}, n.rig); n.rig.base = (n.rig.base || SS.DEF_RIG.base).slice(); n.rig.base[k] = v; })); x.setAttribute('aria-label', '底座 ' + 'xyz'[k] + '（米）'); three.append(x); });
      p.append(three);
      const mt = el('select', { id: 'rg-mount' }); [['invert', '背夹倒挂（低机位）'], ['side', '背夹正挂'], ['bottom', '底部安装']].forEach(([v, t]) => mt.append(el('option', { value: v, textContent: t, selected: v === C.rig.mount })));
      mt.addEventListener('change', () => structural(n => { n.rig = Object.assign({}, n.rig, { mount: mt.value }); })); p.append(row('Pocket 挂法', mt));
      const info = el('p', { className: 'note', id: 'rigInfo' }), ab = el('button', { type: 'button', id: 'rg-auto', textContent: '自动找摆位' });
      ab.addEventListener('click', () => autoPlace(ab, $('#rigInfo')));
      p.append(el('div', { className: 'btns' }, [ab]), info);
    }
    p.append(row('镜头视角', numIn('rg-fov', C.rig.fov, 15, 90, 1, v => structural(n => { n.rig = Object.assign({}, n.rig, { fov: v }); }))));
    p.append(el('pre', { className: 'errs', id: 'rigErrs' }));
    p.append(el('p', { className: 'note', textContent: '底座位置以主体起点为原点（米），z 是垫高。主体在 (0, 0)，机位方位 0° 那一侧是 −y。Pocket 3 是定焦，视角约 54°。' }));
  }

  // ---- 面板：拍摄表 ----
  function renderTakes() {
    const p = $('#pane-take'); p.textContent = '';
    if (!plan) { p.append(el('p', { className: 'note', textContent: '这份脚本用的是自由镜头，没有机械臂方案。到“场景”里把拍摄方式改成“用 Nova 5 拍”，就能看到每个镜头拍不拍得了。' })); return; }
    p.append(el('p', { className: 'note', textContent: '每个镜头真机只拍一条正放素材：按“放慢”倍数执行，成片线性加速同样的倍数；倒放和卡点在后期做。' }));
    const tb = el('tbody');
    for (const k of plan.takes) {
      const tr = el('tr'); tr.append(el('td', { textContent: k.name }));
      if (k.ok) { tr.append(el('td', { className: 'num', textContent: (k.minClr * 100).toFixed(1) + ' cm' }), el('td', { className: 'num', textContent: k.slow.toFixed(1) + '×' }), el('td', { className: 'num', textContent: k.realDur.toFixed(1) + ' 秒' })); const bt = el('button', { type: 'button', textContent: '复制轨迹' }); bt.addEventListener('click', () => copyText(ReelArm.takeCsv(plan, k.seg), bt, '复制轨迹')); tr.append(el('td', {}, [bt])); }
      else { const td = el('td', { className: 'bad', textContent: k.issues.join('；') }); td.colSpan = 4; tr.append(td); }
      tb.append(tr);
    }
    const th = el('thead', {}, [el('tr', {}, ['镜头', '间隙', '放慢', '真机时长', '关节轨迹'].map(t => el('th', { textContent: t })))]);
    p.append(el('div', { className: 'tablewrap' }, [el('table', {}, [th, tb])]));
    p.append(el('p', { className: 'note', textContent: plan.ok ? `整套最慢的镜头要放慢 ${plan.slow.toFixed(1)} 倍。轨迹是 50 Hz 的六个关节角（度），已按放慢倍数拉长。` : '有镜头机械臂拍不了：在镜头轨上点红色的那一段，把机位拉近机械臂一侧，或在“场景”里挪底座。' }));
  }
  function copyText(txt, bt, label) {
    const done = ok => { bt.textContent = ok ? '已复制' : '复制失败，请手动选中'; setTimeout(() => { bt.textContent = label; }, 1600); };
    try { navigator.clipboard.writeText(txt).then(() => done(true), () => done(false)); } catch (e) { done(false); }
  }

  // ---- 标签页、脚本编辑、播放 ----
  const TABS = ['shot', 'rig', 'take', 'code', 'out'];
  $('#tab-out').addEventListener('click', () => { $('#ex-hud').checked = S.hud; $('#ex-pip').checked = S.pip; });   // 导出默认就是现在看到的画面
  TABS.forEach(k => $('#tab-' + k).addEventListener('click', () => TABS.forEach(j => { $('#tab-' + j).setAttribute('aria-selected', String(j === k)); $('#pane-' + j).hidden = j !== k; })));
  $('#apply').addEventListener('click', () => {
    let obj; try { obj = JSON.parse($('#code').value); } catch (e) { $('#codeErrs').textContent = '不是合法的 JSON：' + e.message; return; }
    const errs = applyScript(obj, { keepCode: true }); $('#codeErrs').textContent = errs.join('\n'); if (!errs.length) seek(0);
  });
  $('#copy').addEventListener('click', e => copyText($('#code').value, e.currentTarget, '复制脚本'));
  $('#reset').addEventListener('click', () => { store.del('studio.' + S.name); S.sel = 0; applyScript(SS.clone(examples[S.name]), { noStore: true }); seek(0); });
  const pick = $('#pick');
  function openScript(name) {
    if (script) pushHistory(script);
    S.name = name; S.sel = 0; S.t = 0; let sc = SS.clone(examples[name]);
    const saved = store.get('studio.' + name); if (saved) { try { const o = JSON.parse(saved); if (!SS.validate(o, clipDur).length) sc = o; } catch (e) { /* 存的坏了就用示例 */ } }
    applyScript(sc, { noStore: true, noHistory: true }); pick.value = name;
  }
  pick.addEventListener('change', () => { openScript(pick.value); });

  let ac = null, last = 0, lastBeat = -1;
  function tick(strong) {
    if (!S.snd) return;
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain(), now = ac.currentTime;
    o.frequency.setValueAtTime(strong ? 150 : 90, now); o.frequency.exponentialRampToValueAtTime(42, now + 0.12);
    g.gain.setValueAtTime(strong ? 0.6 : 0.3, now); g.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
    o.connect(g).connect(ac.destination); o.start(now); o.stop(now + 0.18);
  }
  const ui = { play: $('#play'), tc: $('#tc'), lock: $('#lock'), blur: $('#blur'), hud: $('#hud'), pip: $('#pip'), snd: $('#snd'), head: $('#head'), lane: $('#laneShots') };
  function syncUi() {
    ui.play.textContent = S.playing ? '❚❚ 暂停' : '▶ 播放'; ui.play.setAttribute('aria-pressed', String(S.playing));
    for (const k of ['lock', 'blur', 'hud', 'pip', 'snd']) ui[k].setAttribute('aria-pressed', String(S[k]));
    ui.tc.textContent = `${S.t.toFixed(2)} / ${tl.dur.toFixed(2)} 秒`;
    ui.head.style.left = (ui.lane.offsetLeft + ui.lane.offsetWidth * S.t / tl.dur) + 'px';
  }
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min((now - last) / 1000, 0.1); last = now;
    if (exporting) return;                                 // 导出时画面由导出流程逐帧画
    if (S.playing) {
      S.t += dt; if (S.t >= tl.dur) { S.t = 0; lastBeat = -1; }
      const b = Math.floor(S.t / tl.beat + 1e-6); if (b !== lastBeat) { lastBeat = b; tick(bts[b] && bts[b].strong); }
    }
    frame(S.t, S.blur ? S.samples : 1); syncUi();
  }
  ui.play.addEventListener('click', () => { S.playing = !S.playing; });
  for (const k of ['lock', 'blur', 'hud', 'pip', 'snd']) ui[k].addEventListener('click', () => { S[k] = !S[k]; if (k === 'snd' && S.snd) tick(true); });

  // ---- 导出视频：不实时，逐帧画完再编码，所以慢机器出来的也是顺滑的 30 帧成片 ----
  let exporting = false, exportUrl = null;
  // 导出分辨率：画面逻辑上仍是 1280×720（字幕、小窗都按它排），导出时整体放大 scale 倍画，再交给编码器
  const EX_RES = [
    { id: '1080', label: '1920×1080（1080p，推荐）', scale: 1.5, codecs: ['avc1.64002A', 'avc1.640028', 'avc1.640032'] },
    { id: '1440', label: '2560×1440（2K）', scale: 2, codecs: ['avc1.640032', 'avc1.640033'] },
    { id: '2160', label: '3840×2160（4K，很慢）', scale: 3, codecs: ['avc1.640033', 'avc1.640034'] },
    { id: '720', label: '1280×720（720p，最快）', scale: 1, codecs: ['avc1.640028', 'avc1.42E01F'] },
  ];
  let dl = null; try { if (window.claude && window.claude.use) window.claude.use('downloads').then(x => { dl = x; }, () => {}); } catch (e) { /* 普通网页没有这个接口 */ }
  function beatPcm(rate) {   // 和“节拍声”同一个音色：每拍一下低频鼓点，重拍更响
    const n = Math.ceil(tl.dur * rate), pcm = new Float32Array(n);
    for (const b of bts) {
      const i0 = Math.round(b.t * rate), f0 = b.strong ? 150 : 90, g0 = b.strong ? 0.6 : 0.3, len = Math.round(0.18 * rate); let ph = 0;
      for (let i = 0; i < len && i0 + i < n; i++) { const t = i / rate, f = f0 * Math.pow(42 / f0, Math.min(t / 0.12, 1)); ph += 6.2832 * f / rate; pcm[i0 + i] += Math.sin(ph) * g0 * Math.pow(0.001 / g0, t / 0.16); }
    }
    return pcm;
  }
  async function exportVideo(opt, onProgress) {
    if (!window.VideoEncoder || !window.VideoFrame) throw new Error('这个浏览器不支持网页内视频编码（WebCodecs）。请用新版 Chrome、Edge 或 Safari。');
    const R = EX_RES.find(r => r.id === opt.res) || EX_RES[3], OW = Math.round(W * R.scale / 2) * 2, OH = Math.round(H * R.scale / 2) * 2;
    const cfg = { codec: '', width: OW, height: OH, bitrate: Math.round(OW * OH * FPS * (opt.bpp || 0.3)), bitrateMode: 'variable', latencyMode: 'quality', framerate: FPS, avc: { format: 'avc' } };
    for (const c of R.codecs) { cfg.codec = c; try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) break; } catch (e) { /* 试下一个 */ } cfg.codec = ''; }
    if (!cfg.codec) throw new Error(`这个浏览器编不了 ${OW}×${OH} 的 H.264，换低一档分辨率试试。`);
    const pr = Math.min(R.scale * (opt.ss || 1), 4);   // 渲染分辨率：超采样时比输出再大一倍，缩小时把锯齿抹掉（上限 4 倍，约 5120×2880）
    const keep = { t: S.t, playing: S.playing, view: S.view, hud: S.hud, pip: S.pip };
    exporting = true; S.playing = false; if (S.view !== 'cam') setView('cam'); S.hud = !!opt.hud; S.pip = !!opt.pip;
    stOpt.pixelRatio = pr; out.width = OW; out.height = OH; ctx.setTransform(OW / W, 0, 0, OH / H, 0, 0); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    const vs = [], as = []; let avcC = null, asc = null, err = null;
    const venc = new VideoEncoder({ output: (c, m) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); vs.push({ data: d, key: c.type === 'key' }); if (m && m.decoderConfig && m.decoderConfig.description) avcC = new Uint8Array(m.decoderConfig.description.buffer || m.decoderConfig.description); }, error: e => { err = e; } });
    venc.configure(cfg);
    try {
      const n = Math.round(tl.dur * FPS), t0 = performance.now();
      for (let i = 0; i < n; i++) {
        if (opt.signal && opt.signal.cancelled) throw new Error('已取消');
        if (err) throw err;
        frame(i / FPS, opt.samples || 8);
        const vf = new VideoFrame(out, { timestamp: Math.round(i * 1e6 / FPS), duration: Math.round(1e6 / FPS) });
        venc.encode(vf, { keyFrame: i % 60 === 0 }); vf.close();
        while (venc.encodeQueueSize > 6) await new Promise(r => setTimeout(r, 4));
        if (i % 3 === 0) { const el2 = (performance.now() - t0) / 1000, eta = i > 5 ? el2 / i * (n - i) : 0; onProgress && onProgress(i / n, `正在画第 ${i + 1} / ${n} 帧（${OW}×${OH}）` + (eta ? `，大约还要 ${eta > 90 ? Math.round(eta / 60) + ' 分钟' : Math.round(eta) + ' 秒'}` : '……')); await new Promise(r => setTimeout(r, 0)); }
      }
      await venc.flush(); if (err) throw err;
      if (!avcC) throw new Error('编码器没有给出解码参数');
      const tracks = [{ kind: 'video', timescale: FPS, sampleDur: 1, samples: vs, width: OW, height: OH, avcC }];
      let note = '';
      if (opt.sound) {   // 节拍音轨：能编 AAC 就带上，编不了就只出画面
        try {
          const RATE = 48000, acfg = { codec: 'mp4a.40.2', sampleRate: RATE, numberOfChannels: 1, bitrate: 128000 };
          if (!window.AudioEncoder || !(await AudioEncoder.isConfigSupported(acfg)).supported) throw new Error('不支持 AAC');
          const aenc = new AudioEncoder({ output: (c, m) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); as.push({ data: d }); if (m && m.decoderConfig && m.decoderConfig.description) asc = new Uint8Array(m.decoderConfig.description.buffer || m.decoderConfig.description); }, error: e => { err = e; } });
          aenc.configure(acfg);
          const pcm = beatPcm(RATE), CH = RATE;   // 一秒一块喂给编码器
          for (let o = 0; o < pcm.length; o += CH) { const part = pcm.subarray(o, Math.min(o + CH, pcm.length)); const ad = new AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: part.length, numberOfChannels: 1, timestamp: Math.round(o * 1e6 / RATE), data: part }); aenc.encode(ad); ad.close(); }
          await aenc.flush(); aenc.close(); if (err) throw err;
          tracks.push({ kind: 'audio', timescale: RATE, sampleDur: 1024, samples: as, sampleRate: RATE, channels: 1, asc: asc || new Uint8Array([0x11, 0x88]) });
        } catch (e) { note = '这个浏览器编不了音轨，导出的视频没有声音。'; err = null; }
      }
      onProgress && onProgress(1, '正在封装……');
      const bytes = Mp4.build(tracks);
      return { blob: new Blob([bytes], { type: 'video/mp4' }), bytes, frames: n, note, width: OW, height: OH };
    } finally {
      try { venc.close(); } catch (e) { /* 已经关了 */ }
      stOpt.pixelRatio = 1; out.width = W; out.height = H; ctx.setTransform(1, 0, 0, 1, 0, 0);
      S.hud = keep.hud; S.pip = keep.pip; if (keep.view !== 'cam') setView(keep.view); S.t = keep.t; S.playing = keep.playing; exporting = false; last = performance.now();
    }
  }
  (function exportPane() {
    const p = $('#pane-out'), row = (label, ctl) => el('div', { className: 'row wide' }, [el('label', { htmlFor: ctl.id, textContent: label }), ctl]);
    const sel = (id, opts) => { const s = el('select', { id }); opts.forEach(([v, t]) => s.append(el('option', { value: v, textContent: t }))); return s; };
    const chk = (id, text) => { const c = el('input', { type: 'checkbox', id }); return [c, el('label', { className: 'chk' }, [c, document.createTextNode(' ' + text)])]; }, [eHud, lHud] = chk('ex-hud', '字幕和节拍条'), [ePip, lPip] = chk('ex-pip', '小窗'), q = sel('ex-q', [['16', '精细（每帧画 16 次）'], ['8', '标准（每帧画 8 次）'], ['24', '极细（每帧画 24 次，最慢）'], ['4', '快速（每帧画 4 次）'], ['1', '不做运动模糊']]), resSel = sel('ex-size', EX_RES.map(r => [r.id, r.label])), aa = sel('ex-aa', [['2', '2× 超采样（推荐，边缘最干净）'], ['1', '不超采样（快一倍）']]), br = sel('ex-br', [['0.3', '高（推荐）'], ['0.55', '极高（文件约大一倍）'], ['0.15', '标准（文件小）']]), snd = sel('ex-snd', [['1', '带节拍声'], ['0', '无声']]);
    const go = el('button', { type: 'button', id: 'ex-go', textContent: '导出 MP4' }), stop = el('button', { type: 'button', id: 'ex-stop', textContent: '取消', hidden: true });
    const bar = el('progress', { id: 'ex-bar', max: 1, value: 0, hidden: true }), info = el('p', { className: 'note', id: 'ex-info', textContent: '30 帧/秒的 H.264 视频。导出不是实时录屏：每一帧按导出分辨率重新画、画完再编码，电脑慢只会导得久一点，不会掉帧。1080p、2× 超采样、16 次运动模糊大约是预览的几十倍计算量，开始后会显示预计剩余时间。' });
    const res = el('div', { id: 'ex-res', className: 'exres', hidden: true });
    bar.setAttribute('aria-label', '导出进度');
    let signal = null;
    go.addEventListener('click', async () => {
      if (exporting) return; signal = { cancelled: false }; go.disabled = true; stop.hidden = false; bar.hidden = false; bar.value = 0; res.hidden = true;
      const t0 = performance.now();
      try {
        const r = await exportVideo({ hud: eHud.checked, pip: ePip.checked, res: resSel.value, ss: +aa.value, bpp: +br.value, samples: +q.value, sound: snd.value === '1', signal }, (f, t) => { bar.value = f; info.textContent = t; });
        if (exportUrl) URL.revokeObjectURL(exportUrl); exportUrl = URL.createObjectURL(r.blob);
        const name = `${S.name}-${r.height}p${!eHud.checked && !ePip.checked ? '-clean' : ''}.mp4`, v = el('video', { src: exportUrl, controls: true, loop: true, playsInline: true }), a = el('a', { href: exportUrl, download: name, className: 'savebtn', textContent: '保存 ' + name });
        v.setAttribute('aria-label', '导出的视频预览');
        a.addEventListener('click', async e2 => {   // 内嵌在 Claude 里时浏览器自己的下载被禁用，走平台的保存确认
          if (!dl) return; e2.preventDefault();
          try { await dl.save({ filename: name, data: r.blob }); info.textContent = '已交给系统保存：' + name; }
          catch (er) { info.textContent = er && er.code === 'declined' ? '没有保存（你取消了）。视频还在，可以再点一次。' : '这里保存不了（' + ((er && er.code) || '未知原因') + '）。可以在视频上长按或点右键选“存储视频”。'; }
        });
        res.textContent = ''; res.append(v, a); res.hidden = false;
        info.textContent = `导出完成：${r.width}×${r.height}，${r.frames} 帧，${(r.blob.size / 1048576).toFixed(1)} MB，用时 ${((performance.now() - t0) / 1000).toFixed(0)} 秒。${r.note}点“保存”存到本机；如果点了没反应（比如在内嵌页面里），在视频上长按或点右键选“存储视频”。`;
      } catch (e) { info.textContent = '没有导出：' + e.message; }
      go.disabled = false; stop.hidden = true; bar.hidden = true;
    });
    stop.addEventListener('click', () => { if (signal) signal.cancelled = true; });
    p.append(el('div', { className: 'row wide' }, [el('span', { textContent: '画面里带' }), el('span', { className: 'chks' }, [lHud, lPip])]), row('分辨率', resSel), row('抗锯齿', aa), row('运动模糊', q), row('码率', br), row('声音', snd), el('div', { className: 'btns' }, [go, stop]), bar, info, res);
  })();

  const ready = load().then(() => {
    SCRIPTS.forEach(n => pick.append(el('option', { value: n, textContent: examples[n].name })));
    openScript(S.name); setView(S.view); msg.hidden = true; frame(0, 1);
    novaReady = loadNova();
    if (Q.get('render') !== '1') { S.playing = !matchMedia('(prefers-reduced-motion: reduce)').matches && Q.get('autoplay') !== '0'; last = performance.now(); requestAnimationFrame(loop); }
    return Q.get('render') === '1' ? novaReady.then(() => true) : true;   // 出片时等真实外形到了再开始，免得前几帧是简化外形
  }).catch(e => { msg.textContent = '加载失败：' + e.message; throw e; });

  let novaReady = null;
  window.__reel = {
    ready, get novaReady() { return novaReady; }, get nova() { return !!nova; }, S, fps: FPS, get tl() { return tl; }, get plan() { return plan; }, get script() { return script; }, get armNow() { return armNow; }, freeCam, frame, applyScript, openScript, setView, runRepair, exportVideo,
    shot(i, n) { frame(i / FPS, n || 12); return out.toDataURL('image/jpeg', 0.92).slice(23); },
  };
})();
