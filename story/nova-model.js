/* 越疆 Nova5 双臂模型（glb，Y 向上、毫米）→ Z 向上、米。关节轴取自 nova5_joints.json。 */
(function (root) {
  'use strict';
  const AX = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
  function build(stage, parsed, spec) {
    const M4 = root.Stage3D.M4, s = Math.SQRT1_2;
    // Y-up → Z-up：绕 X 轴 +90°；毫米 → 米
    const base = M4.fromQT([s, 0, 0, s], [0, 0, 0], [0.001, 0.001, 0.001]);
    const r = stage.instantiate(parsed, { base });
    const joints = {};
    spec.joints.forEach(j => {
      const n = r.byName[j.name]; if (!n) return;
      n.axis = AX[j.axis]; n.angle = 0; n.range = [j.limit_min, j.limit_max]; joints[j.name] = n;
    });
    // 材质偏暖白的部件保持原色；夹爪是占位几何，统一压暗，避免被当成真实夹爪
    Object.keys(r.byName).forEach(k => { if (/gripper/.test(k)) r.byName[k].color = [0.42, 0.45, 0.5]; });
    return {
      root: r, joints,
      set(pose) { for (const k of Object.keys(pose)) { const j = joints[k]; if (!j) continue; j.angle = Math.min(Math.max(pose[k], j.range[0]), j.range[1]); } },
    };
  }
  root.NovaModel = { build };
  if (typeof module !== 'undefined') module.exports = root.NovaModel;
})(typeof window !== 'undefined' ? window : globalThis);
