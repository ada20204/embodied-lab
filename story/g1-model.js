/* 用 g1.json（层级/关节）+ g1.glb（抽稀网格）搭出 G1 的渲染节点树。 */
(function (root) {
  'use strict';
  const M4 = () => root.Stage3D.M4;

  function build(stage, parsed, spec) {
    const meshByName = {};
    parsed.meshes.forEach(m => { stage.uploadMesh(m); meshByName[m.name] = m; });
    const joints = {}, bodies = {};
    const wxyz = q => [q[1], q[2], q[3], q[0]];
    const walk = b => {
      const node = stage.node({ name: b.name, base: M4().fromQT(wxyz(b.quat), b.pos) });
      bodies[b.name] = node;
      if (b.joint) { node.axis = b.joint.axis; node.angle = 0; node.range = b.joint.range; joints[b.joint.name] = node; }
      (b.geoms || []).forEach(g => {
        const m = meshByName[g.mesh]; if (!m) return;
        node.children.push(stage.node({ name: g.mesh, isGeom: true, base: M4().fromQT(wxyz(g.quat), g.pos), meshes: [m], color: g.rgba.slice(0, 3) }));
      });
      b.children.forEach(c => node.children.push(walk(c)));
      return node;
    };
    const rootNode = walk(spec.tree);
    return {
      root: rootNode, joints, bodies,
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
