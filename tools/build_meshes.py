#!/usr/bin/env python3
"""从原始 STL 生成页面用的两档 glb：精修版（默认保留约 25% 面数）和首屏精简版（约 5%）。
- 抽稀用 meshoptimizer 的 meshopt_simplify（二次误差度量，保形状、保边界），不是顶点聚类；
- 法线按折角分裂：夹角大于 CREASE 度的相邻面各用各的法线，棱角清楚、曲面平滑；
- 法线用归一化 int8 存（KHR_mesh_quantization），每个顶点省 8 字节；
- 网格名和顺序取自现有的关节 json，glb 与 json 一一对应，页面代码不用改。

依赖：numpy；meshoptimizer 编成共享库（MIT）：
    git clone --depth 1 https://github.com/zeux/meshoptimizer && g++ -O2 -shared -fPIC -o libmeshopt.so meshoptimizer/src/*.cpp
用法：
    python3 tools/build_meshes.py --xml g1.xml --assets <STL 目录> --json assets/g1/g1.json --out assets/g1/g1 \\
        --lib ./libmeshopt.so --copyright "..." [--hi 0.25 --lo 0.05]
"""
import argparse, ctypes, json, os, struct
import xml.etree.ElementTree as ET
import numpy as np

CREASE = 40.0


def read_stl(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[80:84])[0]
    if 84 + 50 * n == len(b):
        d = np.frombuffer(b, dtype=np.dtype([('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')]), count=n, offset=84)
        return d['v'].reshape(-1, 3).astype(np.float64)
    vs = [[float(x) for x in t.split()[1:4]] for t in b.decode('ascii', 'ignore').splitlines() if t.strip().startswith('vertex')]
    return np.array(vs, np.float64)


def weld(tri):
    q = np.round(tri * 1e6).astype(np.int64)
    u, inv = np.unique(q, axis=0, return_inverse=True)
    f = inv.ravel().reshape(-1, 3)
    f = f[(f[:, 0] != f[:, 1]) & (f[:, 1] != f[:, 2]) & (f[:, 0] != f[:, 2])]
    return u.astype(np.float64) / 1e6, f


