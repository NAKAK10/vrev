# 开发者指南

vrev 由精简的 Core 与功能插件组成。请根据目标选择对应的文档。

::: info 技术参考文档的语言
首页、快速入门、审阅工作流和本指南提供简体中文版本。下方链接的详细技术参考目前为日语文档。
:::

## 按目标查找

| 目标 | 文档（日语） |
| --- | --- |
| 创建第一个插件 | [插件开发指南](../plugin-guide) |
| 了解 manifest 和 capability | [插件平台](../plugins) |
| 实现声明式 UI | [UI 桥接](../plugin-ui-bridge) |
| 了解 Core 与 Host 的边界 | [Plugin Host 架构](../plugin-host-architecture) |
| 扩展存储后端 | [存储提供者](../storage-providers) |
| 发布新版本 | [发布流程](../releasing) |
| 查看已知限制 | [故障排查](../gotchas) |

## 插件架构

当前标准是 **schema v4 Plugin Host**。Core 的声明式渲染器负责显示经过验证的 JSON UI document。功能包通过带版本的 Host capability 通信，不依赖彼此的内部实现。

| 包 | 职责 |
| --- | --- |
| `@vrev/review` | 批注、历史和持久化 |
| `@vrev/ai` | CLI 选择和共用 AI 执行 |
| `@vrev/annotation-workflow` | AI 任务和自动执行策略 |
| `@vrev/page-map` | 静态 HTML 页面跳转分析 |
| `@vrev/github-issue` | Issue 草稿、选择和 GitHub 操作 |
| `@vrev/storage-firestore` | Firestore 远程存储 |

## 生成第一个插件

```bash
npx @vrev/cli plugin create my-plugin \
  --title "My Plugin" \
  --summary "Extend the review workflow" \
  --install

npx @vrev/cli plugin run my-plugin hello world
```

::: warning 生成的 schema 版本
`plugin create` 生成兼容 provider/command 的 **schema v3** manifest。如需提供 server capability 或声明式 UI，请更新为 [schema v4 contract（日语）](../plugins)。
:::

开发所需的类型和 contract 由 `@vrev/plugin-sdk@1.0.0-beta` 提供。

## 安全安装与配置

- Core 仅发现 `package.json` 中的直接依赖，发现阶段不会执行代码。
- 通过设置页面安装时，npm 包必须固定到精确版本，GitHub spec 必须固定到 tag 或 commit SHA。
- 新添加的插件默认禁用。请先检查内容，再启用。
- API 密钥和令牌应使用环境变量或专用认证设置。

## 设计与未来计划

以下文档为日语：[路线图](../roadmap) · [设计决策](../decisions) · [迁移计划](../plugin-migration-plan) · [发布审计](../publication-audit)。
