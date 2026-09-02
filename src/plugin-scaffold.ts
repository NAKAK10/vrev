import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findWorkspaceRoot } from "./paths.js";
import { parsePluginBridgeContract } from "./plugin-bridge-contract.js";
import { parsePluginManifest } from "./plugin-manifest.js";
import { parsePluginUiDocument } from "./plugin-ui-document.js";

export interface PluginScaffoldResult {
  id: string;
  directory: string;
}

export interface PluginScaffoldOptions {
  title?: string;
  summary?: string;
}

function packageName(id: string): string {
  const safe = id.replace(/[._]+/g, "-").replace(/-+/g, "-");
  return `visual-review-plugin-${safe}`;
}

function writeNew(file: string, contents: string): void {
  writeFileSync(file, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function writeNewJson(file: string, value: unknown): void {
  writeNew(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function createPluginScaffold(id: string, workspace = process.cwd(), options: PluginScaffoldOptions = {}): PluginScaffoldResult {
  const title = options.title?.trim() || id;
  const summary = options.summary?.trim() || `Visual Review plugin: ${id}`;
  const serverContract = { schema_version: 1, queries: [], commands: [] };
  const annotationActionDocument = {
    schema_version: 1,
    root: {
      type: "stack",
      children: [
        {
          id: "annotation-action",
          type: "button",
          props: { label: { literal: "注釈アクション" }, variant: { literal: "secondary" } },
          on: { click: [{ type: "toast.show", variant: "success", message: { literal: "注釈アクションを実行しました。ui/annotation-action.ui.json を編集して実際の操作に置き換えられます。" } }] },
        },
      ],
    },
  };
  const manifest = parsePluginManifest({
    schema_version: 4,
    id,
    version: "0.1.0",
    display: { title, summary, readme: "./README.md" },
    configuration: [],
    server: { api_version: 1, bridge_api_version: 1, module: "./server/index.js", contract: "./server.contract.json" },
    ui: {
      renderer_api_version: 1,
      bridge_api_version: 1,
      contributions: [{ id: "annotation-action", slot: "annotation-workflow.annotation.actions", document: "./ui/annotation-action.ui.json", order: 100 }],
    },
    requires: [{ capability: "review", api_version: 1, optional: false }],
    provides: [],
    commands: [{ name: "hello", module: "./index.js", export: "hello" }],
  });
  // The templates are fixed, so validate them here to guarantee the scaffold never emits an unparseable file.
  parsePluginBridgeContract(serverContract);
  parsePluginUiDocument(annotationActionDocument);
  const root = findWorkspaceRoot(workspace);
  const pluginsDirectory = path.join(root, "plugins");
  if (existsSync(pluginsDirectory) && (lstatSync(pluginsDirectory).isSymbolicLink() || !lstatSync(pluginsDirectory).isDirectory())) {
    throw new Error("plugins must be a real directory, not a symbolic link");
  }
  const directory = path.join(pluginsDirectory, manifest.id);
  if (existsSync(directory)) throw new Error(`plugin scaffold already exists: ${manifest.id}`);

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeNewJson(path.join(directory, "visual-review.plugin.json"), manifest);
    writeNewJson(path.join(directory, "package.json"), {
      name: packageName(manifest.id),
      version: manifest.version,
      private: true,
      description: `Visual Review plugin: ${manifest.id}`,
      type: "module",
      files: ["index.js", "README.md", "visual-review.plugin.json", "server/index.js", "server.contract.json", "ui/annotation-action.ui.json", "types.d.ts"],
      engines: { node: ">=20" },
      scripts: { test: "node --test test.js" },
    });
    writeNew(path.join(directory, "index.js"), `/** @param {{ workspaceRoot: string, pluginDirectory: string, args: readonly string[] }} context */\nexport async function hello(context) {\n  console.log(\`Hello from ${manifest.id}: \${context.args.join(" ")}\`);\n}\n`);
    writeNew(path.join(directory, "test.js"), `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { hello } from "./index.js";\n\ntest("exports the hello command", () => {\n  assert.equal(typeof hello, "function");\n});\n`);
    mkdirSync(path.join(directory, "server"), { mode: 0o700 });
    writeNew(path.join(directory, "server/index.js"), `function unsupported(request) {
  return {
    ok: false,
    error: {
      code: "NOT_FOUND",
      message: "operation is not declared by this plugin",
      retryable: false,
      request_id: typeof request?.request_id === "string" ? request.request_id : "unknown",
    },
  };
}

const provider = Object.freeze({
  apiVersion: 1,
  create(_context) {
    return {
      start() {},
      async query(_name, request) {
        return unsupported(request);
      },
      async command(_name, request) {
        return unsupported(request);
      },
      capabilities() {
        return [];
      },
      stop() {},
    };
  },
});

export default provider;
`);
    writeNewJson(path.join(directory, "server.contract.json"), serverContract);
    mkdirSync(path.join(directory, "ui"), { mode: 0o700 });
    writeNewJson(path.join(directory, "ui/annotation-action.ui.json"), annotationActionDocument);
    writeNew(path.join(directory, "types.d.ts"), `export type {
  VisualReviewPluginManifest,
  PluginUiExtensionPointV1,
  PluginUiExtensionEventSchemaV1,
  PluginUiContributionV1,
  PluginUiDocumentV1,
  PluginUiSurfaceExtensionPointV1,
  PluginServerProviderV1,
  PluginBridgeContractV1,
} from "@nakak10/visual-review";
`);
    writeNew(path.join(directory, "README.md"), `# ${title}

${summary}

## Configuration template

Add declarative fields to the manifest's \`configuration\` array. Supported field types are \`string\`, \`integer\`, \`boolean\`, and \`select\`; sources are \`workspace\` and \`environment\`. Secret values must use environment fields and are never persisted.

## UI extension points

JSON manifest fields cannot carry comments, so this section keeps a \`ui.extension_points\` example. Declared extension points let other plugins contribute through \`ui.contributions[].slot\` and are hosted by a \`slot\` node in one of your own UI documents.

\`\`\`json
{
  "ui": {
    "renderer_api_version": 1,
    "bridge_api_version": 1,
    "extension_points": [
      {
        "id": "${manifest.id}.card.actions",
        "title": "カードの操作",
        "description": "このpluginの部品に他pluginが追加できる操作",
        "context_schema": {
          "type": "object",
          "properties": { "id": { "type": "string", "maxLength": 128 } },
          "required": ["id"],
          "additionalProperties": false
        },
        "form_fields": [],
        "events": {
          "completed": { "type": "object", "properties": {}, "additionalProperties": false }
        },
        "max_contributions": 4
      }
    ],
    "contributions": [
      { "id": "annotation-action", "slot": "annotation-workflow.annotation.actions", "document": "./ui/annotation-action.ui.json", "order": 100 }
    ]
  }
}
\`\`\`

## Development

\`\`\`sh
npm test
visual-review plugin install ./${path.relative(root, directory).split(path.sep).join("/")}
visual-review plugin run ${manifest.id} hello world
\`\`\`

Set \`private\` to \`false\`, choose a publishable package name, add a license, and review the source before publishing.
`);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { id: manifest.id, directory };
}