class Meshopt:
    def __init__(self, path):
        L = ctypes.CDLL(path)
        L.meshopt_simplify.restype = ctypes.c_size_t
        L.meshopt_simplify.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t,
                                       ctypes.c_size_t, ctypes.c_size_t, ctypes.c_float, ctypes.c_uint, ctypes.POINTER(ctypes.c_float)]
        L.meshopt_optimizeVertexCache.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_size_t]
        self.L = L

    def simplify(self, v, f, ratio, max_err):
        idx = np.ascontiguousarray(f.ravel(), np.uint32); pos = np.ascontiguousarray(v, np.float32)
        target = max(int(len(idx) * ratio) // 3 * 3, 3 * 40)
        if target >= len(idx):
            return f
        out = np.empty_like(idx); err = ctypes.c_float()
        n = self.L.meshopt_simplify(out.ctypes.data, idx.ctypes.data, len(idx), pos.ctypes.data, len(pos), 12, target,
                                    ctypes.c_float(max_err), 0, ctypes.byref(err))
        return out[:n].astype(np.int64).reshape(-1, 3)

    def vcache(self, f, nv):
        idx = np.ascontiguousarray(f.ravel(), np.uint32); out = np.empty_like(idx)
        self.L.meshopt_optimizeVertexCache(out.ctypes.data, idx.ctypes.data, len(idx), nv)
        return out.astype(np.int64).reshape(-1, 3)


def crease_normals(v, f, crease=CREASE):
    """每个角（面×顶点）的法线 = 共享该顶点、且与本面夹角小于 crease 的面法线（面积加权）之和；再按(顶点, 法线)去重拆点"""
    a, b, c = v[f[:, 0]], v[f[:, 1]], v[f[:, 2]]
    fr = np.cross(b - a, c - a)                                   # 面积加权
    fl = np.linalg.norm(fr, axis=1, keepdims=True); fl[fl == 0] = 1
    fu = fr / fl
    cv = f.ravel(); cf = np.repeat(np.arange(len(f)), 3)
    order = np.argsort(cv, kind='stable'); sv = cv[order]
    starts = np.r_[0, np.flatnonzero(np.diff(sv)) + 1]; sizes = np.diff(np.r_[starts, len(sv)])
    gs = np.repeat(sizes, sizes); g0 = np.repeat(starts, sizes)          # 每个排序后角所在组的大小/起点
    A = np.repeat(np.arange(len(sv)), gs)                                 # 配对：组内两两
    off = np.arange(len(A)) - np.repeat(np.cumsum(gs) - gs, gs)
    B = np.repeat(g0, gs) + off
    ca, cb = order[A], order[B]
    ok = np.einsum('ij,ij->i', fu[cf[ca]], fu[cf[cb]]) > np.cos(np.radians(crease))
    cn = np.stack([np.bincount(ca[ok], weights=fr[cf[cb[ok]], i], minlength=len(cv)) for i in range(3)], 1)
    l = np.linalg.norm(cn, axis=1, keepdims=True); l[l == 0] = 1; cn /= l
    key = np.concatenate([cv[:, None], np.round(cn * 127).astype(np.int64)], 1)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    return v[cv[first]], cn[first], inv.ravel().reshape(-1, 3)


def build_glb(meshes, copyright):
    bin_ = bytearray(); bv, acc, msh = [], [], []
    def add(arr, target):
        while len(bin_) % 4: bin_.append(0)
        bv.append({'buffer': 0, 'byteOffset': len(bin_), 'byteLength': arr.nbytes, 'target': target}); bin_.extend(arr.tobytes())
        return len(bv) - 1
    for name, v, n, f in meshes:
        v32 = v.astype(np.float32)
        n8 = np.zeros((len(n), 4), np.int8); n8[:, :3] = np.clip(np.round(n * 127), -127, 127)   # 每个法线 4 字节（第 4 位补齐对齐）
        it, ct = (np.uint16, 5123) if len(v32) < 65536 else (np.uint32, 5125)
        acc.append({'bufferView': add(v32, 34962), 'componentType': 5126, 'count': len(v32), 'type': 'VEC3', 'min': v32.min(0).tolist(), 'max': v32.max(0).tolist()})
        acc.append({'bufferView': add(n8, 34962), 'componentType': 5120, 'normalized': True, 'count': len(n8), 'type': 'VEC3'})
        bv[-1]['byteStride'] = 4
        acc.append({'bufferView': add(f.astype(it).ravel(), 34963), 'componentType': ct, 'count': f.size, 'type': 'SCALAR'})
        k = len(acc) - 3
        msh.append({'name': name, 'primitives': [{'attributes': {'POSITION': k, 'NORMAL': k + 1}, 'indices': k + 2, 'mode': 4}]})
    g = {'extensionsUsed': ['KHR_mesh_quantization'], 'extensionsRequired': ['KHR_mesh_quantization'], 'asset': {'version': '2.0', 'generator': 'build_meshes.py (meshoptimizer simplify + crease normals)', 'copyright': copyright},
         'scene': 0, 'scenes': [{'nodes': list(range(len(msh)))}], 'nodes': [{'name': m['name'], 'mesh': i} for i, m in enumerate(msh)],
         'meshes': msh, 'accessors': acc, 'bufferViews': bv, 'buffers': [{'byteLength': len(bin_)}]}
    js = json.dumps(g, separators=(',', ':'), ensure_ascii=False).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
    while len(bin_) % 4: bin_.append(0)
    return (struct.pack('<III', 0x46546C67, 2, 28 + len(js) + len(bin_)) + struct.pack('<II', len(js), 0x4E4F534A) + js +
            struct.pack('<II', len(bin_), 0x004E4942) + bytes(bin_))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--xml', required=True); ap.add_argument('--assets', required=True); ap.add_argument('--json', required=True)
    ap.add_argument('--out', required=True); ap.add_argument('--lib', required=True); ap.add_argument('--copyright', default='')
    ap.add_argument('--hi', type=float, default=0.25); ap.add_argument('--lo', type=float, default=0.05)
    ap.add_argument('--hi-err', type=float, default=0.004); ap.add_argument('--lo-err', type=float, default=0.03)
    a = ap.parse_args()
    mo = Meshopt(a.lib)
    root = ET.parse(a.xml).getroot()
    files = {}
    for m in root.find('asset').findall('mesh'):
        fn = m.get('file'); files[m.get('name') or os.path.splitext(os.path.basename(fn))[0]] = fn
    names = json.load(open(a.json))['meshes']
    src = [(nm, *weld(read_stl(os.path.join(a.assets, files[nm])))) for nm in names]
    for tag, ratio, err, suffix in [('精修', a.hi, a.hi_err, ''), ('精简', a.lo, a.lo_err, '_lo')]:
        out, t0, t1 = [], 0, 0
        for nm, v, f in src:
            sf = mo.simplify(v, f, ratio, err)
            used = np.unique(sf); remap = np.full(len(v), -1, np.int64); remap[used] = np.arange(len(used))
            sv, sf = v[used], remap[sf]
            pv, pn, pf = crease_normals(sv, sf)
            pf = mo.vcache(pf, len(pv))
            out.append((nm, pv, pn, pf)); t0 += len(f); t1 += len(pf)
        glb = build_glb(out, a.copyright)
        open(a.out + suffix + '.glb', 'wb').write(glb)
        print(f'{tag}：三角面 {t0} → {t1}（{t1 / t0:.0%}），{len(glb) / 1024:.0f} KB → {a.out + suffix}.glb')


if __name__ == '__main__':
    main()
