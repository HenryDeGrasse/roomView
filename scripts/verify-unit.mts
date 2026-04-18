/**
 * Unit-test runner for RoomView.
 *
 * Imports every `*.test.mts` under `tests/unit/`. Each test file uses Node's
 * built-in `node:test` + `node:assert/strict` modules. Tests register when
 * their module evaluates; the runner executes them and sets `process.exitCode`
 * to non-zero if any failed.
 *
 * This runs inside the same `tsx` process that launches the script, so TS
 * sources (including `@roomview/contracts` resolved via tsconfig paths) work
 * the same way the `verify:*` scripts do.
 */
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testsDir = resolve(repoRoot, "tests", "unit");

const testFiles = readdirSync(testsDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mts"))
  .map((entry) => resolve(testsDir, entry.name))
  .sort();

if (testFiles.length === 0) {
  console.error(`verify-unit: no test files found under ${testsDir}`);
  process.exit(1);
}

console.log(`verify-unit: loading ${testFiles.length} test file(s)`);

for (const testFile of testFiles) {
  // Dynamic import so any top-level `describe()` calls are evaluated and
  // registered with node:test before the default reporter finalizes.
  await import(pathToFileURL(testFile).href);
}
