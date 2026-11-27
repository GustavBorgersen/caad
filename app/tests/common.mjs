// Helpers for every test file.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** An assertion named by what it checks; `detail` is added when it fails. */
export const check = (ok, what, detail = "") => assert.ok(ok, detail === "" ? what : `${what}\n      ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);

/** The caad-mcp binary for this system: $CAAD_MCP, else what `npm run build:bridge` made; null when there is none. */
export const bridgeBinary = () => {
  if (process.env.CAAD_MCP) return process.env.CAAD_MCP;
  const os = { win32: "windows" }[process.platform] ?? process.platform;
  const arch = { x64: "amd64" }[process.arch] ?? process.arch;
  const bin = fileURLToPath(new URL(`../../bridge/dist/caad-mcp-${os}-${arch}${os === "windows" ? ".exe" : ""}`, import.meta.url));
  return existsSync(bin) ? bin : null;
};
