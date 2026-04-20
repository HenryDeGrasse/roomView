/**
 * Showcase-phase Track A preservation gate.
 *
 * Enforces the contract that any Flux inpaint output must stay byte-for-byte
 * identical to the reference RGB *outside* the edit mask. The Showcase doc
 * states this as "LPIPS preservation outside the edit mask ≥ 0.97 on every
 * hero render" — byte-exact equality is the strictly stronger check and is
 * what the composite step (IC-Light / masked blend) must actually deliver.
 *
 * This verifier runs in two layers:
 *
 *   1. Synthetic pair self-test. Builds a reference RGB + a "fake edit"
 *      where only pixels inside a fixture geometric mask are modified,
 *      then asserts the unmasked pixels are bitwise identical. Catches
 *      regressions in the preservation helper itself without needing a
 *      live Flux backend, so the gate stays green in CI with no GPU.
 *
 *   2. Real hero-render pass. When ROOMVIEW_PRESERVATION_PAIRS points at a
 *      JSON array of `{reference, edited, mask}` paths, each triple is
 *      checked individually — this is how a live Flux pipeline exercises
 *      the gate at release time.
 *
 * The assertion is:
 *    reference[unmasked_pixels] == edited[unmasked_pixels]  (byte-exact)
 *
 * Anything that fails the byte check trivially fails LPIPS ≥ 0.97, so we
 * don't need torch + the LPIPS model in CI.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");

interface PreservationResult {
  preserved: boolean;
  reason?: string;
  unmasked_pixel_count: number;
  total_pixel_count: number;
  max_channel_diff: number;
  reference_sha256: string;
  edited_sha256: string;
}

function runPreservationCheck(reference: string, edited: string, mask: string): PreservationResult {
  const output = execFileSync(
    "uv",
    [
      "run",
      "--with", "numpy>=1.26",
      "--with", "pillow>=10",
      "python", "-",
    ],
    {
      input: PRESERVATION_PY,
      env: {
        ...process.env,
        PRESERVATION_REFERENCE: reference,
        PRESERVATION_EDITED: edited,
        PRESERVATION_MASK: mask,
      },
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    },
  ).trim();
  return JSON.parse(output) as PreservationResult;
}

/**
 * Inline Python that takes (reference, edited, mask) file paths (supplied via
 * env vars so the shell doesn't need to quote anything), decodes each, and
 * prints a single JSON line summarizing byte-equality on the unmasked region.
 */
const PRESERVATION_PY = `
import hashlib, json, os, sys
import numpy as np
from PIL import Image

def load_rgb(path):
    img = Image.open(path).convert("RGB")
    return np.asarray(img, dtype=np.uint8)

def load_mask(path, target_shape):
    img = Image.open(path).convert("L")
    if img.size != (target_shape[1], target_shape[0]):
        img = img.resize((target_shape[1], target_shape[0]), Image.NEAREST)
    return (np.asarray(img, dtype=np.uint8) > 127).astype(bool)

ref_path = os.environ["PRESERVATION_REFERENCE"]
edit_path = os.environ["PRESERVATION_EDITED"]
mask_path = os.environ["PRESERVATION_MASK"]

ref = load_rgb(ref_path)
edit = load_rgb(edit_path)
if ref.shape != edit.shape:
    print(json.dumps({
        "preserved": False,
        "reason": f"shape mismatch: reference {ref.shape} vs edited {edit.shape}",
        "unmasked_pixel_count": 0,
        "total_pixel_count": int(np.prod(ref.shape[:2])),
        "max_channel_diff": 0,
        "reference_sha256": hashlib.sha256(ref.tobytes()).hexdigest(),
        "edited_sha256": hashlib.sha256(edit.tobytes()).hexdigest(),
    }))
    sys.exit(0)

mask = load_mask(mask_path, ref.shape[:2])
unmasked = ~mask
unmasked_pixels = int(unmasked.sum())
total_pixels = int(ref.shape[0] * ref.shape[1])

diff = np.abs(ref.astype(np.int16) - edit.astype(np.int16))
unmasked_diff = diff[unmasked]
max_unmasked_diff = int(unmasked_diff.max()) if unmasked_diff.size > 0 else 0
preserved = bool(max_unmasked_diff == 0)

print(json.dumps({
    "preserved": preserved,
    "reason": None if preserved else f"max_channel_diff={max_unmasked_diff} outside the mask (byte-exact preservation required)",
    "unmasked_pixel_count": unmasked_pixels,
    "total_pixel_count": total_pixels,
    "max_channel_diff": max_unmasked_diff,
    "reference_sha256": hashlib.sha256(ref.tobytes()).hexdigest(),
    "edited_sha256": hashlib.sha256(edit.tobytes()).hexdigest(),
}))
`;

