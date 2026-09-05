# Developer guide

vrev combines a small Core with feature plugins. Choose the resource that matches your task.

::: info Technical reference language
The home page, quick start, review workflow, and this guide are available in English. The detailed technical references linked below are currently in Japanese.
:::

## Find a reference

| Goal | Documentation (Japanese) |
| --- | --- |
| Build your first plugin | [Plugin development guide](../plugin-guide) |
| Understand manifests and capabilities | [Plugin platform](../plugins) |
| Implement declarative UI | [UI bridge](../plugin-ui-bridge) |
| Understand Core and Host boundaries | [Plugin Host architecture](../plugin-host-architecture) |
| Add a storage backend | [Storage providers](../storage-providers) |
| Publish a release | [Release process](../releasing) |
| Check known limitations | [Troubleshooting](../gotchas) |

## Plugin architecture

The current standard is **schema v4 Plugin Host**. Core's declarative renderer displays validated JSON UI documents. Feature packages communicate through versioned Host capabilities rather than depending on each other's implementations.

| Package | Responsibility |
| --- | --- |
| `@vrev/review` | Annotations, history, and persistence |
| `@vrev/ai` | CLI selection and shared AI execution |
| `@vrev/annotation-workflow` | AI jobs and automatic execution policies |
| `@vrev/page-map` | Static HTML page transition analysis |
| `@vrev/github-issue` | Issue drafts, selection, and GitHub operations |
| `@vrev/storage-firestore` | Firestore remote storage |

## Scaffold your first plugin

```bash
npx @vrev/cli plugin create my-plugin \
  --title "My Plugin" \
  --summary "Extend the review workflow" \
  --install

npx @vrev/cli plugin run my-plugin hello world
```

::: warning Generated schema version
`plugin create` generates a provider/command-compatible **schema v3** manifest. Update to the [schema v4 contract (Japanese)](../plugins) to provide server capabilities or declarative UI.
:::

Development types and contracts are provided by `@vrev/plugin-sdk@1.0.0-beta.2`.

## Install and configure safely

- Core discovers only direct dependencies in `package.json`, without evaluating code during discovery.
- For installation through Settings, pin npm packages to an exact version and GitHub specs to a tag or commit SHA.
- Newly added plugins start disabled. Review their contents before enabling them.
- Keep API keys and tokens in environment variables or dedicated authentication settings.

## Design and future plans

The following documents are in Japanese: [Roadmap](../roadmap) · [Design decisions](../decisions) · [Migration plan](../plugin-migration-plan) · [Publication audit](../publication-audit).
