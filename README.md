# 个人工作面板

一个本地运行的个人工作面板，用来管理 TODO、项目书架和常用个人信息。源码模式下，项目数据默认保存在本机 `data` 目录中；桌面应用模式下，首次启动会提示默认数据目录并允许改选，后续会自动记住。

## 1 功能简介

- TODO：记录便笺和待办内容。
- 项目书架：以书架形式管理项目，支持多页项目内容编辑。
- 项目内容编辑器：基于 Novel 编辑器，支持标题、加粗、斜体、列表、引用、代码块等格式。
- 常用个人信息：保存常用标签、账号、地址、说明等信息。
- 配色方案：支持多套本地主题配色。
- 本地数据：通过本地 Node 服务读写 `data/*.json`，不依赖云端。

## 2 首次运行

### 2.1 安装 Node.js

如果电脑还没有安装 Node.js，请先安装：

https://nodejs.org/

安装完成后，可以在终端中检查：

```powershell
node --version
```

能看到版本号就说明安装成功。

### 2.2 双击启动源码版

- macOS：双击 `Start WorkWeb.command`
- Windows：双击 `Start WorkWeb.vbs`

如果 Windows 启动失败，双击 `Start WorkWeb.bat`，会停下来显示错误信息。

## 3 桌面应用封装

### 3.1 开发模式启动

```powershell
npm install
npm run desktop
```

启动后会以独立桌面应用窗口打开，任务栏是单独图标，不再依赖浏览器标签页。

### 3.2 打包

Windows:

```powershell
npm run pack:win
```

macOS:

```bash
npm run pack:mac
```

打包产物会输出到 `release` 目录。

说明：

- Windows 安装包建议在 Windows 上构建。
- macOS `.app` / `.dmg` 建议在 macOS 上构建。
- Windows 安装包支持自定义安装目录，选择路径时会自动补上 `WorkWeb`。
- 当前仓库已经忽略了 `node_modules`、`release`、`runtime`、本地数据等无用上传内容。

## 4 数据保存位置

`data` 文件夹中主要文件包括：

- `notes/*.json`：TODO 和便笺数据。
- `projects/*.json`：项目书架数据。
- `info.json`：常用个人信息数据。

桌面应用模式：

- 首次启动时会弹窗提示默认数据目录
- 默认目录是安装目录下的 `data`
- 选择完成后会写入本机应用配置，后续启动直接复用
- 默认目录不存在时会自动创建
- 如果已记录的数据目录不可写，会再次要求重新选择