function buildSyntheticPair(sandbox: string): { reference: string; edited: string; mask: string } {
  // Reference-bedroom fixture RGB frame + a geometrically-projected mask
  // for one wall. The "edited" image is built by replacing pixels inside
  // the mask with a solid color — any real Flux output must preserve the
  // same byte-exact property on unmasked pixels.
  const fixtureDir = resolve(REPO_ROOT, "fixtures", "roomplan", "fixture-bedroom-arkitscenes");
  const referenceRgb = resolve(fixtureDir, "frames", "frame_000001.rgb.jpg");
  assert.ok(existsSync(referenceRgb), `missing fixture reference RGB at ${referenceRgb}`);

  // Generate a geometric mask for the ceiling in frame_000001. Ceiling is
  // chosen because all 4 of its boundary corners project cleanly into the
  // frame_000001 camera view (camera is held looking up at the ceiling early
  // in the ARKitScenes capture), giving a substantial non-empty mask.
  // For walls we'd need a frame where the wall isn't straddling the view
  // frustum — not guaranteed in this specific bundle.
  const maskDir = join(sandbox, "mask");
  execFileSync(
    "uv",
    [
      "run",
      resolve(REPO_ROOT, "scripts/mask-service.py"),
      "--scene-json", resolve(fixtureDir, "scene.json"),
      "--surface-id", "surface-scene-fixture-fixture-bedroom-arkitscene-4241292c",
      "--captured-frame-id", "frame_000001",
      "--mode", "geometric",
      "--out-dir", maskDir,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const maskPngs = execFileSync("sh", ["-c", `ls ${maskDir}/*.png`], { encoding: "utf8" }).trim().split("\n");
  assert.equal(maskPngs.length, 1, `expected exactly 1 mask PNG in ${maskDir}`);
  const maskPath = maskPngs[0];

  // Build synthetic "edited" image = reference with pixels inside the mask
  // replaced by solid magenta. Runs inline via uv so we don't need to pull
  // pillow into the TypeScript toolchain.
  const editedPath = join(sandbox, "edited.png");
  execFileSync(
    "uv",
    [
      "run",
      "--with", "numpy>=1.26",
      "--with", "pillow>=10",
      "python", "-",
    ],
    {
      input: `
import os
import numpy as np
from PIL import Image

ref = np.asarray(Image.open(os.environ["REF"]).convert("RGB"), dtype=np.uint8)
mask_img = Image.open(os.environ["MASK"]).convert("L")
if mask_img.size != (ref.shape[1], ref.shape[0]):
    mask_img = mask_img.resize((ref.shape[1], ref.shape[0]), Image.NEAREST)
mask = np.asarray(mask_img, dtype=np.uint8) > 127
out = ref.copy()
out[mask] = [255, 0, 255]
Image.fromarray(out).save(os.environ["OUT"], format="PNG")
`,
      env: {
        ...process.env,
        REF: referenceRgb,
        MASK: maskPath,
        OUT: editedPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      encoding: "utf8",
    },
  );

  // Reference must be the *same encoding* as edited (both RGB arrays) —
  // re-save the reference as PNG so the byte-exact check isn't fooled by
  // JPEG→RGB roundtrip differences from Pillow.
  const referencePng = join(sandbox, "reference.png");
  execFileSync(
    "uv",
    ["run", "--with", "pillow>=10", "python", "-c", `
from PIL import Image
Image.open("${referenceRgb}").convert("RGB").save("${referencePng}", format="PNG")
`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  return { reference: referencePng, edited: editedPath, mask: maskPath };
}

interface PairSpec {
  reference: string;
  edited: string;
  mask: string;
  label?: string;
}

function main(): void {
  const sandbox = mkdtempSync(join(tmpdir(), "roomview-preservation-"));
  try {
    // Layer 1 — synthetic self-test.
    const synthetic = buildSyntheticPair(sandbox);
    const resultSynth = runPreservationCheck(synthetic.reference, synthetic.edited, synthetic.mask);
    assert.equal(
      resultSynth.preserved,
      true,
      `synthetic self-test failed: ${resultSynth.reason ?? "unknown reason"} (max_channel_diff=${resultSynth.max_channel_diff})`,
    );
    assert.ok(
      resultSynth.unmasked_pixel_count > 0,
      `synthetic mask should leave some unmasked pixels (got ${resultSynth.unmasked_pixel_count}/${resultSynth.total_pixel_count})`,
    );
    assert.ok(
      resultSynth.unmasked_pixel_count < resultSynth.total_pixel_count,
      `synthetic mask should cover at least some pixels (got unmasked=${resultSynth.unmasked_pixel_count}/${resultSynth.total_pixel_count})`,
    );
    assert.notEqual(
      resultSynth.reference_sha256,
      resultSynth.edited_sha256,
      "synthetic reference and edited should differ (inside the mask)",
    );

    // Sanity — confirm the verifier actually fails when it should. Swap a
    // pair where the "edited" image has a single changed pixel outside the
    // mask; preservation must report preserved=false with a non-zero diff.
    const tamperedEdited = join(sandbox, "tampered.png");
    execFileSync(
      "uv",
      [
        "run",
        "--with", "numpy>=1.26",
        "--with", "pillow>=10",
        "python", "-",
      ],
      {
        input: `
import os
import numpy as np
from PIL import Image
ref = np.asarray(Image.open(os.environ["REF"]).convert("RGB"), dtype=np.uint8)
mask_img = Image.open(os.environ["MASK"]).convert("L")
if mask_img.size != (ref.shape[1], ref.shape[0]):
    mask_img = mask_img.resize((ref.shape[1], ref.shape[0]), Image.NEAREST)
mask = np.asarray(mask_img, dtype=np.uint8) > 127
out = ref.copy()
out[mask] = [255, 0, 255]
# Tamper one pixel OUTSIDE the mask.
unmasked = np.argwhere(~mask)
if unmasked.size > 0:
    y, x = unmasked[0]
    out[y, x] = [0, 0, 0] if tuple(out[y, x]) != (0, 0, 0) else [255, 255, 255]
Image.fromarray(out).save(os.environ["OUT"], format="PNG")
`,
        env: {
          ...process.env,
          REF: synthetic.reference,
          MASK: synthetic.mask,
          OUT: tamperedEdited,
        },
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
      },
    );
    const resultTampered = runPreservationCheck(synthetic.reference, tamperedEdited, synthetic.mask);
    assert.equal(
      resultTampered.preserved,
      false,
      "tampered pair should fail preservation — verifier is not detecting real regressions",
    );
    assert.ok(
      resultTampered.max_channel_diff > 0,
      `tampered pair should report non-zero diff, got ${resultTampered.max_channel_diff}`,
    );

    // Layer 2 — optional live hero-render pairs.
    const livePairsEnv = process.env.ROOMVIEW_PRESERVATION_PAIRS;
    let liveCount = 0;
    if (livePairsEnv) {
      const pairs = JSON.parse(readFileSync(livePairsEnv, "utf8")) as PairSpec[];
      for (const pair of pairs) {
        const result = runPreservationCheck(pair.reference, pair.edited, pair.mask);
        assert.equal(
          result.preserved,
          true,
          `[live] ${pair.label ?? pair.edited}: preservation failed (${result.reason ?? "unknown"})`,
        );
        liveCount += 1;
      }
    }

    console.log(
      `[verify:preservation] ok · synthetic=byte-exact · tamper-detect=true` +
        (liveCount > 0 ? ` · live-pairs=${liveCount}` : " · live-pairs=skipped (set ROOMVIEW_PRESERVATION_PAIRS to enforce)"),
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main();
