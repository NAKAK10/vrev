import { cpSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/ui", import.meta.url));
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const destination = fileURLToPath(new URL("../dist/src/ui", import.meta.url));
const bundledPluginsDestination = fileURLToPath(new URL("../dist/src/bundled-plugins", import.meta.url));
const pluginSettingsSource = fileURLToPath(new URL("../src/plugin-settings-ui", import.meta.url));
const pluginSettingsDestination = fileURLToPath(new URL("../dist/src/plugin-settings-ui", import.meta.url));

if (process.argv.includes("--clean")) {
  rmSync(dist, { recursive: true, force: true });
  process.exit(0);
}

mkdirSync(destination, { recursive: true });
for (const name of ["index.html", "renderer.html", "renderer.css", "renderer.js", "reviewer.css", "reviewer.js"]) {
  copyFileSync(path.join(source, name), path.join(destination, name));
}
mkdirSync(pluginSettingsDestination, { recursive: true });
for (const name of ["index.html", "settings.css", "settings.js"]) {
  copyFileSync(path.join(pluginSettingsSource, name), path.join(pluginSettingsDestination, name));
}

mkdirSync(bundledPluginsDestination, { recursive: true });
for (const id of ["review", "github-issue", "custom-command", "annotation-workflow"]) {
  const pluginSource = fileURLToPath(new URL(`../plugins/${id}`, import.meta.url));
  const pluginDestination = path.join(bundledPluginsDestination, id);
  cpSync(pluginSource, pluginDestination, {
    recursive: true,
    filter: (entry) => path.basename(entry) !== "test" && (!entry.endsWith(".ts") || entry.endsWith(".d.ts")),
  });
  cpSync(pluginSource, path.join(dist, `plugins/${id}`), {
    recursive: true,
    force: true,
    filter: (entry) => path.basename(entry) !== "test" && (!entry.endsWith(".ts") || entry.endsWith(".d.ts")),
  });
  if (id === "review" || id === "annotation-workflow") {
    cpSync(path.join(dist, `plugins/${id}/server`), path.join(pluginDestination, "server"), {
      recursive: true,
      force: true,
    });
  }
}
