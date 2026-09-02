import { fileURLToPath } from "node:url";

/**
 * Absolute path to the CLI package's bundled first-party plugin copies
 * (src/bundled-plugins at build time, dist/src/bundled-plugins once built).
 * Kept in its own module so both cli.ts and http-server.ts can import it
 * without creating a circular dependency between them.
 */
export function bundledPluginsRoot(): string {
  return fileURLToPath(new URL("./bundled-plugins", import.meta.url));
}
