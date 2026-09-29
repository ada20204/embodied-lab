/* G1 讲解员的姿态与手势（示意）。
 * 关节角是手工设定的，用来演示"回复 → 动作"的对应关系，不是宇树的真实动作轨迹。
 * `action` 是 g1-voice-interaction-pipeline 白名单里的动作编号；没有对应项的手势写 null，页面上标"页面自定"。
 * 纯数据 + 插值，不依赖渲染，Node 里可测。
 */
(function (root) {
  'use strict';

  // 右臂五个关节：[肩俯仰, 肩滚转, 肩偏航, 肘, 腕滚转]（负的肩俯仰 = 手臂向前上抬）
  const ARM = ['shoulder_pitch', 'shoulder_roll', 'shoulder_yaw', 'elbow', 'wrist_roll'];
  // 左臂 = 右臂镜像：俯仰、肘不变，滚转、偏航、腕滚转取反
  const MIRROR = [1, -1, -1, 1, -1];

  const REST = [0.02, -0.32, 0, 0.6, 0];

  const GESTURES = {
    idle: {
      label: '待机', action: { id: 99, name: '释放手臂' }, note: '两臂自然下垂',
      right: REST, left: REST, turn: 0,
    },
    wave: {
      label: '挥手', action: { id: 26, name: '高位挥手' }, note: '右手举到头侧，前臂来回摆动',
      right: [-1.80, -0.95, -0.55, 0.50, -0.10], rightB: [-1.80, -0.95, -0.25, 1.05, -0.10], f: 1.6,
      left: REST, turn: 0.15,
    },
    point: {
      label: '指向', action: null, note: '右臂伸直指向侧前方（指向内容区）',
      right: [-0.35, -1.45, 0.0, 1.50, 0.0], left: REST, turn: 0.2,
    },
    clap: {
      label: '鼓掌', action: { id: 17, name: '鼓掌' }, note: '双手在胸前一开一合',
      right: [-0.392, -0.127, 0.033, -0.255, 0.154], rightB: [-0.573, 0.198, 0.123, 0.008, -0.215], f: 2.6,
      mirrorLeft: true, turn: 0,
    },
    present: {
      label: '展示', action: null, note: '双手掌心向上前伸，介绍内容',
      right: [-0.835, -0.422, -0.363, 0.791, 0.582], mirrorLeft: true, turn: 0,
    },
  };

  const smooth = x => x * x * (3 - 2 * x);

  function armDict(side, vals) {
    const o = {};
    ARM.forEach((n, i) => { o[`${side}_${n}_joint`] = vals[i]; });
    return o;
  }
  const mirrorVals = v => v.map((x, i) => x * MIRROR[i]);

  /** 手势在时刻 t（秒）的目标关节角（只包含被这个手势控制的关节） */
  function poseFor(id, t) {
    const g = GESTURES[id] || GESTURES.idle;
    let r = g.right;
    if (g.rightB) { // 往复：A↔B
      const s = 0.5 - 0.5 * Math.cos(2 * Math.PI * g.f * (t || 0));
      r = g.right.map((a, i) => a + (g.rightB[i] - a) * s);
    }
    const l = mirrorVals(g.mirrorLeft ? r : (g.left || REST)); // 左臂数值按右臂的约定写，这里统一镜像
    const p = Object.assign(armDict('right', r), armDict('left', l));
    p.waist_yaw_joint = g.turn || 0;
    return p;
  }

  /** 所有手势用到的关节角（含往复两端），供限位检查 */
  function allPoses() {
    const out = [];
    for (const id of Object.keys(GESTURES)) { out.push([id + ':A', poseFor(id, 0)]); if (GESTURES[id].rightB) out.push([id + ':B', poseFor(id, 0.5 / GESTURES[id].f)]); }
    return out;
  }

  /** 平滑逼近：把当前关节角朝目标推进 dt 秒（指数平滑，rate 越大越快） */
  function approach(cur, target, dt, rate) {
    const k = 1 - Math.exp(-(rate || 6) * dt);
    for (const n of Object.keys(target)) cur[n] = (cur[n] === undefined ? 0 : cur[n]) + (target[n] - (cur[n] === undefined ? 0 : cur[n])) * k;
    return cur;
  }

  const api = { GESTURES, ARM, MIRROR, REST, poseFor, allPoses, approach, smooth };
  root.G1Poses = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
