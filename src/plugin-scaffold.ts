import { existsSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findWorkspaceRoot } from "./paths.js";
import { parsePluginManifest } from "./plugin-manifest.js";

export interface PluginScaffoldResult {
  id: string;
  directory: string;
}

function packageName(id: string): string {
  const safe = id.replace(/[._]+/g, "-").replace(/-+/g, "-");
  return `visual-review-plugin-${safe}`;
}

function writeNew(file: string, contents: string): void {
  writeFileSync(file, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export function createPluginScaffold(id: string, workspace = process.cwd()): PluginScaffoldResult {
  const manifest = parsePluginManifest({
    schema_version: 1,
    id,
    version: "0.1.0",
    commands: [{ name: "hello", module: "./index.js", export: "hello" }],
  });
  const root = findWorkspaceRoot(workspace);
  const pluginsDirectory = path.join(root, "plugins");
  if (existsSync(pluginsDirectory) && (lstatSync(pluginsDirectory).isSymbolicLink() || !lstatSync(pluginsDirectory).isDirectory())) {
    throw new Error("plugins must be a real directory, not a symbolic link");
  }
  const directory = path.join(pluginsDirectory, manifest.id);
  if (existsSync(directory)) throw new Error(`plugin scaffold already exists: ${manifest.id}`);

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeNew(path.join(directory, "visual-review.plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeNew(path.join(directory, "package.json"), `${JSON.stringify({
      name: packageName(manifest.id),
      version: manifest.version,
      private: true,
      description: `Visual Review plugin: ${manifest.id}`,
      type: "module",
      files: ["index.js", "README.md", "visual-review.plugin.json"],
      engines: { node: ">=20" },
      scripts: { test: "node --test test.js" },
    }, null, 2)}\n`);
    writeNew(path.join(directory, "index.js"), `/** @param {{ workspaceRoot: string, pluginDirectory: string, args: readonly string[] }} context */\nexport async function hello(context) {\n  console.log(\`Hello from ${manifest.id}: \${context.args.join(" ")}\`);\n}\n`);
    writeNew(path.join(directory, "test.js"), `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { hello } from "./index.js";\n\ntest("exports the hello command", () => {\n  assert.equal(typeof hello, "function");\n});\n`);
    writeNew(path.join(directory, "README.md"), `# ${manifest.id}\n\nGenerated Visual Review plugin.\n\n## Development\n\n\`\`\`sh\nnpm test\nvisual-review plugin install ./${path.relative(root, directory).split(path.sep).join("/")}\nvisual-review plugin run ${manifest.id} hello world\n\`\`\`\n\nSet \`private\` to \`false\`, choose a publishable package name, add a license, and review the source before publishing.\n`);
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { id: manifest.id, directory };
}
