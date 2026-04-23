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

### 2.2 进入项目目录

打开 PowerShell，进入项目目录：

```powershell
cd D:\WorkSpace\WorkWeb
```

### 2.3 启动本地服务

运行：

```powershell
node server.js
```

看到类似下面的提示，说明服务已经启动：

```text
工作面板已启动: http://localhost:3000
数据目录: D:\WorkSpace\WorkWeb\data
```

### 2.4 打开网页

在浏览器中打开：

```text
http://localhost:3000
```

只要 `node server.js` 的终端窗口保持打开，网页就可以正常读写 `data` 目录里的数据。

### 2.5 在浏览器中安装成应用

#### (a) Microsoft Edge

1. 先运行：

```powershell
node server.js
```

2. 用 Edge 打开：

```text
http://localhost:3000
```

3. 点击右上角 `...` 菜单。
4. 选择 `应用`。
5. 点击 `将此站点作为应用安装`。
6. 应用名称可以填写：

```text
个人工作面板
```

7. 点击 `安装`。

安装后，它会像普通桌面应用一样单独打开。

#### (b) Google Chrome

1. 先运行：

```powershell
node server.js
```

2. 用 Chrome 打开：

```text
http://localhost:3000
```

3. 点击右上角 `...` 菜单。
4. 选择 `保存并分享`。
5. 点击 `创建快捷方式`。
6. 勾选 `在窗口中打开`。
7. 点击 `创建`。

## 3 数据保存位置

使用 `node server.js` 打开时，数据保存在：

```text
D:\WorkSpace\WorkWeb\data
```

主要文件包括：

- `notes.json`：TODO 和便笺数据。
- `projects.json`：项目书架数据。
- `info.json`：常用个人信息数据。

**如果直接双击 `index.html` 打开，浏览器会进入本地缓存模式，数据会保存在浏览器的 `localStorage`，不会自动写入 `data` 目录。**

推荐始终使用：

```text
http://localhost:3000
```

### 
