import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");

const checks = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ["credential in URL", /https?:\/\/[^\s/:]+:[^\s/@]+@/],
];

const placeholderHomeNames = new Set([
  "example",
  "me",
  "name",
  "someone",
  "user",
  "username",
  "your-name",
  "your_name",
  "yourname",
  "xxx",
]);

function isPlaceholderHomeName(value) {
  const normalized = value.toLowerCase().replace(/^[<{$%]+|[>}%]+$/g, "");
  return placeholderHomeNames.has(normalized);
}

function hasMachineSpecificHomePath(line) {
  const patterns = [
    /\/Users\/([^/\s]+)\//g,
    /\/home\/([^/\s]+)\//g,
    /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s]+)[\\/]+/gi,
  ];

  return patterns.some((pattern) => {
    for (const match of line.matchAll(pattern)) {
      if (!isPlaceholderHomeName(match[1])) return true;
    }
    return false;
  });
}

/** Return tracked and untracked, non-ignored paths from Git's view of the repository. */
export function listSourceFiles(root) {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return output.split("\0").filter(Boolean);
}

function fileContent(root, relative) {
  const absolute = path.join(root, relative);
  if (!existsSync(absolute)) return null; // A deletion may still be present in the index.
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) return readlinkSync(absolute, "utf8");
  if (!stat.isFile()) return null; // For example, a submodule gitlink.
  return readFileSync(absolute, "utf8");
}

export function scanRepository(root = defaultRoot) {
  const findings = [];

  for (const relative of listSourceFiles(root)) {
    const content = fileContent(root, relative);
    if (content === null) continue;
    const basename = path.basename(relative);

    if (basename.startsWith(".env") && basename !== ".env.example") {
      findings.push({ file: relative, line: 1, category: "environment file" });
    }
    const segments = relative.split(/[\\/]/);
    if (segments.some((segment, index) => segment === ".vrev" && segments[index + 1] === "credentials")
      || [".npmrc", "id_rsa", "id_ed25519"].includes(basename)
      || /\.(?:pem|key)$/i.test(basename)) {
      findings.push({ file: relative, line: 1, category: "sensitive credential file" });
    }

    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const [category, pattern] of checks) {
        if (pattern.test(line)) findings.push({ file: relative, line: index + 1, category });
      }
      if (hasMachineSpecificHomePath(line)) {
        findings.push({ file: relative, line: index + 1, category: "machine-specific home path" });
      }
    }
  }

  return findings;
}

function safeFilename(filename) {
  return filename.replace(/[\u0000-\u001f\u007f]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function formatFindings(findings) {
  return findings.map(({ file, line, category }) => `- ${safeFilename(file)}:${line}: possible ${category}`).join("\n");
}

export function run(root = defaultRoot) {
  const findings = scanRepository(root);
  if (findings.length) {
    console.error(`Secret-safety check failed:\n${formatFindings(findings)}`);
    return 1;
  }
  console.log("Secret-safety check passed.");
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  process.exitCode = run(process.argv[2] ? path.resolve(process.argv[2]) : defaultRoot);
}
