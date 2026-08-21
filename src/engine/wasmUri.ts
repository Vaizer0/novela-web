// Resolves the wasmoon glue.wasm asset through the bundler so both the app
// build and vitest get a loadable URI (wasmoon's default import.meta.url
// resolution breaks under bundled/SSR environments).
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import wasmUrl from "wasmoon/dist/glue.wasm?url";

const isBrowser = typeof window !== "undefined";

export const WASM_URI: string = (() => {
  if (isBrowser) return wasmUrl; // served asset ("/node_modules/..." dev, "/assets/..." prod)
  // Vite SSR returns a root-relative path ("/node_modules/...") which on POSIX
  // collides with an absolute-looking path; prefer the on-disk location.
  const candidate = join(process.cwd(), wasmUrl);
  return pathToFileURL(existsSync(candidate) ? candidate : wasmUrl).href;
})();
