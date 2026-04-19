/**
 * Showcase Track C smoke test: iOS CapturedRoom mapping round-trip.
 *
 * 1. Validate that the committed iOS sample payload
 *    (fixtures/ios/mapper-sample-bedroom.json — produced by the
 *    `RoomViewCapture` Swift package's synthetic-bedroom test) still
 *    ingests cleanly through `RoomPlanCaptureService`. Catches
 *    regressions in either the Swift-side mapping or the
 *    TypeScript-side ingest contract.
 * 2. Run `swift test` if a Swift toolchain is available to re-verify the
 *    mapper's 18 unit tests locally. Skipped gracefully on Linux CI
 *    without Swift.
 *
 * Keeps `npm run check` green without Xcode — a Mac dev re-running this
 * after changes to either side picks up contract drift immediately.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

function main(): void {
  // Part 1 — validate committed sample payload via the existing script.
  const sampleFixture = resolve(REPO_ROOT, "fixtures/ios/mapper-sample-bedroom.json");
  assert.ok(existsSync(sampleFixture), `iOS sample payload missing: ${sampleFixture}`);

  const validatorOutput = execFileSync(
    "npx",
    ["--yes", "tsx", resolve(REPO_ROOT, "scripts/validate-ios-payload.mts"), "--payload", sampleFixture],
    { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  assert.ok(
    validatorOutput.includes("OK  payload="),
    `validator did not emit OK for ${sampleFixture}: ${validatorOutput}`,
  );
  // Sanity-check the sample's structure agrees with what the Swift test
  // claims (1 object, 4 walls + floor + ceiling = 6 surfaces, 2 openings).
  const sample = JSON.parse(readFileSync(sampleFixture, "utf8"));
  const payload = sample.roomplan_payload;
  assert.equal(payload.surfaces.length, 6, "expected 4 walls + floor + ceiling from synthetic bedroom");
  assert.equal(payload.openings.length, 2, "expected 2 openings in the synthetic bedroom");
  assert.equal(payload.objects.length, 1, "expected 1 scene object (a bed) from the synthetic test");

  // Part 2 — if swift is on PATH, run the Swift package tests as a second
  // belt-and-suspenders verification. Skipped silently when not available
  // (e.g. Linux CI).
  const swiftOnPath = spawnSync("which", ["swift"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  let swiftTestSummary = "skipped (no swift on PATH)";
  if (swiftOnPath.status === 0 && swiftOnPath.stdout.trim().length > 0) {
    const swiftResult = spawnSync(
      "swift",
      ["test", "--package-path", resolve(REPO_ROOT, "ios/RoomViewCapture"), "--quiet"],
      { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
    );
    if (swiftResult.status !== 0) {
      const tail = (swiftResult.stderr || swiftResult.stdout || "").trim().split("\n").slice(-6).join("\n");
      throw new Error(`swift test failed:\n${tail}`);
    }
    // Count the "passed" test banners in the stderr (swift-testing prints there).
    const combined = (swiftResult.stderr || "") + (swiftResult.stdout || "");
    const passMatch = combined.match(/Test run with (\d+) tests? passed/);
    swiftTestSummary = passMatch ? `${passMatch[1]} tests` : "passed";
  }

  console.log(
    `[verify:ios-payload] ok · sample_ingest=clean · swift_tests=${swiftTestSummary}`,
  );
}

main();
