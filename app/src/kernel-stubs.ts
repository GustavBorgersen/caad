// build123d imports these; they are placeholders that import fine and only fail if that feature is used.
// Shared by the kernel worker and the Node tests (tests/kernel/env.mjs).
const STUB_MODULES = ["threejs_materials", "sympy", "sklearn", "IPython", "ezdxf", "scipy"];

export const STUBS = `
import sys, importlib.abc, importlib.machinery
from unittest.mock import MagicMock
class _Stub(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    roots = set(${JSON.stringify(STUB_MODULES)})
    def find_spec(self, name, path=None, target=None):
        return importlib.machinery.ModuleSpec(name, self, is_package=True) if name.split(".")[0] in self.roots else None
    def create_module(self, spec):
        m = MagicMock(name=spec.name); m.__path__ = []; m.__spec__ = spec; return m
    def exec_module(self, module): pass
sys.meta_path.insert(0, _Stub())
`;
