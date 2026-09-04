import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatFindings, listSourceFiles, scanRepository } from "../scripts/check-secrets.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scannerPath = path.join(projectRoot, "scripts", "check-secrets.mjs");

function fakeValues() {
  return {
    aws: "AK" + "IA" + "A".repeat(16),
    github: "gh" + "p_" + "b".repeat(24),
    npm: "np" + "m_" + "c".repeat(36),
    privateKey: "-----BEGIN " + "PRIVATE KEY-----",
  };
}

function makeRepository() {
  const root = mkdtempSync(path.join(tmpdir(), "vrev-secret-check-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(path.join(root, ".vrev", "credentials"), { recursive: true });
  mkdirSync(path.join(root, "runtime"));
  mkdirSync(path.join(root, "scripts"));

  const values = fakeValues();
  writeFileSync(path.join(root, ".gitignore"), "runtime/\n.env*\n*.key\n");
  writeFileSync(path.join(root, "package-lock.json"), `{\n  "token": "${values.npm}"\n}\n`);
  writeFileSync(path.join(root, ".vrev", "credentials", "provider.json"), `${values.github}\n`);
  writeFileSync(path.join(root, ".env.production"), `${values.privateKey}\n`);
  writeFileSync(path.join(root, "large.key"), `${"x".repeat(2_100_000)}\n${values.aws}\n`);
  writeFileSync(
    path.join(root, "scripts", "new.mjs"),
    `${["C:", "Users", "build-agent", "project"].join("\\")}\\file.js\n${["C:", "Users", "release-bot", "project"].join("\\\\")}\\\\file.js\n${["", "home", "ci-runner", "project"].join("/")}\n`,
  );
  writeFileSync(
    path.join(root, "placeholders.txt"),
    `${["", "home", "user", "project"].join("/")}\n${["C:", "Users", "username", "project"].join("\\")}\\file.js\n`,
  );
  writeFileSync(path.join(root, "runtime", "session.json"), `${values.npm}\n`);

  execFileSync("git", ["add", ".gitignore", "package-lock.json", ".vrev/credentials/provider.json"], { cwd: root });
  execFileSync("git", ["add", "-f", ".env.production", "large.key"], { cwd: root });
  return { root, values };
}

test("scans Git source scope without skipping sensitive names or large files", () => {
  const { root, values } = makeRepository();
  try {
    const files = listSourceFiles(root);
    assert.ok(files.includes("package-lock.json"));
    assert.ok(files.includes(".vrev/credentials/provider.json"));
    assert.ok(files.includes(".env.production"));
    assert.ok(files.includes("large.key"));
    assert.ok(files.includes("scripts/new.mjs"));
    assert.ok(!files.includes("runtime/session.json"));

    const findings = scanRepository(root);
    assert.ok(findings.some(({ file, line, category }) => file === "package-lock.json" && line === 2 && category === "npm token"));
    assert.ok(findings.some(({ file, category }) => file === ".vrev/credentials/provider.json" && category === "GitHub token"));
    assert.ok(findings.some(({ file, category }) => file === ".vrev/credentials/provider.json" && category === "sensitive credential file"));
    writeFileSync(path.join(root, ".vrev", "credentials", "provider.json"), "unrecognized credential format\n");
    assert.ok(scanRepository(root).some(({ file, category }) => file === ".vrev/credentials/provider.json" && category === "sensitive credential file"));
    assert.ok(findings.some(({ file, category }) => file === ".env.production" && category === "environment file"));
    assert.ok(findings.some(({ file, category }) => file === ".env.production" && category === "private key"));
    assert.ok(findings.some(({ file, line, category }) => file === "large.key" && line === 2 && category === "AWS access key"));
    assert.equal(findings.filter(({ file, category }) => file === "scripts/new.mjs" && category === "machine-specific home path").length, 3);
    assert.equal(findings.some(({ file }) => file === "placeholders.txt"), false);
    assert.equal(findings.some(({ file }) => file === "runtime/session.json"), false);

    const output = formatFindings(findings);
    for (const value of Object.values(values)) assert.equal(output.includes(value), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLI reports only filename, line, and category for a selected repository", () => {
  const { root, values } = makeRepository();
  try {
    const result = spawnSync(process.execPath, [scannerPath, root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /package-lock\.json:2: possible npm token/);
    for (const value of Object.values(values)) assert.equal(result.stderr.includes(value), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
