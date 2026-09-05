# 快速入门

vrev 是本地运行的审阅工具，可在 HTML、图片和 Web 应用上添加批注，并将反馈转化为 AI 辅助修改或 GitHub Issue。

本指南将带你完成对运行中的本地应用的首次审阅。

## 1. 准备环境

| 环境要求 | 用途 |
| --- | --- |
| **Node.js 20 及以上**和 npm | 安装和运行 vrev |
| 支持的 coding agent CLI | 可选：使用 AI 辅助修改 |
| 已完成认证的 GitHub CLI (`gh`) | 可选：创建 GitHub Issue |

::: tip 先从批注开始
AI 和 GitHub 可以稍后配置。先打开一个审阅对象，添加第一条批注。
:::

## 2. 安装 vrev

在需要审阅的项目中安装 Core 和标准功能包：

```bash
npm install --save-dev \
  @vrev/cli@1.0.0-beta \
  @vrev/ai@1.0.0-beta \
  @vrev/review@1.0.0-beta \
  @vrev/annotation-workflow@1.0.0-beta \
  @vrev/page-map@1.0.0-beta \
  @vrev/github-issue@1.0.0-beta
```

如需使用 Firestore 远程存储，请额外安装 `@vrev/storage-firestore@1.0.0-beta`。Core 从项目 `package.json` 的直接依赖中发现插件。

## 3. 打开审阅对象

启动应用的开发服务器，然后将其 URL 传给 vrev：

```bash
npx @vrev/cli serve --target http://127.0.0.1:5173
```

请将 `5173` 替换为开发服务器实际使用的端口。

vrev 默认使用端口 `18765`，并自动打开浏览器。如果该端口被占用，将使用下一个可用端口。如果浏览器未自动打开，请访问终端中显示的 URL。

### 打开 HTML 或图片

```bash
# 静态 HTML
npx @vrev/cli serve --target ./index.html

# 图片
npx @vrev/cli serve --target ./assets/example.png

# HTTPS 预发布网站
npx @vrev/cli serve --target https://staging.example.com/products
```

请将路径和 URL 替换为实际的审阅对象。

### 同时启动开发服务器

```bash
npx @vrev/cli serve \
  --target http://127.0.0.1:5173 \
  --start "npm run dev"
```

如需禁用浏览器自动打开功能，请添加 `--no-open`。

::: warning 公开 HTTPS 网站的 JavaScript
对于公开 HTTPS URL，目标页面的 JavaScript 始终被禁用。本地目标默认启用 JavaScript，可在左上角的设置中关闭。
:::

## 4. 添加第一条批注

1. 按 `N` 选择 DOM 节点，或按 `R` 选择矩形区域。图片请使用矩形区域。
2. 选择位置，输入需要修改的内容。
3. 按 `⌘+Enter` / `Ctrl+Enter` 提交。
4. 按 `V` 返回浏览模式。

接下来，请阅读[审阅工作流](./workflow)，了解如何使用 AI 辅助修改和创建 Issue。
