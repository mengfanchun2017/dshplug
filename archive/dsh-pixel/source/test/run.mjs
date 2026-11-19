import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runs every suite in this directory and exits non-zero on the first failure.
 *
 * There is no test framework on purpose: the plugin has to load inside a DSH
 * profile that resolves nothing extra, so keeping the suites dependency-free
 * keeps the contract honest.
 *
 * Run: node test/run.mjs
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const suites = ["host.test.mjs", "client.test.mjs"];

let failed = 0;
for (const suite of suites) {
  process.stdout.write("\n=== " + suite + " ===\n");
  const result = spawnSync(process.execPath, [path.join(HERE, suite)], { stdio: "inherit" });
  if (result.status !== 0) failed += 1;
}

if (failed > 0) {
  console.error("\n" + failed + " suite(s) failed");
  process.exit(1);
}
console.log("\nall suites passed");
