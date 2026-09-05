# Quick start

vrev is a local review tool that connects annotations on HTML, images, and web apps to AI-assisted fixes and GitHub Issues.

This guide walks you through reviewing a running local app.

## 1. Check the requirements

| Requirement | Used for |
| --- | --- |
| **Node.js 20+** and npm | Installing and running vrev |
| A supported coding agent CLI | Optional: AI-assisted fixes |
| Authenticated GitHub CLI (`gh`) | Optional: creating GitHub Issues |

::: tip Start with annotations
You can configure AI and GitHub later. First, open a target and leave an annotation.
:::

## 2. Install vrev

In the project you want to review, install Core and the standard feature packages:

```bash
npm install --save-dev \
  @vrev/cli@1.0.0-beta \
  @vrev/ai@1.0.0-beta \
  @vrev/review@1.0.0-beta \
  @vrev/annotation-workflow@1.0.0-beta \
  @vrev/page-map@1.0.0-beta \
  @vrev/github-issue@1.0.0-beta
```

Add `@vrev/storage-firestore@1.0.0-beta` if you need Firestore remote storage. Core discovers plugins from direct dependencies in your project's `package.json`.

## 3. Open a target

Start your app's development server, then pass its URL to vrev:

```bash
npx @vrev/cli serve --target http://127.0.0.1:5173
```

Replace `5173` with your development server's actual port.

vrev uses port `18765` by default and opens your browser automatically. If that port is occupied, it selects the next available port. If the browser does not open, visit the URL printed in your terminal.

### Open HTML or an image

```bash
# Static HTML
npx @vrev/cli serve --target ./index.html

# Image
npx @vrev/cli serve --target ./assets/example.png

# HTTPS staging
npx @vrev/cli serve --target https://staging.example.com/products
```

Replace the paths and URLs with your own review targets.

### Start the development server alongside vrev

```bash
npx @vrev/cli serve \
  --target http://127.0.0.1:5173 \
  --start "npm run dev"
```

Add `--no-open` to disable automatic browser opening.

::: warning JavaScript on public HTTPS sites
Target JavaScript is always disabled for public HTTPS URLs. It is enabled by default for local targets and can be disabled in Settings at the top left.
:::

## 4. Leave your first annotation

1. Press `N` to select a DOM node, or `R` to select a rectangular region. Use regions for images.
2. Select the location and describe what you want to change.
3. Submit with `⌘+Enter` / `Ctrl+Enter`.
4. Press `V` to return to browsing mode.

Next, explore the [review workflow](./workflow) for AI-assisted fixes and Issue creation.
