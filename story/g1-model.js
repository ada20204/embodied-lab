/* 用 g1.json（层级/关节）+ g1.glb（抽稀网格）搭出 G1 的渲染节点树。 */
(function (root) {
  'use strict';
  const M4 = () => root.Stage3D.M4;

  function build(stage, parsed, spec) {
    const meshByName = {};
    parsed.meshes.forEach(m => { stage.uploadMesh(m); meshByName[m.name] = m; });
    const joints = {}, bodies = {}, geomPos = {};
    const wxyz = q => [q[1], q[2], q[3], q[0]];
    const walk = b => {
      const node = stage.node({ name: b.name, base: M4().fromQT(wxyz(b.quat), b.pos) });
      bodies[b.name] = node;
      if (b.joint) { node.axis = b.joint.axis; node.angle = 0; node.range = b.joint.range; joints[b.joint.name] = node; }
      (b.geoms || []).forEach(g => {
        const m = meshByName[g.mesh]; if (!m) return;
        geomPos[g.mesh] = g.pos;
        node.children.push(stage.node({ name: g.mesh, isGeom: true, base: M4().fromQT(wxyz(g.quat), g.pos), meshes: [m], color: g.rgba.slice(0, 3) }));
      });
      b.children.forEach(c => node.children.push(walk(c)));
      return node;
    };
    const rootNode = walk(spec.tree);

    // 头部指示灯：Menagerie 的模型没有灯，这里按头部的实际截面画一圈环带（位置是示意）
    let led = null;
    const head = meshByName.head_link, torso = bodies.torso_link;
    if (head && torso) {
      const P = head.prims[0].pos, off = geomPos.head_link || [0, 0, 0];
      let zmin = 1e9, zmax = -1e9;
      for (let i = 2; i < P.length; i += 3) { zmin = Math.min(zmin, P[i]); zmax = Math.max(zmax, P[i]); }
      const z0 = zmin + 0.66 * (zmax - zmin);
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let i = 0; i < P.length; i += 3) if (Math.abs(P[i + 2] - z0) < 0.006) { x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); y0 = Math.min(y0, P[i + 1]); y1 = Math.max(y1, P[i + 1]); }
      if (x1 > x0) {
        const c = [(x0 + x1) / 2 + off[0], (y0 + y1) / 2 + off[1], z0 + off[2]];
        const mesh = stage.makeBand({ name: 'head_led', c, rx: (x1 - x0) / 2 * 1.035 + 0.001, ry: (y1 - y0) / 2 * 1.035 + 0.001, h: 0.006, segments: 72, color: [0.13, 0.13, 0.15] });
        const node = stage.node({ name: 'head_led', isLed: true, meshes: [mesh] });
        torso.children.push(node);
        led = { node, center: c };
      }
    }
    return {
      root: rootNode, joints, bodies, led,
      /** 设置一组关节角（弧度）；未知关节忽略，超限位则截断 */
      set(pose) {
        for (const n of Object.keys(pose)) {
          const j = joints[n]; if (!j) continue;
          let v = pose[n];
          if (j.range) v = Math.min(Math.max(v, j.range[0]), j.range[1]);
          j.angle = v;
        }
      },
    };
  }
  root.G1Model = { build };
  if (typeof module !== 'undefined') module.exports = root.G1Model;
})(typeof window !== 'undefined' ? window : globalThis);
