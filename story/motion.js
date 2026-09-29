/* 动作数据：解析 Unitree 的 G1 重定向 CSV（LAFAN1），并按时间采样。
 * 格式（每行一帧，30 FPS，36 列）：根节点 x y z + 四元数 qx qy qz qw，然后 29 个关节角（弧度），
 * 顺序：左腿 6、右腿 6、腰 3、左臂 7、右臂 7。
 * 数据本身是 LAFAN1（Ubisoft，CC BY-NC-ND 4.0）经 Unitree 重定向而来。本页不内置也不再分发这些数据，
 * 播放时才从源站下载；这里只有解析和采样的代码。
 */
(function (root) {
  'use strict';
  const JOINTS = [
    'left_hip_pitch_joint', 'left_hip_roll_joint', 'left_hip_yaw_joint', 'left_knee_joint', 'left_ankle_pitch_joint', 'left_ankle_roll_joint',
    'right_hip_pitch_joint', 'right_hip_roll_joint', 'right_hip_yaw_joint', 'right_knee_joint', 'right_ankle_pitch_joint', 'right_ankle_roll_joint',
    'waist_yaw_joint', 'waist_roll_joint', 'waist_pitch_joint',
    'left_shoulder_pitch_joint', 'left_shoulder_roll_joint', 'left_shoulder_yaw_joint', 'left_elbow_joint', 'left_wrist_roll_joint', 'left_wrist_pitch_joint', 'left_wrist_yaw_joint',
    'right_shoulder_pitch_joint', 'right_shoulder_roll_joint', 'right_shoulder_yaw_joint', 'right_elbow_joint', 'right_wrist_roll_joint', 'right_wrist_pitch_joint', 'right_wrist_yaw_joint',
  ];
  const NJ = JOINTS.length, COLS = 7 + NJ, FPS = 30;

  // 可选片段（文件名与官方数据集 g1/ 目录一致）
  const CLIPS = [
    { id: 'dance1_subject1', cat: '舞蹈', name: '舞蹈 1' },
    { id: 'dance1_subject2', cat: '舞蹈', name: '舞蹈 2' },
    { id: 'dance2_subject1', cat: '舞蹈', name: '舞蹈 3' },
    { id: 'dance2_subject2', cat: '舞蹈', name: '舞蹈 4' },
    { id: 'dance2_subject3', cat: '舞蹈', name: '舞蹈 5' },
    { id: 'walk1_subject1', cat: '行走', name: '走路 1' },
    { id: 'walk2_subject1', cat: '行走', name: '走路 2' },
    { id: 'walk3_subject1', cat: '行走', name: '走路 3' },
    { id: 'walk4_subject1', cat: '行走', name: '走路 4' },
    { id: 'run1_subject2', cat: '跑步', name: '跑步 1' },
    { id: 'run1_subject5', cat: '跑步', name: '跑步 2' },
    { id: 'run2_subject1', cat: '跑步', name: '跑步 3' },
    { id: 'sprint1_subject2', cat: '跑步', name: '冲刺 1' },
    { id: 'sprint1_subject4', cat: '跑步', name: '冲刺 2' },
    { id: 'jumps1_subject1', cat: '跳跃', name: '跳跃 1' },
    { id: 'jumps1_subject2', cat: '跳跃', name: '跳跃 2' },
    { id: 'fight1_subject2', cat: '格斗', name: '格斗 1' },
    { id: 'fight1_subject3', cat: '格斗', name: '格斗 2' },
    { id: 'fightAndSports1_subject1', cat: '格斗', name: '格斗 + 运动' },
    { id: 'fallAndGetUp1_subject1', cat: '摔倒', name: '摔倒起身 1' },
    { id: 'fallAndGetUp1_subject4', cat: '摔倒', name: '摔倒起身 2' },
    { id: 'fallAndGetUp2_subject2', cat: '摔倒', name: '摔倒起身 3' },
  ];

  /** 解析 CSV 文本。列数不是 36 或出现非数字时抛错，说明是哪一行 */
  function parseCsv(text) {
    const lines = String(text).split(/\r?\n/);
    const rows = [];
    for (let i = 0; i < lines.length; i++) { const l = lines[i].trim(); if (l) rows.push([i + 1, l]); }
    if (!rows.length) throw new Error('文件是空的');
    const n = rows.length, rootv = new Float32Array(n * 7), q = new Float32Array(n * NJ);
    for (let r = 0; r < n; r++) {
      const parts = rows[r][1].split(',');
      if (parts.length !== COLS) throw new Error(`第 ${rows[r][0]} 行有 ${parts.length} 列；这个页面只支持 G1 的 ${COLS} 列 CSV（H1、H1_2 的列数不同）`);
      for (let c = 0; c < COLS; c++) {
        const v = +parts[c];
        if (!Number.isFinite(v)) throw new Error(`第 ${rows[r][0]} 行第 ${c + 1} 列不是数字`);
        if (c < 7) rootv[r * 7 + c] = v; else q[r * NJ + c - 7] = v;
      }
    }
    return { fps: FPS, n, nj: NJ, joints: JOINTS, root: rootv, q };
  }

  /** 小鸭子的片段：assets/duck/motions/*.json，frames 是 n 行，每行 7+nj 个数（根 xyz + 四元数 xyzw + 关节角），50 FPS */
  const DUCK_CLIPS = [
    { id: 'walk_forward', cat: '行走', name: '前进走' },
    { id: 'walk_curve', cat: '行走', name: '边走边转' },
    { id: 'walk_s', cat: '行走', name: 'S 形走' },
    { id: 'walk_stop', cat: '行走', name: '走走停停' },
    { id: 'combo', cat: '组合', name: '走→踢→坐→站→转弯' },
    { id: 'sit_stand', cat: '技能', name: '坐下站起' },
    { id: 'kick_left', cat: '技能', name: '左脚踢' },
    { id: 'kick_right', cat: '技能', name: '右脚踢' },
    { id: 'roll', cat: '技能', name: '翻滚' },
    { id: 'ground_pick', cat: '技能', name: '低头抓地' },
  ];
  function fromJson(d) {
    if (!d || !Array.isArray(d.joints) || !Array.isArray(d.frames) || !(d.fps > 0)) throw new Error('片段格式不对：需要 fps、joints、frames');
    const nj = d.joints.length, cols = 7 + nj, n = d.frames.length;
    if (n < 2) throw new Error('至少要有 2 帧');
    for (let r = 0; r < n; r++) if (!Array.isArray(d.frames[r]) || d.frames[r].length !== cols) throw new Error(`第 ${r + 1} 帧应有 ${cols} 个数`);
    const rootv = new Float32Array(n * 7), q = new Float32Array(n * nj);
    for (let r = 0; r < n; r++) for (let c = 0; c < cols; c++) {
      const v = +d.frames[r][c];
      if (!Number.isFinite(v)) throw new Error(`第 ${r + 1} 帧第 ${c + 1} 个数不是数字`);
      if (c < 7) rootv[r * 7 + c] = v; else q[r * nj + c - 7] = v;
    }
    return { fps: d.fps, n, nj, joints: d.joints.slice(), root: rootv, q };
  }

  const duration = clip => (clip.n - 1) / clip.fps;

  /** 在 t 秒采样：位置线性插值，四元数取最短路径的归一化线性插值，关节角线性插值。结果写进 out，避免每帧分配 */
  function sample(clip, t, out) {
    const f = Math.min(Math.max(t * clip.fps, 0), clip.n - 1), i = Math.floor(f), j = Math.min(i + 1, clip.n - 1), a = f - i;
    const R = clip.root, ri = i * 7, rj = j * 7;
    for (let k = 0; k < 3; k++) out.pos[k] = R[ri + k] + (R[rj + k] - R[ri + k]) * a;
    let dot = 0; for (let k = 3; k < 7; k++) dot += R[ri + k] * R[rj + k];
    const sg = dot < 0 ? -1 : 1; let l = 0;
    for (let k = 0; k < 4; k++) { const v = R[ri + 3 + k] + (sg * R[rj + 3 + k] - R[ri + 3 + k]) * a; out.quat[k] = v; l += v * v; }
    l = Math.sqrt(l) || 1; for (let k = 0; k < 4; k++) out.quat[k] /= l;
    const nj = clip.nj || NJ, Q = clip.q, qi = i * nj, qj = j * nj;
    for (let k = 0; k < nj; k++) out.q[k] = Q[qi + k] + (Q[qj + k] - Q[qi + k]) * a;
    return out;
  }
  const makeOut = () => ({ pos: [0, 0, 0], quat: [0, 0, 0, 1], q: new Float32Array(64) });
  /** 关节数组 → { 关节名: 弧度 } */
  function toPose(q, into, joints) { const o = into || {}, J = joints || JOINTS; for (let k = 0; k < J.length; k++) o[J[k]] = q[k]; return o; }

  const api = { JOINTS, CLIPS, DUCK_CLIPS, fromJson, FPS, COLS, parseCsv, duration, sample, makeOut, toPose };
  root.G1Motion = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
