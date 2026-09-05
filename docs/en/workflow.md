# Review workflow

Capture feedback on screen, then turn it into fixes or shared tasks. For installation, see the [quick start](./getting-started).

## Annotate the screen

- **DOM node selection (`N`)**: point to a specific element, such as a button or heading.
- **Rectangular region (`R`)**: highlight an area, such as layout spacing or part of an image.
- **Browse (`V`)**: return to browsing the target page.

Switch between desktop, tablet, and mobile viewports to check different screen widths. Manage annotations with threads, statuses, history, and filters.

::: tip Make feedback specific
Instead of “hard to read,” try “increase the contrast between this button's text and background.” Include both the location and the expected change.
:::

## Ask AI for a fix

Install and authenticate a supported coding agent CLI, then configure AI in Settings at the top left.

**Supported CLIs:** OpenCode / Claude / Codex / GitHub Copilot / Pi / custom CLI.

- **AI plugin**: owns CLI selection and external AI command registration and validation.
- **annotation-workflow plugin**: configures concurrency and automatic execution policies.

Request a fix based on an annotation, then review the resulting screen and code diff.

### Custom CLI

Include `{prompt}` **exactly once** in the command to pass the request:

```text
agent-command --prompt {prompt}
```

Commands run without a shell. Tool-use capabilities are validated before registration.

::: warning Credentials and generated changes
Do not put API keys or tokens in commands. Use each CLI's authentication settings or environment variables. Always review AI-generated changes and run the relevant tests.
:::

## Share a GitHub Issue

1. Authenticate `gh` with an account that can access the target repository.
2. Select the action to create a GitHub Issue.
3. Review the editable AI-generated draft and make any necessary changes.
4. Confirm the content before adding it to GitHub.

The official `github-issue` plugin is installed automatically on first launch. GitHub authentication is not automated.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `V` | Browse mode |
| `N` | Select a DOM node |
| `R` | Select a rectangular region |
| `⌘+Enter` / `Ctrl+Enter` | Submit an annotation, reply, or Issue |

## Extend your workflow

Plugins can add storage, AI, page transition analysis, and more. Find the relevant technical resources in the [developer guide](./developers).
