#!/usr/bin/env python3
"""把 Studio 页面逐帧渲染成 mp4（不实时：每帧画完再取，所以慢机器也能出顺滑成片）。
用法：python3 tools/render_reel.py --url http://localhost:8765/embodied-lab/studio/ --out reel.mp4 [--script duck-arm 或 脚本文件.json] [--samples 8] [--workers 2]
依赖：playwright（chromium）、ffmpeg、numpy。音轨是脚本自己合成的节拍（底鼓 + 换镜头时的扫频），没有用任何现成音乐。
"""
import argparse, asyncio, base64, math, os, subprocess, sys, wave
import numpy as np

ENC = ['-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p']


async def worker(url, a, b, samples, path, script=None):
    from playwright.async_api import async_playwright
    tmp = path + '.part.mp4'
    ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'mjpeg', '-i', '-', *ENC, tmp], stdin=subprocess.PIPE)
    async with async_playwright() as p:
        br = await p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await br.new_page(viewport={'width': 1300, 'height': 800})
        await pg.goto(url); await pg.evaluate('__reel.ready')
        if script: await pg.evaluate('s => { const e = __reel.applyScript(s, { noStore: true }); if (e.length) throw new Error(e.join("; ")); }', script)
        for i in range(a, b):
            ff.stdin.write(base64.b64decode(await pg.evaluate(f'__reel.shot({i},{samples})')))
            if (i - a) % 30 == 0: print(f'[{a}-{b}] {i - a}/{b - a}', flush=True)
        await br.close()
    ff.stdin.close()
    if ff.wait() != 0: raise SystemExit('ffmpeg 失败')
    os.replace(tmp, path)


def beat_track(path, beats, dur, sr=44100):
    n = int(dur * sr) + sr // 2; y = np.zeros(n); rng = np.random.default_rng(7)
    def add(t0, sig):
        i = int(t0 * sr); j = min(n, i + len(sig)); y[i:j] += sig[:j - i]
    for b in beats:
        L = int(0.28 * sr); t = np.arange(L) / sr
        f = 44 + (150 if b['strong'] else 95) * np.exp(-t * 28)
        add(b['t'], (0.9 if b['strong'] else 0.5) * np.sin(2 * np.pi * np.cumsum(f) / sr) * np.exp(-t * (11 if b['strong'] else 16)))
        if b['cut']:   # 换镜头：一小段带通噪声扫过去，像“唰”的一声
            L2 = int(0.32 * sr); t2 = np.arange(L2) / sr; noise = rng.standard_normal(L2)
            k = np.exp(-np.linspace(0, 6, 400)); noise = np.convolve(noise, k / k.sum(), 'same') * 3
            add(max(0, b['t'] - 0.1), 0.22 * noise * np.sin(np.pi * t2 / 0.32) ** 2)
        else:
            L3 = int(0.05 * sr); add(b['t'] + 0.0, 0.05 * rng.standard_normal(L3) * np.exp(-np.arange(L3) / sr * 90))
    y = np.tanh(y * 1.2) * 0.8
    with wave.open(path, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((y * 32767).astype('<i2').tobytes())


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--url', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--range', type=int, nargs=2, help='只渲染这一段帧（无音轨），用来补拍某个镜头')
    ap.add_argument('--samples', type=int, default=8); ap.add_argument('--workers', type=int, default=2); ap.add_argument('--script', help='示例脚本名（duck-arm / duck-free / product-arm）或一个脚本 json 文件')
    a = ap.parse_args()
    script = None; url = a.url + ('&' if '?' in a.url else '?') + 'render=1'
    if a.script and os.path.exists(a.script): import json; script = json.load(open(a.script))
    elif a.script: url += '&script=' + a.script
    from playwright.async_api import async_playwright
    async with async_playwright() as p:
        br = await p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await br.new_page(); await pg.goto(url); await pg.evaluate('__reel.ready')
        if script: await pg.evaluate('s => { const e = __reel.applyScript(s, { noStore: true }); if (e.length) throw new Error(e.join("; ")); }', script)
        info = await pg.evaluate('(()=>{const t=__reel.tl;return {dur:t.dur,beats:Reel.beats(t)}})()'); await br.close()
    if a.range:
        r0, r1 = a.range; mid = (r0 + r1) // 2; base = os.path.splitext(a.out)[0]; parts = [base + '.a.mp4', base + '.b.mp4']
        await asyncio.gather(worker(url, r0, mid, a.samples, parts[0], script), worker(url, mid, r1, a.samples, parts[1], script))
        lst = base + '.txt'; open(lst, 'w').write(''.join(f"file '{os.path.abspath(x)}'\n" for x in parts))
        subprocess.check_call(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', base + '.tmp.mp4']); os.replace(base + '.tmp.mp4', a.out)
        for x in parts + [lst]: os.remove(x)
        print('完成', a.out); return
    hold = 0.8                                           # 结尾多停一会儿
    total = math.ceil((info['dur'] + hold) * 30)
    base = os.path.splitext(a.out)[0]
    cuts = [round(total * k / a.workers) for k in range(a.workers + 1)]
    parts = [f'{base}.part{k}.mp4' for k in range(a.workers)]
    await asyncio.gather(*[worker(url, cuts[k], cuts[k + 1], a.samples, parts[k], script) for k in range(a.workers)])
    lst = base + '.txt'; open(lst, 'w').write(''.join(f"file '{os.path.abspath(x)}'\n" for x in parts))
    wav = base + '.wav'; beat_track(wav, info['beats'], total / 30)
    tmp = base + '.tmp.mp4'
    subprocess.check_call(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', tmp])
    os.replace(tmp, a.out)
    for x in parts + [lst, wav]: os.remove(x)
    print('完成', a.out, f'{total} 帧')

asyncio.run(main())
