import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const ignoredDirectories = new Set([".git", "dist", "node_modules"]);
const ignoredFiles = new Set([".git", "package-lock.json"]);
const checks = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ["credential in URL", /https?:\/\/[^\s/:]+:[^\s/@]+@/],
  ["machine-specific home path", /\/Users\/[^/\s]+\//],
];

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".env") || entry.name.endsWith(".pem") || entry.name.endsWith(".key")) {
      return [path.join(directory, entry.name)];
    }
    if (entry.isDirectory()) return ignoredDirectories.has(entry.name) ? [] : files(path.join(directory, entry.name));
    return ignoredFiles.has(entry.name) || !entry.isFile() ? [] : [path.join(directory, entry.name)];
  });
}

const findings = [];
for (const file of files(root)) {
  if (statSync(file).size > 2_000_000) continue;
  const relative = path.relative(root, file);
  const content = readFileSync(file, "utf8");
  if (path.basename(file).startsWith(".env") && path.basename(file) !== ".env.example") {
    findings.push(`${relative}: environment file must not be committed`);
    continue;
  }
  for (const [label, pattern] of checks) {
    if (pattern.test(content)) findings.push(`${relative}: possible ${label}`);
  }
}

if (findings.length) {
  console.error(`Secret-safety check failed:\n${findings.map((item) => `- ${item}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Secret-safety check passed.");
}
