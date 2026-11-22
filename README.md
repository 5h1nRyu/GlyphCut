# 字形切片 · GlyphCut

从网格上的直线和曲线制作模板，再按区块或闭合轮廓设计字形。支持导出 TrueType 字体，以及 SVG、PNG 字形图。

- [打开网页版](https://5h1nryu.github.io/GlyphCut/)
- [下载 Windows x64 免安装版](https://github.com/5h1nRyu/GlyphCut/releases)

Windows 版下载后完整解压，运行 `GlyphCut.exe`。网页与桌面版都能通过「保存项目」和「导入」交换 `.glyphs.json` 文件。网页的自动保存按浏览器和网址区分，从其他网址迁移时先导出项目。

## 本地运行与打包

- 网页入口是 `docs/index.html`。可以用 `python3 -m http.server 8000 --directory docs` 本地预览。
- 在仓库根目录运行 `python3 desktop/package-windows.py` 可生成 `GlyphCut-Windows-x64.zip`。脚本会获取并校验指定版本的 Electron，再把 `docs/` 中的网页复制进桌面程序。程序打包完成后可离线运行。
