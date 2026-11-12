/* 镜头脚本：studio 里唯一需要人来写的东西。纯函数，浏览器和 node 都能用。
 *
 * 一份脚本 = 场景（机械臂怎么摆、镜头视角）+ 主体（谁在演）+ 镜头列表。角度一律用“度”，距离用“米”，时间用“秒”。
 * {
 *   "name": "…", "bpm": 100, "attack": 0.12,
 *   "subject": { "type": "duck" | "product" },
 *   "rig": { "arm": true, "base": [x, y, z], "mount": "invert" | "side" | "bottom", "fov": 54 },
 *   "shots": [
 *     { "name": "…", "clip": "kick_left", "from": 0.55, "to": 1.5, "beats": 2, "ease": 3,
 *       "cam": { "az": [起, 止], "el": [起, 止], "dist": [起, 止], "roll": [起, 止], "fov": [起, 止]? } },
 *     { "name": "倒放", "reverse": true, "beats": 1, "ease": 2.6 },      // 把上一个镜头原路放回去
 *     { "name": "再来一次", "repeat": true, "beats": 1, "ease": 2.6 }   // 把上一个镜头再正放一遍
 *   ]
 * }
 * az：水平方位，0 = 从主体右侧（−Y 方向）看，90 = 正前方；el：俯仰，0 = 平视，90 = 正俯拍；roll：画面倾斜。
 * ease：先快后慢的程度，段首速度是平均速度的 ease 倍。attack：每段开头留给加速的比例（真机必须 > 0）。 */
