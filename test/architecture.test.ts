import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

type Module = {
  absolutePath: string;
  relativePath: string;
  source: string;
};

type Dependency = {
  specifier: string;
  typeOnly: boolean;
};

function findRepositoryRoot(): string {
  let candidate = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    // dist/ also contains compiled src/ and plugins/. package.json identifies the
    // checkout root so this test always inspects authored source, not build output.
    if (existsSync(path.join(candidate, "package.json"))
      && existsSync(path.join(candidate, "src"))
      && existsSync(path.join(candidate, "plugins"))) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) throw new Error("could not locate the source repository from the compiled test");
    candidate = parent;
  }
}

const repositoryRoot = findRepositoryRoot();

function sourceModules(directory: string): Module[] {
  const result: Module[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (/\.(?:[cm]?js|tsx?)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
        result.push({
          absolutePath,
          relativePath: path.relative(repositoryRoot, absolutePath).split(path.sep).join("/"),
          source: readFileSync(absolutePath, "utf8"),
        });
      }
    }
  };
  visit(path.join(repositoryRoot, directory));
  return result;
}

const modules = [...sourceModules("src"), ...sourceModules("plugins")];
const modulesByPath = new Map(modules.map((module) => [module.absolutePath, module]));

function dependencies(source: string): Dependency[] {
  const result: Dependency[] = [];
  // Static imports/re-exports are sufficient for architecture ownership. Dynamic
  // imports and CommonJS require calls are included for runtime graph accuracy.
  const staticImport = /\b(?:import|export)\s+(type\s+)?(?:[^"'`;]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(staticImport)) {
    result.push({ specifier: match[2]!, typeOnly: match[1] !== undefined });
  }
  const runtimeImport = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of source.matchAll(runtimeImport)) result.push({ specifier: match[1]!, typeOnly: false });
  return result;
}

function resolveDependency(from: Module, specifier: string): Module | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const requested = path.resolve(path.dirname(from.absolutePath), specifier);
  const extension = path.extname(requested);
  const withoutExtension = extension ? requested.slice(0, -extension.length) : requested;
  const candidates = [
    requested,
    `${withoutExtension}.ts`,
    `${withoutExtension}.tsx`,
    `${withoutExtension}.js`,
    `${withoutExtension}.mjs`,
    path.join(requested, "index.ts"),
    path.join(requested, "index.js"),
  ];
  return candidates.map((candidate) => modulesByPath.get(candidate)).find((candidate) => candidate !== undefined);
}

function pluginName(module: Module): string | undefined {
  const match = /^plugins\/([^/]+)\//.exec(module.relativePath);
  return match?.[1];
}

const compatibilityFacades = new Set([
  "src/adapters.ts",
  "src/job-manager.ts",
  "src/job-store.ts",
  "src/review-store.ts",
  "src/review-capability.ts",
  "src/github-issue.ts",
  "src/types.ts",
]);

// These modules are retained for exactly one beta as rollback/legacy transport
// surfaces. They may name old statuses and provider IDs, but must only delegate;
// the default renderer and generic host runtime remain policy-free.
const legacyCompatibilityModules = new Set([
  "src/cli.ts",
  "src/http-server.ts",
  "src/plugin-runtime.ts",
  "src/plugin-settings-ui/settings.js",
  "src/ui/jobs.ts",
  "src/ui/reviewer.js",
]);

// A catalog is allowed to name/import bundled implementations solely to package
// them. Keep this list explicit so a conveniently named Core module cannot opt out.
const bundledCatalogCandidates = [
  "src/bundled-plugin-catalog.ts",
  "src/bundled-plugins.ts",
  "src/bundled-plugins/catalog.ts",
];
const bundledCatalogs = new Set(bundledCatalogCandidates.filter((candidate) => existsSync(path.join(repositoryRoot, candidate))));

function formatViolations(violations: string[]): string {
  return violations.length ? `\n${violations.sort().map((item) => `  - ${item}`).join("\n")}` : "";
}

test("Core and plugins respect implementation ownership boundaries", () => {
  const violations: string[] = [];
  for (const module of modules) {
    for (const dependency of dependencies(module.source)) {
      const target = resolveDependency(module, dependency.specifier);
      if (!target) continue;
      const sourcePlugin = pluginName(module);
      const targetPlugin = pluginName(target);
      if (module.relativePath.startsWith("src/") && targetPlugin
        && !compatibilityFacades.has(module.relativePath) && !bundledCatalogs.has(module.relativePath)) {
        violations.push(`${module.relativePath} imports plugin implementation ${target.relativePath}`);
      }
      if (sourcePlugin && targetPlugin && sourcePlugin !== targetPlugin) {
        violations.push(`${module.relativePath} imports another plugin's implementation ${target.relativePath}`);
      }
    }
  }
  assert.deepEqual(violations, [], `implementation boundary violations:${formatViolations(violations)}`);
});

