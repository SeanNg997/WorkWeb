"""逐帧渲染 index.html 为 MP4。用法: python3 render.py [--fps 60] [--stills 1,4,7] [--out WorkWeb_15s.mp4]"""
import argparse, subprocess, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument('--fps', type=int, default=60)
ap.add_argument('--out', default='workweb-promo-24s-1080p.mp4')
ap.add_argument('--stills', default='', help='只导出这些秒数的静帧（逗号分隔）用于检查')
a = ap.parse_args()

with sync_playwright() as p:
    br = p.chromium.launch()
    pg = br.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
    pg.on('pageerror', lambda e: print('页面错误:', e))
    pg.on('console', lambda m: m.type == 'error' and print('控制台错误:', m.text))
    pg.goto((HERE / 'index.html').as_uri() + '?render=1')
    pg.wait_for_function('window.__ready === true')
    dur = pg.evaluate('window.__duration')

    if a.stills:
        out = HERE / 'stills'; out.mkdir(exist_ok=True)
        for s in a.stills.split(','):
            pg.evaluate(f'__seek({float(s) * 1000})')
            pg.screenshot(path=str(out / f't{float(s):05.2f}.png'))
        print('stills ->', out); br.close(); sys.exit()

    n = round(dur / 1000 * a.fps)
    ff = subprocess.Popen(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', str(a.fps),
                           '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p',
                           '-tune', 'animation', '-movflags', '+faststart', str(HERE / a.out)], stdin=subprocess.PIPE)
    t0 = time.time()
    for f in range(n):
        pg.evaluate(f'__seek({f * 1000 / a.fps})')
        ff.stdin.write(pg.screenshot(type='png'))
        if f % a.fps == 0 or f == n - 1:
            print(f'\r帧 {f + 1}/{n}  ({(f + 1) / n:5.1%})  {time.time() - t0:5.1f}s', end='', flush=True)
    ff.stdin.close(); ff.wait(); br.close()
    print('\n输出:', HERE / a.out)
