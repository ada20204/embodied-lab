#!/usr/bin/env python3
"""把站点里的一个页面打包成单个 HTML 文件（用来发布成 Claude artifact，或离线打开）。

单文件里不能再去取别的文件，所以：
- <link rel="stylesheet"> 和 <script src> 原样内联，顺序不变；
- 页面运行时 fetch 的模型、动作、脚本按 base64 嵌进去，由一小段 fetch 垫片按原来的相对路径返回；
  （artifact 里连 data: 地址也不让 fetch，所以垫片自己解码成 Response，而不是转发给 fetch）
- 指向站点其他页面的相对链接改成 GitHub Pages 上的绝对地址。

G1 的 LAFAN1 动作（CC BY-NC-ND）不嵌入，仍在播放时从源站下载；artifact 里网络被禁用时那部分会提示下载失败。

用法：
  python3 tools/bundle_artifact.py studio            # → dist/nova-studio.html
  python3 tools/bundle_artifact.py story -o x.html   # → x.html
"""
import argparse, base64, glob, json, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = 'https://ada20204.github.io/embodied-lab/'
REPO = 'https://github.com/ada20204/embodied-lab/blob/main/'

# 每个页面要嵌入的资源：仓库里的路径（可带通配）。页面里按“相对页面目录”的路径去取它们。
PAGES = {
    'studio': {
        'out': 'nova-studio.html',
        'assets': ['assets/duck/duck.glb', 'assets/duck/duck.json', 'assets/duck/motions/*.json',
                   'assets/nova/nova5.glb', 'assets/nova/nova5_joints.json', 'studio/scripts/*.json'],
    },
    'story': {
        'out': 'portfolio.html',
        'assets': ['assets/g1/g1.glb', 'assets/g1/g1_lo.glb', 'assets/g1/g1.json',
                   'assets/duck/duck.glb', 'assets/duck/duck_lo.glb', 'assets/duck/duck.json', 'assets/duck/motions/*.json',
                   'assets/nova/nova5.glb', 'assets/nova/nova5_lo.glb', 'assets/nova/nova5_joints.json'],
    },
}
MIME = {'.glb': 'application/octet-stream', '.json': 'application/json', '.csv': 'text/csv'}
LIMIT = 16 * 1024 * 1024   # artifact 单页上限


def read(p):
    with open(p, encoding='utf-8') as f:
        return f.read()


def bundle(page):
    cfg, pdir = PAGES[page], os.path.join(ROOT, page)
    html = read(os.path.join(pdir, 'index.html'))
    title = re.search(r'<title>(.*?)</title>', html, re.S).group(1).strip()
    head, body = re.search(r'<head>(.*?)</head>', html, re.S).group(1), re.search(r'<body>(.*?)</body>', html, re.S).group(1)

    styles = re.findall(r'<style>(.*?)</style>', head, re.S)
    styles += [read(os.path.join(pdir, h)) for h in re.findall(r'<link rel="stylesheet" href="([^"]+)">', head)]
    scripts = re.findall(r'<script src="([^"]+)"></script>', body)
    body = re.sub(r'\s*<script src="[^"]+"></script>', '', body)
    assert '<script' not in body, '页面里有内联脚本，打包脚本还不支持'

    def link(m):   # 站内相对链接 → Pages 上的绝对地址；仓库文件 → GitHub
        href = m.group(1)
        if href.startswith(('http', '#', 'mailto:')):
            return m.group(0)
        path = os.path.normpath(os.path.join(page, href)).replace(os.sep, '/')
        if path in ('.', 'index.html'):
            path = ''
        elif path.startswith('index.html#'):
            path = path[len('index.html'):]
        elif os.path.isfile(os.path.join(ROOT, path)) and not path.endswith('.html'):
            return f'href="{REPO}{path}"'
        elif os.path.isdir(os.path.join(ROOT, path)):
            path += '/'
        return f'href="{SITE}{path}"'
    body = re.sub(r'href="([^"]*)"', link, body)

    assets = {}
    for pat in cfg['assets']:
        files = sorted(glob.glob(os.path.join(ROOT, pat)))
        assert files, f'找不到资源：{pat}'
        for f in files:
            rel = os.path.relpath(f, pdir).replace(os.sep, '/')
            with open(f, 'rb') as fh:
                assets[rel] = 'data:' + MIME[os.path.splitext(f)[1]] + ';base64,' + base64.b64encode(fh.read()).decode()
    shim = ('<script>(function(){const A=' + json.dumps(assets) + ';const f=window.fetch.bind(window);'
            'function dec(u){const i=u.indexOf(","),mime=u.slice(5,u.indexOf(";")),bin=atob(u.slice(i+1)),n=bin.length,b=new Uint8Array(n);'
            'for(let k=0;k<n;k++)b[k]=bin.charCodeAt(k);return new Response(b,{status:200,headers:{"Content-Type":mime}});}'
            'window.fetch=function(u,o){const k=String(u);return A[k]?Promise.resolve(dec(A[k])):f(u,o);};})();</script>')
    js = ['<script>\n' + read(os.path.join(pdir, s)).replace('</script', '<\\/script') + '\n</script>' for s in scripts]
    out = ('<meta name="claude:viewport-fit-sides" content="cover">\n<title>' + title + '</title>\n'
           + ''.join('<style>' + s + '</style>\n' for s in styles) + body.strip() + '\n' + shim + '\n' + '\n'.join(js) + '\n')
    return out, len(assets)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('page', choices=sorted(PAGES))
    ap.add_argument('-o', '--out', help='输出文件（默认 dist/<名字>.html）')
    a = ap.parse_args()
    out, n = bundle(a.page)
    dst = a.out or os.path.join(ROOT, 'dist', PAGES[a.page]['out'])
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, 'w', encoding='utf-8') as f:
        f.write(out)
    size = len(out.encode('utf-8'))
    print(f'{dst}：{size / 1048576:.2f} MB，嵌入 {n} 个资源')
    if size > LIMIT:
        sys.exit('超过 artifact 的 16 MB 上限')


if __name__ == '__main__':
    main()
