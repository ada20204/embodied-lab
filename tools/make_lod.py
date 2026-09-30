#!/usr/bin/env python3
"""把一个 glb 抽稀成“首屏用”的精简版：逐个网格做顶点聚类，节点树、网格名和材质原样保留，
所以同一份关节 json 两个版本都能用。索引用 uint16。
两处照顾观感：聚类时按表面朝向（6 个主方向）分组，薄壳零件的内外表面不会被捏到一起；
法线取原模型法线在每个聚类里的平均，而不是在粗网格上重算，所以明暗和精细版一致、没有斑驳。
用法：python3 tools/make_lod.py in.glb out.glb [保留比例，默认 0.15]
只依赖 numpy。
"""
import json, struct, sys
import numpy as np

CT = {5121: np.uint8, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def read_glb(path):
    b = open(path, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    g = json.loads(b[20:20 + jl])
    bl = struct.unpack('<I', b[20 + jl:24 + jl])[0]
    return g, b[28 + jl:28 + jl + bl]


def accessor(g, bin_, i):
    a = g['accessors'][i]; bv = g['bufferViews'][a['bufferView']]
    t = CT[a['componentType']]; n = NC[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride', 0); size = np.dtype(t).itemsize * n
    if stride and stride != size:
        raw = np.frombuffer(bin_, np.uint8, count=stride * (a['count'] - 1) + size, offset=off)
        rows = np.lib.stride_tricks.as_strided(raw, (a['count'], size), (stride, 1))
        return np.frombuffer(rows.copy().tobytes(), t).reshape(a['count'], n)
    return np.frombuffer(bin_, t, count=a['count'] * n, offset=off).reshape(a['count'], n)


def vertex_normals(v, f):
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    fn = np.cross(b - a, c - a); n = np.zeros_like(v)
    for i in range(3): np.add.at(n, f[:, i], fn)
    l = np.linalg.norm(n, axis=1, keepdims=True); l[l == 0] = 1
    return n / l


def cluster(v, f, cell, vn):
    key = np.floor((v - v.min(0)) / cell).astype(np.int64)
    ax = np.abs(vn).argmax(1); sgn = np.take_along_axis(vn, ax[:, None], 1)[:, 0] > 0
    key = np.concatenate([key, (ax * 2 + sgn)[:, None]], 1)     # 朝向分组
    _, inv = np.unique(key, axis=0, return_inverse=True)
    inv = inv.ravel(); cnt = np.bincount(inv).astype(np.float64)
    nv = np.stack([np.bincount(inv, weights=v[:, i]) / cnt for i in range(3)], 1)
    nn = np.stack([np.bincount(inv, weights=vn[:, i]) for i in range(3)], 1)
    l = np.linalg.norm(nn, axis=1, keepdims=True); l[l == 0] = 1; nn = nn / l
    nf = inv[f]
    ok = (nf[:, 0] != nf[:, 1]) & (nf[:, 1] != nf[:, 2]) & (nf[:, 0] != nf[:, 2])
    nf = nf[ok]
    _, idx = np.unique(np.sort(nf, axis=1), axis=0, return_index=True)
    nf = nf[np.sort(idx)]
    used = np.unique(nf)                       # 去掉没被引用的顶点
    remap = np.full(len(nv), -1, np.int64); remap[used] = np.arange(len(used))
    return nv[used], remap[nf], nn[used]


def decimate(v, f, keep, vn, floor=60):
    target = max(int(len(f) * keep), floor)
    if len(f) <= target:
        return v, f, vn
    ext = float((v.max(0) - v.min(0)).max()) or 1.0
    lo, hi = ext / 2000, ext / 2
    best = cluster(v, f, hi, vn)
    for _ in range(22):
        mid = (lo + hi) / 2
        r = cluster(v, f, mid, vn)
        if len(r[1]) > target: lo = mid
        else: hi = mid; best = r
    return best


def main(src, dst, keep):
    g, bin_ = read_glb(src)
    out = bytearray(); views = []; accs = []
    def add(arr, target):
        while len(out) % 4: out.append(0)
        views.append({'buffer': 0, 'byteOffset': len(out), 'byteLength': arr.nbytes, 'target': target})
        out.extend(arr.tobytes()); return len(views) - 1
    tin = tout = 0
    for m in g['meshes']:
        for p in m['primitives']:
            v = accessor(g, bin_, p['attributes']['POSITION']).astype(np.float64)
            f = accessor(g, bin_, p['indices']).astype(np.int64).reshape(-1, 3) if 'indices' in p else np.arange(len(v)).reshape(-1, 3)
            vn = (accessor(g, bin_, p['attributes']['NORMAL']).astype(np.float64) if 'NORMAL' in p['attributes']
                  else vertex_normals(v, f))
            nv, nf, nn = decimate(v, f, keep, vn)
            tin += len(f); tout += len(nf)
            v32 = nv.astype(np.float32)
            it = np.uint16 if len(v32) < 65536 else np.uint32
            accs.append({'bufferView': add(v32, 34962), 'componentType': 5126, 'count': len(v32), 'type': 'VEC3',
                         'min': v32.min(0).tolist(), 'max': v32.max(0).tolist()})
            accs.append({'bufferView': add(nn.astype(np.float32), 34962), 'componentType': 5126, 'count': len(v32), 'type': 'VEC3'})
            accs.append({'bufferView': add(nf.astype(it).ravel(), 34963), 'componentType': 5123 if it is np.uint16 else 5125,
                         'count': nf.size, 'type': 'SCALAR'})
            p['attributes'] = {'POSITION': len(accs) - 3, 'NORMAL': len(accs) - 2}; p['indices'] = len(accs) - 1
    g['accessors'] = accs; g['bufferViews'] = views; g['buffers'] = [{'byteLength': len(out)}]
    g.setdefault('asset', {})['generator'] = (g['asset'].get('generator', '') + ' + make_lod.py(keep=%g)' % keep).strip()
    js = json.dumps(g, separators=(',', ':'), ensure_ascii=False).encode()
    js += b' ' * ((4 - len(js) % 4) % 4)
    while len(out) % 4: out.append(0)
    total = 28 + len(js) + len(out)
    open(dst, 'wb').write(struct.pack('<III', 0x46546C67, 2, total) + struct.pack('<II', len(js), 0x4E4F534A) + js +
                          struct.pack('<II', len(out), 0x004E4942) + bytes(out))
    print(f'{src} → {dst}: 三角面 {tin} → {tout}（{tout / tin:.0%}），{total / 1024:.0f} KB')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 0.15)
