# 字形切片 · GlyphCut

字形切片是一款以网格模板设计字形的 Windows 桌面应用。用直线和曲线把画布切成区块，再为拉丁字母和数字填充区块。同一套模板可以用来设计多套字体。

[下载 Windows x64 免安装版](https://github.com/5h1nRyu/GlyphCut/releases/latest/download/GlyphCut-Windows-x64.zip) · [发行记录](https://github.com/5h1nRyu/GlyphCut/releases) · [打开网页版](https://5h1nryu.github.io/GlyphCut/)

## 快速开始

1. 下载 ZIP，完整解压到同一目录，运行 `GlyphCut.exe`。
2. 在模板菜单新建或导入模板，用网格上的直线和曲线划分区块。
3. 使用模板创建字体，逐字填充区块，然后预览排版并导出。

## 主要功能

- **模板编辑**支持可调网格、曲线、区块禁用和自动简化。
- **字形设计**支持按区块填充，也可沿模板边界选点并闭合轮廓后填充。
- **导入与导出**支持拖入模板和字体项目 JSON，并导出 TTF 字体、SVG 或 PNG 字形图。
- **本地工作**支持自动保存和离线编辑。项目存放在 `%APPDATA%\Glyph Cut\workspace`。可在窗口右上角检查更新。

## 网页版

网页版支持模板和字体项目库、自动保存和离线编辑。首次联网加载完成后即可离线打开。项目保存在当前浏览器，可通过导出项目 JSON 在网页和 Windows 程序之间迁移。

发布网页资源变更时，同步更新 `docs/service-worker.js` 中的缓存版本，以便已打开的网页版加载新版本。

## 从源码打包

在仓库根目录使用 Python 3.12 或更新版本运行以下命令，生成 `GlyphCut-Windows-x64.zip`。

```sh
python -m pip install -r desktop/build-requirements.txt
python desktop/package-windows.py
```

已有 Electron ZIP 时，可将其路径作为打包脚本的第一个参数。也可在 GitHub Actions 中手动运行「打包 Windows x64」，从运行结果下载构建产物。

## 许可证

GlyphCut 以 [MIT 许可证](LICENSE) 发布。Electron 运行时的许可证随免安装包提供。
