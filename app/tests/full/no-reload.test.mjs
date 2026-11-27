// Editing a file in ../examples must not reload the page in the dev server (it would restart the kernel).
import { after, test } from "node:test";
import { utimesSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { check } from "../common.mjs";
import { openApp, sleep } from "../ui/env.mjs";

const app = await openApp("no-reload", { wait: false }); // no need for the kernel
after(() => app.close());

test("touching an example doesn't reload the page", async () => {
  await sleep(2000);
  await app.page.evaluate(() => { window.marker = "still here"; });
  const now = new Date();
  utimesSync(fileURLToPath(new URL("../../../examples/caad-examples/parts/bracket.py", import.meta.url)), now, now);
  await sleep(3000);
  check(await app.page.evaluate(() => window.marker).catch(() => undefined) === "still here", "the page wasn't reloaded");
});
