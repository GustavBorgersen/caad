import { defineConfig, type Plugin } from "vite";
// @ts-expect-error a plain .mjs script, also run on its own
import { fetchKernel } from "./scripts/kernel-fetch.mjs";

/** The kernel's Python runtime into public/kernel/ before the dev server or the build starts. */
const kernel = (): Plugin => ({ name: "caad-kernel", buildStart: () => fetchKernel() });

export default defineConfig({
  plugins: [kernel()],
  base: "./", // relative URLs: the release bundle can be hosted in any folder (src/site.ts)
  worker: { format: "es" },
  build: { target: "es2022" },
  server: {
    fs: { allow: [".."] }, // the bundled examples live in ../examples
    // The examples are also a project you can open and edit: changes there must not reload the
    // page (and restart the kernel). The bundled copy updates on the next manual reload.
    watch: { ignored: ["**/examples/**", "**/public/kernel/**"] },
  },
});
