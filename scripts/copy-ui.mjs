import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../src/ui", import.meta.url));
const dist = fileURLToPath(new URL("../dist", import.meta.url));
const destination = fileURLToPath(new URL("../dist/src/ui", import.meta.url));

if (process.argv.includes("--clean")) {
  rmSync(dist, { recursive: true, force: true });
  process.exit(0);
}

mkdirSync(destination, { recursive: true });
for (const name of ["index.html", "reviewer.css", "reviewer.js"]) {
  copyFileSync(path.join(source, name), path.join(destination, name));
}