(function (root) {
  'use strict';
  const D2R = Math.PI / 180;
  const SUBJECTS = {
    duck: { label: '小鸭子（仿真动作）', lookUp: 0.03, radius: 0.11, clips: true },
    product: { label: '静物 / 产品', lookUp: 0.085, radius: 0.075, clips: false },
    car: { label: '方程式赛车模型（1:12，车头朝 +x）', lookUp: 0.04, radius: 0.1, half: 0.14, clips: false },   // half：沿车长方向的半长（碰撞按一根横放的胶囊体算）
  };
  const MOUNTS = ['invert', 'side', 'bottom'];
  const DEF_RIG = { arm: true, base: [0.05, -0.85, 0.3], mount: 'invert', fov: 54 };
  const RANGE = {   // 面板滑块和校验共用
    az: [-180, 360, 1, '°'], el: [-5, 89, 1, '°'], dist: [0.15, 2.5, 0.01, ' m'], roll: [-45, 45, 1, '°'], fov: [15, 90, 1, '°'],
    beats: [1, 16, 1, ' 拍'], ease: [1, 6, 0.1, '×'],
  };
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const pair = v => Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]);
  const isBase = sh => !sh.reverse && !sh.repeat;

  /** 检查脚本，返回可读的问题列表（空 = 没问题）。clipDur: { 片段名: 时长秒 }，不传就不查片段 */
  function validate(sc, clipDur) {
    const E = [], at = (i, m) => E.push(`第 ${i + 1} 个镜头${sc.shots[i] && sc.shots[i].name ? `（${sc.shots[i].name}）` : ''}：${m}`);
    if (!sc || typeof sc !== 'object') return ['脚本必须是一个对象'];
    const sub = sc.subject && SUBJECTS[sc.subject.type];
    if (!sub) E.push(`subject.type 要写 ${Object.keys(SUBJECTS).join(' 或 ')}`);
    if (sc.subject && sc.subject.yaw !== undefined && !(num(sc.subject.yaw) && Math.abs(sc.subject.yaw) <= 180)) E.push('subject.yaw 要在 −180 到 180 度之间');
    if (sc.bpm !== undefined && !(num(sc.bpm) && sc.bpm >= 30 && sc.bpm <= 240)) E.push('bpm 要在 30–240 之间');
    if (sc.attack !== undefined && !(num(sc.attack) && sc.attack >= 0 && sc.attack <= 0.6)) E.push('attack 要在 0–0.6 之间');
    const rig = sc.rig || {};
    if (rig.base !== undefined && !(Array.isArray(rig.base) && rig.base.length === 3 && rig.base.every(num))) E.push('rig.base 要写成 [x, y, z]（米）');
    if (rig.mount !== undefined && !MOUNTS.includes(rig.mount)) E.push(`rig.mount 要写 ${MOUNTS.join(' / ')}`);
    if (rig.fov !== undefined && !(num(rig.fov) && rig.fov >= RANGE.fov[0] && rig.fov <= RANGE.fov[1])) E.push('rig.fov 要在 15–90 度之间');
    if (rig.arm !== false && !(sc.attack > 0)) E.push('用机械臂拍时 attack 必须大于 0（真机不能瞬间到最大速度）');
    if (!Array.isArray(sc.shots) || !sc.shots.length) { E.push('shots 至少要有一个镜头'); return E; }
    sc.shots.forEach((sh, i) => {
      if (!sh || typeof sh !== 'object') return at(i, '不是对象');
      if (!(num(sh.beats) && sh.beats >= RANGE.beats[0] && sh.beats <= RANGE.beats[1] && Number.isInteger(sh.beats))) at(i, 'beats 要是 1–16 的整数');
      if (sh.ease !== undefined && !(num(sh.ease) && sh.ease >= RANGE.ease[0] && sh.ease <= RANGE.ease[1])) at(i, 'ease 要在 1–6 之间');
      if (sh.reverse && sh.repeat) at(i, 'reverse 和 repeat 只能写一个');
      if (!isBase(sh)) { if (!sc.shots.slice(0, i).some(isBase)) at(i, '前面还没有可以倒放 / 重复的镜头'); return; }
      const c = sh.cam;
      if (!c || typeof c !== 'object') return at(i, '缺 cam（机位）');
      for (const k of ['az', 'el', 'dist']) if (!pair(c[k])) at(i, `cam.${k} 要写成 [起, 止]`);
      for (const k of ['az', 'el', 'dist', 'roll', 'fov']) if (c[k] !== undefined) { if (!pair(c[k])) { if (k === 'roll' || k === 'fov') at(i, `cam.${k} 要写成 [起, 止]`); } else if (c[k].some(v => v < RANGE[k][0] || v > RANGE[k][1])) at(i, `cam.${k} 超出范围 ${RANGE[k][0]}–${RANGE[k][1]}`); }
      if (sub && sub.clips) {
        if (typeof sh.clip !== 'string') return at(i, '缺 clip（演哪段动作）');
        if (!(num(sh.from) && num(sh.to) && sh.to > sh.from && sh.from >= 0)) return at(i, 'from / to 要是秒数，且 to 大于 from');
        if (clipDur) { if (!(sh.clip in clipDur)) at(i, `没有叫 ${sh.clip} 的动作`); else if (sh.to > clipDur[sh.clip] + 1e-6) at(i, `动作 ${sh.clip} 只有 ${clipDur[sh.clip].toFixed(2)} 秒`); }
      }
    });
    return E;
  }

  /** 脚本 → 时间轴用的内部镜头表（弧度）和各项设置。脚本有问题时抛出带全部问题的错误 */
  function compile(sc, clipDur) {
    const errs = validate(sc, clipDur);
    if (errs.length) { const e = new Error(errs.join('\n')); e.issues = errs; throw e; }
    const sub = Object.assign({ type: sc.subject.type, yaw: (sc.subject.yaw || 0) * D2R }, SUBJECTS[sc.subject.type]), rig = Object.assign({}, DEF_RIG, sc.rig || {});
    const rad = p => [p[0] * D2R, p[1] * D2R];
    const shots = sc.shots.map(sh => {
      const o = { name: sh.name || '', beats: sh.beats, k: sh.ease || 3 };
      if (sh.reverse) o.rev = true; else if (sh.repeat) o.again = true;
      else {
        o.clip = sub.clips ? sh.clip : null; o.s = sub.clips ? [sh.from, sh.to] : [0, 1];
        const c = sh.cam; o.cam = { az: rad(c.az), el: rad(c.el), dist: c.dist.slice(), roll: rad(c.roll || [0, 0]), fov: (c.fov || [rig.fov, rig.fov]).slice() };
      }
      return o;
    });
    return { name: sc.name || '未命名', bpm: sc.bpm || 100, attack: sc.attack || 0, subject: sub, rig, shots };
  }

  // ---- 面板用的小操作：都返回新脚本，不改原对象 ----
  const clone = sc => JSON.parse(JSON.stringify(sc));
  /** 第 i 个镜头实际用的是哪个“正放镜头”的机位（倒放 / 重复指向它前面最近的那个） */
  function baseIndex(sc, i) { for (let j = i; j >= 0; j--) if (isBase(sc.shots[j])) return j; return -1; }
  function addShot(sc, after, kind) {
    const n = clone(sc), b = baseIndex(n, after), src = b >= 0 ? n.shots[b] : null;
    let sh;
    if (kind === 'reverse') sh = { name: '倒放', reverse: true, beats: 2, ease: 3 };
    else if (kind === 'repeat') sh = { name: '再来一次', repeat: true, beats: 1, ease: 2.6 };
    else sh = src ? Object.assign(clone(src), { name: '新镜头' }) : { name: '新镜头', beats: 2, ease: 3, cam: { az: [-40, 30], el: [25, 12], dist: [0.5, 0.4], roll: [0, 0] } };
    n.shots.splice(after + 1, 0, sh); return n;
  }
  function removeShot(sc, i) {
    const n = clone(sc); if (n.shots.length <= 1) return n;
    n.shots.splice(i, 1);
    while (n.shots.length && !isBase(n.shots[0])) n.shots.shift();   // 开头不能留下没有来源的倒放
    return n;
  }
  /** 把第 i 个镜头往前（dir = −1）或往后（+1）挪。正放镜头带着跟在它后面的倒放 / 重复一起挪；倒放 / 重复只在自己那一组里换位置。挪不动就原样返回 */
  function groups(sc) { const G = []; sc.shots.forEach((sh, i) => { if (isBase(sh) || !G.length) G.push([i]); else G[G.length - 1].push(i); }); return G; }
  function moveShot(sc, i, dir) {
    const n = clone(sc), G = groups(n), gi = G.findIndex(g => g.includes(i)); let sel = i;
    if (isBase(n.shots[i])) {
      const gj = gi + dir; if (gj < 0 || gj >= G.length) return { script: n, sel };
      const order = G.map((g, k) => k); order[gi] = gj; order[gj] = gi;
      const out = []; order.forEach(k => { if (k === gi) sel = out.length; G[k].forEach(x => out.push(n.shots[x])); });
      n.shots = out;
    } else {
      const j = i + dir, g = G[gi]; if (j <= g[0] || j > g[g.length - 1]) return { script: n, sel };
      const t = n.shots[i]; n.shots[i] = n.shots[j]; n.shots[j] = t; sel = j;
    }
    return { script: n, sel };
  }
  /** 好读的写法：每个镜头一行 */
  function stringify(sc) {
    const head = Object.keys(sc).filter(k => k !== 'shots').map(k => `  ${JSON.stringify(k)}: ${JSON.stringify(sc[k])}`);
    return '{\n' + head.join(',\n') + ',\n  "shots": [\n' + sc.shots.map(s => '    ' + JSON.stringify(s)).join(',\n') + '\n  ]\n}';
  }

  const api = { SUBJECTS, MOUNTS, DEF_RIG, RANGE, validate, compile, clone, baseIndex, isBase, addShot, removeShot, moveShot, stringify };
  root.StudioScript = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
