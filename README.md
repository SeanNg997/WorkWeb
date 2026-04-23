# 个人工作面板

一个本地运行的个人工作面板，用来管理 TODO、项目书架和常用个人信息。项目数据默认保存在本机 `data` 目录中，适合离线使用和本地备份。

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

### 2.2 双击启动

- macOS：双击 `Start WorkWeb.command`
- Windows：双击 `Start WorkWeb.vbs`

如果 Windows 启动失败，双击 `Start WorkWeb.bat`，窗口不会一闪而过，会停下来显示错误信息。

## 3 数据保存位置

`data`文件夹中主要文件包括：

- `notes.json`：TODO 和便笺数据。
- `projects.json`：项目书架数据。
- `info.json`：常用个人信息数据。
