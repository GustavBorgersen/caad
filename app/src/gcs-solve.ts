// Solving sketches with PlaneGCS (WebAssembly). The kernel registers `solve` with Pyodide as the module
// `caad_gcs`, so Python's caad module solves constrained sketches at every build (docs/06-sketches.md).
// Shared by the kernel worker and the Node tests.
import { GcsWrapper, init_planegcs_module } from "@salusoft89/planegcs";

/** Load PlaneGCS. `wasmUrl`: where planegcs.wasm is served (default: next to the package's JS). */
export async function loadSolver(wasmUrl?: string) {
  const mod = await init_planegcs_module(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
  return {
    /**
     * Primitives in PlaneGCS's JSON form → JSON with `status` (0 success, 1 converged, 2 failed, 3 invalid),
     * `dof` (degrees of freedom left), `conflicting` and `redundant` constraint ids, and the solved `primitives`.
     */
    solve(json: string): string {
      const gcs = new GcsWrapper(new mod.GcsSystem());
      try {
        gcs.push_primitives_and_params(JSON.parse(json));
        const status = gcs.solve();
        gcs.apply_solution();
        return JSON.stringify({
          status, dof: gcs.gcs.dof(),
          conflicting: gcs.get_gcs_conflicting_constraints(), redundant: gcs.get_gcs_redundant_constraints(),
          primitives: gcs.sketch_index.get_primitives(),
        });
      } finally {
        gcs.destroy_gcs_module();
      }
    },
  };
}
