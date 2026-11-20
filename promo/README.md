# WorkWeb 宣传片

- 成片：`workweb-promo-24s-1080p.mp4`（1920×1080 · 60 fps · 24.4 s · H.264，无音轨）
- 封面：`poster.jpg`（README 中引用）
- 源码：`index.html`（HTML + CSS + Web Animations API，全部图形由 CSS/SVG 绘制；`assets/project-covers.png` 为项目封面素材）
- 渲染：`render.py`（Playwright 逐帧截图 → ffmpeg 编码）

## 预览与导出

```bash
# 浏览器直接打开 index.html 即可循环预览，空格键暂停
pip install playwright && playwright install chromium   # 需要本机已安装 ffmpeg
python3 render.py                       # 导出完整视频（约 12 分钟）
python3 render.py --stills 3,9.5,21.9   # 只导出指定秒数的静帧到 stills/
```

## 结构

| 时间 | 内容 |
| --- | --- |
| 0 – 2.7 s | 片头：W 书写，蓝点落下 |
| 2.4 – 4.5 s | 01 TODO 便笺：琐碎事项，记录待办 |
| 5.3 – 8.0 s | 02 项目书架：科研项目，分册整理 |
| 8.8 – 11.8 s | 03 常用个人信息：常用信息，快捷复制 |
| 12.6 – 16.1 s | 04 运动日志：记录运动，展示趋势 |
| 16.9 – 19.8 s | 05 软件皮肤：四款皮肤，随心切换 |
| 19.8 – 22.8 s | 收尾：五个页面依次逆时针入轨，逐颗坠入蓝点 |
| 22.8 – 24.4 s | 白光转场，WorkWeb 字标与「科研个人工作台」 |

演示文字与数据为虚构，界面元件与软件一致。
