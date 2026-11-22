# 字形切片 · GlyphCut

从网格上的直线和曲线制作模板，再按区块或闭合轮廓设计字形。支持导出 TrueType 字体，以及 SVG、PNG 字形图。

- [打开网页版](https://5h1nryu.github.io/GlyphCut/)
- [下载 Windows x64 免安装版](https://github.com/5h1nRyu/GlyphCut/releases)

Windows 版下载后完整解压，运行 `GlyphCut.exe`。程序启动后打开模板菜单，在具体模板页面可以创建字体。模板和字体分别保存于 `%APPDATA%\Glyph Cut\workspace`。网页的自动保存按浏览器和网址区分，可通过网页的「保存项目」和「导入」迁移。

## 本地运行与打包

- 网页入口是 `docs/index.html`。可以用 `python3 -m http.server 8000 --directory docs` 本地预览。
- 在仓库根目录运行 `python3 desktop/package-windows.py` 可生成 `GlyphCut-Windows-x64.zip`。脚本会获取并校验指定版本的 Electron，再把 `docs/` 中的网页复制进桌面程序。程序打包完成后可离线运行。
