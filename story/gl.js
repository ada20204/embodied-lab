/* 极简 WebGL2 场景渲染器：读 glb、画带关节的层级模型。不依赖任何库。
 * 坐标：Z 向上（MuJoCo 惯例）。Y-up 的 glTF 模型用根节点旋转放进来。
 * 用法：
 *   const st = Stage3D.create(canvas);
 *   const meshes = Stage3D.parseGLB(arrayBuffer);            // {json, meshes:[{name,prims}], nodes}
 *   const root = st.instantiate(meshes, {scale:0.001, ...});  // glTF 节点树 → 渲染节点
 *   node.angle = 0.3; st.render();
 */
(function (root) {
  'use strict';

  // ---------- 数学（列主序 mat4） ----------
  const M4 = {
    id() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
    mul(a, b, o) {
      o = o || new Float32Array(16);
      for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
      return o;
    },
    fromQT(q, t, s) { // q=[x,y,z,w]
      const [x, y, z, w] = q, sx = s ? s[0] : 1, sy = s ? s[1] : 1, sz = s ? s[2] : 1;
      const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
      return new Float32Array([
        (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
        2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
        2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
        t[0], t[1], t[2], 1]);
    },
    axisAngle(ax, a) {
      const l = Math.hypot(ax[0], ax[1], ax[2]) || 1, s = Math.sin(a / 2) / l;
      return M4.fromQT([ax[0] * s, ax[1] * s, ax[2] * s, Math.cos(a / 2)], [0, 0, 0]);
    },
    perspective(fovy, asp, n, f) {
      const t = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
      o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f); return o;
    },
    lookAt(e, c, u) {
      let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2]; let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
      let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx; l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
      const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
      return new Float32Array([xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
        -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1]);
    },
    normalMat(m) { // 上 3x3 的逆转置（行列式≠0）
      const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
      const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
      let det = a * A + b * B + c * C; det = det || 1;
      const k = 1 / det;
      return new Float32Array([A * k, B * k, C * k, (c * h - b * i) * k, (a * i - c * g) * k, (b * g - a * h) * k, (b * f - c * e) * k, (c * d - a * f) * k, (a * e - b * d) * k]);
    },
  };

  // ---------- GLB 解析 ----------
  const CT = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  const NC = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

  function readAccessor(g, bin, idx) {
    const a = g.accessors[idx], bv = g.bufferViews[a.bufferView], T = CT[a.componentType], n = NC[a.type];
    const off = (bv.byteOffset || 0) + (a.byteOffset || 0), stride = bv.byteStride || 0;
    if (!stride || stride === n * T.BYTES_PER_ELEMENT) {
      const ab = bin.buffer.slice(bin.byteOffset + off, bin.byteOffset + off + a.count * n * T.BYTES_PER_ELEMENT);
      return new T(ab);
    }
    const out = new T(a.count * n), dv = new DataView(bin.buffer, bin.byteOffset + off);
    for (let i = 0; i < a.count; i++) for (let k = 0; k < n; k++) {
      const p = i * stride + k * T.BYTES_PER_ELEMENT;
      out[i * n + k] = T === Float32Array ? dv.getFloat32(p, true) : T === Uint16Array ? dv.getUint16(p, true) : T === Uint32Array ? dv.getUint32(p, true) : dv.getUint8(p);
    }
    return out;
  }

  function calcNormals(pos, idx) {
    const n = new Float32Array(pos.length);
    for (let t = 0; t < idx.length; t += 3) {
      const i = idx[t] * 3, j = idx[t + 1] * 3, k = idx[t + 2] * 3;
      const ux = pos[j] - pos[i], uy = pos[j + 1] - pos[i + 1], uz = pos[j + 2] - pos[i + 2];
      const vx = pos[k] - pos[i], vy = pos[k + 1] - pos[i + 1], vz = pos[k + 2] - pos[i + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const p of [i, j, k]) { n[p] += nx; n[p + 1] += ny; n[p + 2] += nz; }
    }
    for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1; n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
    return n;
  }

  function parseGLB(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('不是 glb 文件');
    let off = 12, g = null, bin = null;
    while (off < buf.byteLength) {
      const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      const body = new Uint8Array(buf, off + 8, len);
      if (type === 0x4E4F534A) g = JSON.parse(new TextDecoder().decode(body));
      else if (type === 0x004E4942) bin = body;
      off += 8 + len + ((4 - len % 4) % 4);
    }
    const meshes = (g.meshes || []).map((m, mi) => ({
      name: m.name || ('mesh' + mi),
      prims: m.primitives.filter(p => (p.mode === undefined || p.mode === 4)).map(p => {
        const pos = readAccessor(g, bin, p.attributes.POSITION);
        const idx = p.indices !== undefined ? readAccessor(g, bin, p.indices) : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);
        const nrm = p.attributes.NORMAL !== undefined ? readAccessor(g, bin, p.attributes.NORMAL) : calcNormals(pos, idx);
        const mat = p.material !== undefined ? g.materials[p.material] : null;
        const c = mat && mat.pbrMetallicRoughness && mat.pbrMetallicRoughness.baseColorFactor || [0.75, 0.75, 0.78, 1];
        return { pos, nrm, idx: idx instanceof Uint32Array ? idx : Uint32Array.from(idx), color: c.slice(0, 3) };
      }),
    }));
    return { json: g, meshes };
  }

  // ---------- 渲染器 ----------
  const VS = `#version 300 es
  in vec3 aPos; in vec3 aNrm;
  uniform mat4 uVP; uniform mat4 uModel; uniform mat3 uNrm;
  out vec3 vN; out vec3 vW;
  void main(){ vec4 w = uModel*vec4(aPos,1.0); vW = w.xyz; vN = uNrm*aNrm; gl_Position = uVP*w; }`;
  const FS = `#version 300 es
  precision highp float;
  in vec3 vN; in vec3 vW;
  uniform vec3 uColor; uniform vec3 uEye; uniform vec3 uBg; uniform vec3 uTint; uniform float uTintK;
  uniform vec3 uEmis; uniform vec3 uGlowPos; uniform vec3 uGlowCol;
  uniform vec3 uL; uniform vec3 uKeyCol; uniform float uAmb; uniform float uKey; uniform float uFill; uniform float uRim; uniform float uSpec;
  out vec4 o;
  void main(){
    vec3 n = normalize(vN); vec3 v = normalize(uEye - vW);
    if(dot(n,v) < 0.0) n = -n;
    float hemi = n.z*0.5+0.5;
    float key = max(dot(n, uL), 0.0);
    vec3 Lf = normalize(vec3(-uL.x, -uL.y, 0.25));
    float fill = max(dot(n, Lf), 0.0);
    float rim = pow(1.0 - max(dot(n,v),0.0), 3.0);
    float spec = pow(max(dot(n, normalize(uL+v)), 0.0), 48.0) * step(0.0, dot(n,uL));
    vec3 base = mix(uColor, uTint, uTintK);
    vec3 col = base*(uAmb*(0.48+0.52*hemi) + uKey*key*uKeyCol + uFill*fill) + rim*vec3(0.20,0.26,0.32)*uRim + spec*uSpec*uKeyCol;
    vec3 gv = uGlowPos - vW; float gd2 = dot(gv,gv);
    col += base * uGlowCol * (1.0/(1.0+60.0*gd2)) * (max(dot(n,normalize(gv)),0.0)*0.75+0.25) * 1.6;
    col += uEmis;
    float d = length(uEye - vW);
    col = mix(col, uBg, clamp((d-3.2)/6.0, 0.0, 0.85));
    o = vec4(col, 1.0);
  }`;
  const PFS = `#version 300 es
  precision highp float; uniform vec4 uId; out vec4 o; void main(){ o = uId; }`;
  const GVS = `#version 300 es
  in vec3 aPos; uniform mat4 uVP; out vec3 vW; out vec2 vUV; void main(){ vW=aPos; gl_Position=uVP*vec4(aPos,1.0); }`;
  const GFS = `#version 300 es
  precision highp float; in vec3 vW; uniform vec3 uCol; uniform float uR; out vec4 o;
  void main(){ float d=length(vW.xy); float a=(1.0-smoothstep(uR*0.35,uR,d))*0.55; o=vec4(uCol,a); }`;
  const SFS = `#version 300 es
  precision highp float; in vec3 vW; uniform vec3 uCol; uniform vec2 uC; uniform float uR; out vec4 o;
  void main(){ float d=length(vW.xy-uC)/uR; float a=(1.0-smoothstep(0.0,1.0,d)); o=vec4(uCol,a*a*0.6); }`;

  function sh(gl, type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function prog(gl, vs, fs) {
    const p = gl.createProgram(); gl.attachShader(p, sh(gl, gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p;
  }

  function create(canvas, opt) {
    opt = opt || {};
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, preserveDrawingBuffer: !!opt.preserve });
    if (!gl) return null;
    const bg = opt.bg || [0.055, 0.063, 0.075];
    const P = prog(gl, VS, FS), GP = prog(gl, GVS, GFS), SP = prog(gl, GVS, SFS), PK = prog(gl, VS, PFS);
    const U = n => gl.getUniformLocation(P, n);
    const u = { vp: U('uVP'), model: U('uModel'), nrm: U('uNrm'), color: U('uColor'), eye: U('uEye'), bg: U('uBg'), tint: U('uTint'), tintK: U('uTintK'), L: U('uL'), keyCol: U('uKeyCol'), amb: U('uAmb'), key: U('uKey'), fill: U('uFill'), rim: U('uRim'), spec: U('uSpec'), emis: U('uEmis'), glowPos: U('uGlowPos'), glowCol: U('uGlowCol') };
    const pk = { vp: gl.getUniformLocation(PK, 'uVP'), model: gl.getUniformLocation(PK, 'uModel'), nrm: gl.getUniformLocation(PK, 'uNrm'), id: gl.getUniformLocation(PK, 'uId') };
    let fbo = null, fboW = 0, fboH = 0, rbC = null, rbD = null;

    // 地面网格
    const gl_ = []; const S = 4, step = 0.25;
    for (let i = -S; i <= S + 1e-6; i += step) { gl_.push(i, -S, 0, i, S, 0, -S, i, 0, S, i, 0); }
    const gridVao = gl.createVertexArray(); gl.bindVertexArray(gridVao);
    const gridBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(gl_), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const gridN = gl_.length / 3;
    const quadVao = gl.createVertexArray(); gl.bindVertexArray(quadVao);
    const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0].map((v, i) => v * (i % 3 === 2 ? 1 : 6))), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    /** 遍历节点树：更新世界矩阵与父指针，对带网格的节点调用 fn(node, 继承的着色) */
    const ZERO3 = [0, 0, 0];
    const traverse = (n, pw, tint, fn) => {
      if (!n.visible) return;
      let local = n.base;
      if (n.axis && n.angle) local = M4.mul(local, M4.axisAngle(n.axis, n.angle));
      n.world = M4.mul(pw, local, n.world === undefined ? undefined : n.world);
      const tk = n.tint || tint;
      for (const c of n.children) c.parent = n;
      if (n.meshes.length) fn(n, tk);
      for (const c of n.children) traverse(c, n.world, tk, fn);
    };
    function ensureFbo(W, H) {
      if (fbo && fboW === W && fboH === H) return;
      if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteRenderbuffer(rbC); gl.deleteRenderbuffer(rbD); }
      fbo = gl.createFramebuffer(); rbC = gl.createRenderbuffer(); rbD = gl.createRenderbuffer(); fboW = W; fboH = H;
      gl.bindRenderbuffer(gl.RENDERBUFFER, rbC); gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, W, H);
      gl.bindRenderbuffer(gl.RENDERBUFFER, rbD); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, W, H);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rbC);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rbD);
    }

    const st = {
      gl, canvas, roots: [], bg, grid: opt.grid !== false,
      camera: { target: [0, 0, 0.8], dist: 3, az: 0.6, el: 0.25, fov: 35 },
      shadows: [], // {c:[x,y], r}
      /** 灯光：az/el 为主光方向（度，az 0 = 机器人正前方），其余为相对默认值的倍率；temp -1 冷 … +1 暖 */
      light: { az: -48, el: 46, key: 1, amb: 1, fill: 1, rim: 1, spec: 1, temp: 0 },
      uploadMesh(m) {
        m.prims.forEach(p => {
          if (p.vao) return;
          p.vao = gl.createVertexArray(); gl.bindVertexArray(p.vao);
          const b1 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b1); gl.bufferData(gl.ARRAY_BUFFER, p.pos, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
          const b2 = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b2); gl.bufferData(gl.ARRAY_BUFFER, p.nrm, gl.STATIC_DRAW);
          gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
          const b3 = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b3); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, p.idx, gl.STATIC_DRAW);
          p.count = p.idx.length;
        });
      },
      /** 节点：{name, base(mat4), axis?, angle?, meshes:[mesh], color?, children, visible} */
      node(o) { return Object.assign({ name: '', base: M4.id(), angle: 0, axis: null, meshes: [], color: null, children: [], visible: true, world: M4.id() }, o); },
      /** glTF 节点树 → 渲染节点；opt.scale/opt.base 控制根部变换 */
      instantiate(parsed, opt2) {
        opt2 = opt2 || {};
        parsed.meshes.forEach(m => st.uploadMesh(m));
        const gj = parsed.json, byName = {};
        const build = i => {
          const n = gj.nodes[i];
          let base = n.matrix ? new Float32Array(n.matrix) : M4.fromQT(n.rotation || [0, 0, 0, 1], n.translation || [0, 0, 0], n.scale);
          const node = st.node({ name: n.name || ('n' + i), base, meshes: n.mesh !== undefined ? [parsed.meshes[n.mesh]] : [] });
          byName[node.name] = node;
          (n.children || []).forEach(c => node.children.push(build(c)));
          return node;
        };
        const sc = gj.scenes[gj.scene || 0].nodes.map(build);
        const rootNode = st.node({ name: 'root', base: opt2.base || M4.id(), children: sc });
        rootNode.byName = byName;
        return rootNode;
      },
      /** 椭圆环带（开口圆柱面）：中心 c、半轴 rx/ry、半高 h；返回已上传的网格 */
      makeBand(o) {
        const N = o.segments || 64, pos = new Float32Array(N * 2 * 3), nrm = new Float32Array(N * 2 * 3), idx = [];
        for (let i = 0; i < N; i++) {
          const a = i / N * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
          let nx = ca / o.rx, ny = sa / o.ry; const l = Math.hypot(nx, ny); nx /= l; ny /= l;
          for (let r = 0; r < 2; r++) {
            const k = (i * 2 + r) * 3;
            pos[k] = o.c[0] + o.rx * ca; pos[k + 1] = o.c[1] + o.ry * sa; pos[k + 2] = o.c[2] + (r ? -o.h : o.h);
            nrm[k] = nx; nrm[k + 1] = ny; nrm[k + 2] = 0;
          }
          const j = (i + 1) % N; idx.push(i * 2, i * 2 + 1, j * 2, j * 2, i * 2 + 1, j * 2 + 1);
        }
        const m = { name: o.name || 'band', prims: [{ pos, nrm, idx: Uint32Array.from(idx), color: o.color || [0.15, 0.15, 0.17] }] };
        st.uploadMesh(m); return m;
      },
      add(node) { st.roots.push(node); return node; },
      resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.max(2, Math.round(canvas.clientWidth * dpr)), h = Math.max(2, Math.round(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      },
      viewProj(c, asp) {
        c = c || st.camera; const az = c.az, el = c.el;
        const eye = [c.target[0] + c.dist * Math.cos(el) * Math.sin(az), c.target[1] - c.dist * Math.cos(el) * Math.cos(az), c.target[2] + c.dist * Math.sin(el)];
        asp = asp || canvas.width / canvas.height;
        // 窄屏加大视野，避免模型被裁掉
        const fov = (c.fov * (asp < 0.9 ? 1 + (0.9 - asp) * 0.9 : 1)) * Math.PI / 180;
        st.eye = eye;
        const P = M4.perspective(fov, asp, 0.05, 40);
        P[8] = -(c.sx || 0); P[9] = -(c.sy || 0); // 把被摄物平移到屏幕右侧/上方，给文字卡片让位
        return M4.mul(P, M4.lookAt(eye, c.target, [0, 0, 1]));
      },
      /** 点选：(cx, cy) 为相对画布左上角的 CSS 像素；参数同 render。离屏用唯一颜色画一遍，读该像素，返回被点中的节点（没点中返回 null） */
      pick(cx, cy, o) {
        o = o || {}; st.resize();
        const W = canvas.width, H = canvas.height, k = W / Math.max(1, canvas.clientWidth), vpr = o.viewport || [0, 0, 1, 1];
        const px = [Math.round(vpr[0] * W), Math.round((1 - vpr[1] - vpr[3]) * H), Math.max(2, Math.round(vpr[2] * W)), Math.max(2, Math.round(vpr[3] * H))];
        const X = Math.round(cx * k), Y = H - 1 - Math.round(cy * k);
        if (X < px[0] || X >= px[0] + px[2] || Y < px[1] || Y >= px[1] + px[3]) return null;
        ensureFbo(W, H);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(px[0], px[1], px[2], px[3]); gl.enable(gl.SCISSOR_TEST); gl.scissor(X, Y, 1, 1);
        gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.depthMask(true);
        gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        const vp = st.viewProj(o.camera, px[2] / px[3]);
        gl.useProgram(PK); gl.uniformMatrix4fv(pk.vp, false, vp);
        const list = [null];
        (o.roots || st.roots).forEach(r => traverse(r, M4.id(), null, n => {
          list.push(n); const id = list.length - 1;
          gl.uniform4f(pk.id, (id & 255) / 255, ((id >> 8) & 255) / 255, 0, 1);
          gl.uniformMatrix4fv(pk.model, false, n.world); gl.uniformMatrix3fv(pk.nrm, false, M4.normalMat(n.world));
          for (const m of n.meshes) for (const p of m.prims) { gl.bindVertexArray(p.vao); gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0); }
        }));
        const buf = new Uint8Array(4); gl.readPixels(X, Y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.disable(gl.SCISSOR_TEST);
        return list[buf[0] | (buf[1] << 8)] || null;
      },
      /** o.viewport=[x,y,w,h]（占画布的比例，原点在左上）；o.roots/o.camera 可覆盖；o.clearColor=false 只清深度（叠加渲染） */
      render(o) {
        o = o || {};
        st.resize();
        const W = canvas.width, H = canvas.height, vpr = o.viewport || [0, 0, 1, 1];
        const px = [Math.round(vpr[0] * W), Math.round((1 - vpr[1] - vpr[3]) * H), Math.max(2, Math.round(vpr[2] * W)), Math.max(2, Math.round(vpr[3] * H))];
        gl.viewport(px[0], px[1], px[2], px[3]); gl.enable(gl.SCISSOR_TEST); gl.scissor(px[0], px[1], px[2], px[3]);
        if (o.clearColor !== false) { gl.clearColor(st.bg[0], st.bg[1], st.bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT); } else gl.clear(gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.DEPTH_TEST);
        const vp = st.viewProj(o.camera, px[2] / px[3]);
        const roots = o.roots || st.roots, showGrid = o.grid !== undefined ? o.grid : st.grid;
        // 地面
        if (showGrid) {
          gl.useProgram(GP); gl.uniformMatrix4fv(gl.getUniformLocation(GP, 'uVP'), false, vp);
          gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
          gl.uniform3f(gl.getUniformLocation(GP, 'uCol'), 0.30, 0.38, 0.46); gl.uniform1f(gl.getUniformLocation(GP, 'uR'), 3.4);
          gl.bindVertexArray(gridVao); gl.drawArrays(gl.LINES, 0, gridN);
          gl.useProgram(SP); gl.uniformMatrix4fv(gl.getUniformLocation(SP, 'uVP'), false, vp);
          gl.uniform3f(gl.getUniformLocation(SP, 'uCol'), 0, 0, 0);
          gl.bindVertexArray(quadVao);
          st.shadows.forEach(s => { gl.uniform2f(gl.getUniformLocation(SP, 'uC'), s.c[0], s.c[1]); gl.uniform1f(gl.getUniformLocation(SP, 'uR'), s.r); gl.drawArrays(gl.TRIANGLES, 0, 6); });
          gl.depthMask(true); gl.disable(gl.BLEND);
        }
        gl.useProgram(P);
        gl.uniformMatrix4fv(u.vp, false, vp); gl.uniform3fv(u.eye, st.eye); gl.uniform3fv(u.bg, st.bg);
        const Lt = st.light, ra = Lt.az * Math.PI / 180, re = Lt.el * Math.PI / 180, tt = Lt.temp;
        gl.uniform3f(u.L, Math.cos(re) * Math.cos(ra), Math.cos(re) * Math.sin(ra), Math.sin(re));
        gl.uniform3f(u.keyCol, 1 + 0.14 * tt, 1 + 0.02 * tt, 1 - 0.18 * tt);
        const gw = o.glow || { pos: [0, 0, 0], col: [0, 0, 0] };
        gl.uniform3fv(u.glowPos, gw.pos); gl.uniform3fv(u.glowCol, gw.col);
        gl.uniform1f(u.amb, 0.58 * Lt.amb); gl.uniform1f(u.key, 0.62 * Lt.key); gl.uniform1f(u.fill, 0.16 * Lt.fill); gl.uniform1f(u.rim, Lt.rim); gl.uniform1f(u.spec, 0.14 * Lt.spec);
        const drawNode = (n, tk) => {
          gl.uniformMatrix4fv(u.model, false, n.world); gl.uniformMatrix3fv(u.nrm, false, M4.normalMat(n.world));
          const tn = n.tintSelf || tk;
          gl.uniform3fv(u.emis, n.emissive || ZERO3);
          for (const m of n.meshes) for (const p of m.prims) {
            const c = n.color || p.color;
            gl.uniform3f(u.color, c[0], c[1], c[2]);
            if (tn) { gl.uniform3f(u.tint, tn.c[0], tn.c[1], tn.c[2]); gl.uniform1f(u.tintK, tn.k); } else gl.uniform1f(u.tintK, 0);
            gl.bindVertexArray(p.vao); gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_INT, 0);
          }
        };
        roots.forEach(r => traverse(r, M4.id(), null, drawNode));
        gl.disable(gl.SCISSOR_TEST);
      },
    };
    return st;
  }

  root.Stage3D = { create, parseGLB, M4 };
  if (typeof module !== 'undefined') module.exports = root.Stage3D;
})(typeof window !== 'undefined' ? window : globalThis);
