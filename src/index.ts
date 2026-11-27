/**
 * Plugin entry. One default export — a host-free definition both OpenCode
 * generations accept: v1 hosts (>= 1.17.13) call `server`, v2 hosts (2.3.2)
 * call `setup`. It must stay the module's ONLY export: a v1 host handed a
 * legacy function default runs every named export as a plugin factory, and
 * `./server` in package.json resolves here (plugin-entry-guard.test.ts).
 *
 * Neither adapter imports a host SDK or runs at module load time.
 */
import { serverV1 } from "./plugin-v1";
import { setupV2 } from "./plugin-v2";

export default {
  id: "space-bus",
  server: serverV1,
  setup: setupV2,
};
