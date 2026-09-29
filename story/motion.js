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
    { id: 'dance2_subject1', cat: '舞蹈', name: '舞蹈 2' },
    { id: 'walk1_subject1', cat: '行走', name: '走路' },
    { id: 'run1_subject2', cat: '跑步', name: '跑步' },
    { id: 'sprint1_subject2', cat: '跑步', name: '冲刺' },
    { id: 'jumps1_subject1', cat: '跳跃', name: '跳跃' },
    { id: 'fight1_subject2', cat: '格斗', name: '格斗' },
    { id: 'fallAndGetUp1_subject1', cat: '摔倒', name: '摔倒起身' },
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
    return { fps: FPS, n, root: rootv, q };
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
    const Q = clip.q, qi = i * NJ, qj = j * NJ;
    for (let k = 0; k < NJ; k++) out.q[k] = Q[qi + k] + (Q[qj + k] - Q[qi + k]) * a;
    return out;
  }
  const makeOut = () => ({ pos: [0, 0, 0], quat: [0, 0, 0, 1], q: new Float32Array(NJ) });
  /** 关节数组 → { 关节名: 弧度 } */
  function toPose(q, into) { const o = into || {}; for (let k = 0; k < NJ; k++) o[JOINTS[k]] = q[k]; return o; }

  const api = { JOINTS, CLIPS, FPS, COLS, parseCsv, duration, sample, makeOut, toPose };
  root.G1Motion = api;
  if (typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
