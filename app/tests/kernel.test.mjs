// The kernel tests: every suite in tests/kernel/ in one process, sharing one kernel (booting it takes most
// of the time). The page's kernel code (public/caad_kernel.py, caad.py) in Node, without a browser.
import "./kernel/run.mjs";
import "./kernel/select.mjs";
import "./kernel/sketch-plane.mjs";
import "./kernel/feature.mjs";
import "./kernel/constrained.mjs";
import "./kernel/sketch-edit.mjs";
import "./kernel/guide.mjs";
import "./kernel/params.mjs";
