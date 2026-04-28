# Codex Companion

[English](README.md) | 简体中文

Codex Companion 是一个 Obsidian 桌面插件，它会把本地 Codex CLI 嵌入到保险库内的聊天视图中。

它适合希望直接在 Obsidian 保险库中使用 Codex 进行代码协作和写作协作的用户。Codex Companion 会从当前保险库目录运行 Codex，持续流式显示 Codex 输出，并可以把笔记或选中文本作为上下文发送给 Codex。

## 功能

- 从当前保险库运行 `codex exec --json`。
- 在 Obsidian 聊天视图中流式显示 Codex 回复、推理摘要和工具事件。
- 保留多个对话，并让不同对话对应独立的 Codex 线程。
- 将当前笔记、选中文本和指定的保险库文件附加为上下文。
- 在输入框中使用 `@` 提及建议来附加笔记和文件。
- 在插件工具栏中选择 Codex 模型和推理强度。
- 在普通代理模式和 Plan 模式之间切换。
- 从 Obsidian 命令面板对选中文本执行内联编辑。
- 使用 `/plan`、`/summarize`、`/rewrite`、`/find` 和 `/review` 等斜杠命令。

## 环境要求

- Obsidian 桌面版。
- 已安装并完成认证的 Codex CLI。
- 可以从终端正常运行的 Codex CLI 配置。

Codex Companion 仅支持桌面端，因为它使用本地 Node.js API，并会启动 Codex CLI 进程。

使用插件前，先在终端检查 Codex CLI：

```bash
codex --help
codex exec --json "summarize this folder" --skip-git-repo-check
```

## 使用方法

1. 在 Obsidian 的社区插件设置中启用 Codex Companion。
2. 通过左侧功能区图标或命令面板打开插件。
3. 如果插件无法自动找到 Codex CLI 路径，请在插件设置中配置路径。
4. 在 macOS 上输入提示词后按 Enter，或在其他平台上按 Ctrl/Mod+Enter。
5. 点击回形针按钮，或在输入框中输入 `@`，附加笔记上下文。

## 设置

- **Codex CLI path**：可选的 `codex` 可执行文件路径。
- **Model**：传递给 Codex 的可选模型覆盖值。
- **Reasoning effort**：可选的推理强度覆盖值。
- **Sandbox mode**：Codex 沙箱模式，例如 `read-only` 或 `workspace-write`。
- **Approval policy**：Codex 审批策略。
- **Environment variables**：传递给 Codex 进程的额外环境变量。
- **Context options**：切换当前笔记和选中文本上下文。
- **Conversation limit**：保存的最大对话数量。

## 安全说明

Codex Companion 会从你的保险库目录本地运行 Codex CLI。根据你的 Codex CLI 配置和沙箱模式，提示词、附加笔记、选中文本、文件路径和工具输出可能会发送给 Codex。

默认沙箱模式是 `workspace-write`，这表示 Codex 可以在 Codex 沙箱约束下修改保险库文件。如果只需要分析和回答，请使用 `read-only`。在允许自动编辑重要保险库前，请使用备份或版本控制。

## Windows 兼容性

在 Windows 上，Codex Companion 会把 npm 生成的 `codex.cmd` 和 `codex.bat` shim 解析到底层 Node.js 入口文件后再启动。这样可以避免 Obsidian/Electron 直接启动命令 shim 时出现的 `spawn EINVAL` 错误。

如果你在 Windows 上看到 **Codex CLI not found**，请把 **Codex CLI path** 设置为 `codex.cmd` 的完整路径，或确认包含 `codex.cmd` 和 `node.exe` 的目录已经加入 `PATH`。

## 鸣谢

Windows 兼容性修复由 [Rivflyyy](https://github.com/Rivflyyy/) 贡献。

## 构建

```bash
npm install
npm run build
```

构建会在 `manifest.json` 和 `styles.css` 旁生成 `main.js`。

## 手动安装

在你的保险库中创建以下文件夹：

```text
.obsidian/plugins/codian
```

把以下文件复制进去：

```text
manifest.json
main.js
styles.css
```

然后重启 Obsidian，或重新加载插件，并启用 **Codex Companion**。

## 发布文件

发布 Obsidian 社区插件时，需要把以下文件附加到 GitHub Release：

```text
manifest.json
main.js
styles.css
```

图标会在构建时打包进 `main.js`，所以 `icon.svg` 只作为源文件保留在仓库中，不需要作为发布文件上传。