test("the source module dependency graph is acyclic", () => {
  const graph = new Map<string, string[]>();
  for (const module of modules) {
    const edges = dependencies(module.source)
      .map(({ specifier }) => resolveDependency(module, specifier)?.relativePath)
      .filter((dependency): dependency is string => dependency !== undefined);
    graph.set(module.relativePath, [...new Set(edges)]);
  }

  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles = new Set<string>();
  const visit = (name: string): void => {
    if (active.has(name)) {
      const start = stack.indexOf(name);
      cycles.add([...stack.slice(start), name].join(" -> "));
      return;
    }
    if (visited.has(name)) return;
    active.add(name);
    stack.push(name);
    for (const dependency of graph.get(name) ?? []) visit(dependency);
    stack.pop();
    active.delete(name);
    visited.add(name);
  };
  for (const name of graph.keys()) visit(name);
  assert.deepEqual([...cycles], [], `module dependency cycles:${formatViolations([...cycles])}`);
});

test("host modules do not own annotation status or workflow/issue business policy", () => {
  const statusLiteral = /["'](open|in_progress|failed|addressed|resolved)["']/g;
  const policyMarker = /["'](?:annotation-workflow|github-issue|annotation-(?:created|reopened)|(?:annotations|history|jobs)\.(?:list|enqueue)|issue\.(?:draft|create))["']/g;
  const violations: string[] = [];

  for (const module of modules.filter(({ relativePath }) => relativePath.startsWith("src/")
    && !compatibilityFacades.has(relativePath) && !legacyCompatibilityModules.has(relativePath)
    && !bundledCatalogs.has(relativePath))) {
    const lines = module.source.split("\n");
    lines.forEach((line, index) => {
      const lineStatuses = new Set([...line.matchAll(statusLiteral)].map((match) => match[1]));
      // `open` and `failed` are also generic DOM/runtime words. They are domain
      // policy only when status/review context is present, or when several
      // annotation states are declared together as a policy collection.
      const hasStatusPolicy = lineStatuses.size > 0
        && (lineStatuses.size >= 2 || /\b(?:annotation|review|status|statuses)\b/i.test(line));
      const hasNamedPolicy = policyMarker.test(line);
      policyMarker.lastIndex = 0;
      if (hasStatusPolicy || hasNamedPolicy) violations.push(`${module.relativePath}:${index + 1}: ${line.trim()}`);
    });
  }

  assert.deepEqual(violations, [], `host-owned annotation/workflow/issue policy:${formatViolations(violations)}`);
});

test("Core bridge transport delegates without plugin operation branches", () => {
  const server = modulesByPath.get(path.join(repositoryRoot, "src/http-server.ts"));
  assert.ok(server, "src/http-server.ts must exist");
  assert.doesNotMatch(server.source, /\bpluginId\s*={2,3}|\bname\s*={2,3}\s*["'](?:annotations\.|history\.|jobs\.|issue\.|runner\.|session\.|annotation\.)/);
  assert.match(server.source, /delegateBridge\(bridgeAdapter\(/);
});

test("plugin settings UI has no branches for built-in plugin IDs", () => {
  const settings = modulesByPath.get(path.join(repositoryRoot, "src/plugin-settings-ui/settings.js"));
  assert.ok(settings, "src/plugin-settings-ui/settings.js must exist");
  const pluginIds = readdirSync(path.join(repositoryRoot, "plugins"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(repositoryRoot, "plugins", entry.name, "visual-review.plugin.json")))
    .map((entry) => entry.name);
  const violations = settings.source.split("\n").flatMap((line, index) => {
    const branchesOnId = /\b(?:if|else\s+if|case)\b|={2,3}|!={1,2}|pluginsById\.get\s*\(/.test(line);
    if (!branchesOnId) return [];
    return pluginIds.some((id) => line.includes(`"${id}"`) || line.includes(`'${id}'`))
      ? [`src/plugin-settings-ui/settings.js:${index + 1}: ${line.trim()}`]
      : [];
  });
  assert.deepEqual(violations, [], `built-in plugin-specific UI branches:${formatViolations(violations)}`);
});
