# my-tools

Windows 桌面速开工具：全局快捷键唤起搜索条，一键直达收藏网址与本机应用。基于 Tauri 2 + React 19 + TypeScript，免安装、零残留。

## 功能

**速开搜索条**

- 全局快捷键（默认 `Alt+Space`，可在管理窗口自定义）唤起，置顶悬浮、自动聚焦，失焦即关
- `Esc` 清空输入；再按关闭窗口；`↑↓` 选择、`↵` 打开，鼠标点击同样生效

**三类候选结果**（按优先级排列）

| 类型 | 匹配方式 | 回车行为 |
| --- | --- | --- |
| 收藏 | 标题 / URL 包含关键字 | 系统默认浏览器打开 |
| 本机应用 | 应用名前缀或包含命中 | 直接启动（展示真实程序图标） |
| 网址 / 搜索 | 输入内容形如 URL 时直达，否则提交必应搜索 | 浏览器打开 |

本机应用来自「开始菜单」快捷方式扫描，自动过滤卸载器与指向网址、文档的无效条目，仅覆盖 Win32 桌面应用。

**管理窗口**：速开条输入 `admin` 回车打开。支持收藏的新增、编辑、删除、搜索，JSON 导入导出（导入前校验格式），以及修改全局快捷键、开关机自启动。

**系统托盘**：打开速开条、管理窗口、开机启动开关、重启、关于、退出。

**便携化**：`favorites.json`（收藏）与 `app.json`（配置）保存在 exe 同级目录，整个文件夹拷贝到 U 盘或其它电脑即可直接使用。

## 快速开始

环境要求：Node.js ≥ 20.19（或 ≥ 22.12）、Rust（MSVC 工具链）、WebView2 Runtime、Windows 10/11。

```bash
npm install

# 桌面应用开发（Tauri dev）
npm run start

# 纯浏览器预览界面（无需 Tauri，使用示例数据）
npm run dev
```

## 构建发布

```bash
# 构建并复制 my-tools.exe 到仓库根目录
npm run build

# 生成免安装压缩包
npm run zip:win
```

### 自动发布（GitHub Actions）

推送 `v` 开头的 tag（如 `v0.1.0`）即自动在 GitHub Actions 上打包便携版并发布到 [Releases](https://github.com/hnxycxd/my-tools/releases)，产物为 `my-tools-v{版本号}-win-portable.zip`：

```bash
git tag v0.1.0
git push origin v0.1.0
```

tag 版本号会自动同步进 exe 与压缩包内说明（无需手动改 `package.json` / `tauri.conf.json`）。也可在 Actions 页面手动触发一次构建试跑（不发布）。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面壳 | Tauri 2（托盘、全局快捷键、多窗口） |
| 前端 | React 19 + TypeScript + Vite 7 |
| 样式 | Tailwind CSS 4；管理窗口使用 antd 5 |
| 后端 | Rust：开始菜单扫描、快捷方式目标解析、图标提取（Windows Shell API） |

## 目录结构

```
├── src/                  # 前端源码
│   ├── palette/          # 速开搜索条
│   ├── admin/            # 管理窗口
│   ├── components/       # 通用组件（印章图标等）
│   ├── types/            # 与 Rust 结构体对应的类型
│   └── utils/            # 工具函数、浏览器预览数据
├── src-tauri/            # Rust 后端
│   └── src/
│       ├── lib.rs        # 窗口/托盘/快捷键/命令注册
│       ├── apps.rs       # 本机应用扫描与图标提取
│       └── storage.rs    # 便携化数据读写
└── scripts/              # 免安装打包脚本
```
