import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_METHOD_ID = "claude";
const METHOD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SETTINGS_VERSION = 1;

function settingsPath(workspaceRoot) {
  return path.join(workspaceRoot, ".vrev", "ai-settings.json");
}

export function readAiSettings(workspaceRoot) {
  const filePath = settingsPath(workspaceRoot);
  if (!existsSync(filePath)) {
    const legacyPath = path.join(workspaceRoot, ".vrev", "workflow-settings.json");
    if (existsSync(legacyPath) && !lstatSync(legacyPath).isSymbolicLink()) {
      try {
        const legacy = JSON.parse(readFileSync(legacyPath, "utf8"));
        const migrated = typeof legacy?.runner === "string" && legacy.runner.startsWith("custom:") ? legacy.runner.slice(7) : legacy?.runner;
        if (typeof migrated === "string" && METHOD_ID.test(migrated)) return { schema_version: SETTINGS_VERSION, method_id: migrated };
      } catch { /* malformed legacy settings use the safe default */ }
    }
    return { schema_version: SETTINGS_VERSION, method_id: DEFAULT_METHOD_ID };
  }
  if (lstatSync(filePath).isSymbolicLink()) throw new Error("AI settings must not be a symbolic link");
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8"));
    if (value?.schema_version === SETTINGS_VERSION && typeof value.method_id === "string" && METHOD_ID.test(value.method_id)) return value;
  } catch { /* invalid settings use the safe default */ }
  return { schema_version: SETTINGS_VERSION, method_id: DEFAULT_METHOD_ID };
}

export function writeAiSettings(workspaceRoot, methodId, availableMethods) {
  if (typeof methodId !== "string" || !METHOD_ID.test(methodId) || !availableMethods.some(({ method_id }) => method_id === methodId)) {
    throw new Error("選択したAIは利用できません");
  }
  const filePath = settingsPath(workspaceRoot);
  const next = { schema_version: SETTINGS_VERSION, method_id: methodId };
  mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, filePath);
  return next;
}

export function selectAiMethod(workspaceRoot, methods) {
  const selected = readAiSettings(workspaceRoot).method_id;
  return methods.find(({ method_id }) => method_id === selected) ?? null;
}
