import { defineConfig } from "vite";

export default defineConfig({
  worker: { format: "es" },
  build: { target: "es2022" },
  server: {
    fs: { allow: [".."] }, // the bundled examples live in ../examples
    // The examples are also a project you can open and edit: changes there must not reload the
    // page (and restart the kernel). The bundled copy updates on the next manual reload.
    watch: { ignored: ["**/examples/**"] },
  },
});
