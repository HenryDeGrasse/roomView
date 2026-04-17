The plan is directionally solid, but it has a major premortem smell: the highest-risk steps all have `requiredChecks: ["noop"]`. That makes silent semantic drift very likely.

# Most likely failure chain

## Failure summary
The MVP ends up “working” superficially, but the canonical scene state is wrong: object placement, validation, quick render, undo, and photoreal outputs disagree because the semantic model and versioned snapshot boundary were defined inconsistently early on.

## Which step failed?
Primary failure: `step-1` (`Finalize the authoritative scene schema and semantic model`)

Likely follow-on breakage in:
- `step-2` versioning boundaries
- `step-4` ingest / initial scene creation
- `step-7` deterministic validation
- `step-10` photoreal tied to immutable scene state

## Root cause
`step-1` is doing too much and has no concrete verification. The plan says to define:
- `Polygon2D`
- `RectOnSurface`
- `Pose3D`
- `OBB3D`
- `ConstraintSpec`
- `FixedElement`
- room-local axes
- separation of canonical vs derived/cache state

If this step is even slightly wrong, the whole system can become internally inconsistent in a way that still compiles and renders.

The most likely schema mistake is one of these:
1. **Coordinate frame ambiguity**
   - RoomPlan data is ingested in one frame, but canonical scene uses another.
   - Y-up vs Z-up confusion.
   - Room-local axes not explicitly pinned to wall ordering / floor plane normal.
   - Rotations stored as degrees in one place, radians in another.

2. **Canonical vs derived boundary leakage**
   - Derived data such as footprints, collision hulls, navigable path regions, or render-specific transforms get stored into the versioned snapshot.
   - Later recomputation changes those values, so “same scene_version” no longer yields the same quick render or photoreal conditioning inputs.

3. **Identity instability**
   - Stable IDs for RoomPlan elements are not preserved across ingest/recompute.
   - Undo and conversational edits later target objects by IDs that shift after validation or re-ingest.

A concrete manifestation would be:
- `/server/src/schema/scene.ts` defines `Pose3D.yaw` in radians
- `/ios/App/RoomCaptureMapper.swift` serializes degrees
- `/web/src/render/sceneToThree.ts` assumes meters and radians
- `/server/src/validation/recomputeDerived.ts` rebuilds OBBs using another axis convention

That gives you a scene that looks “close enough” in the editor but fails deterministic validation or produces photoreal images not matching the editor.

## Why the checks did not catch it
They didn’t exist. `requiredChecks` is `noop` for the schema-defining step.

Even if downstream agents added basic type checks, they would not catch:
- semantic frame mismatches
- non-deterministic recomputation
- version boundary contamination
- ID instability

Typical weak checks that would still pass:
- TypeScript compiles
- JSON schema validates
- a room loads in the UI
- a quick renderer draws something plausible

None of those verifies that:
- recomputing derived state is deterministic
- snapshot contents are immutable and minimal
- scene_version reproduces the same render
- apply/undo targets the same object IDs

## Warning signs the agents would have seen
They should have treated these as red flags:
- Terms like “room-local axes” and “canonical editable state” were specified in prose only, with no example payload.
- `step-1` and `step-2` were both marked `highStakes` but had no required validation.
- `step-4` depends on “stable IDs” before any stability test is defined.
- `step-7` assumes “documented order” for validation, but no golden fixture or reference scene is mandated.
- Quick render and photoreal are both supposed to be tied to immutable scene state, but no “same input scene_version => same output inputs” test is specified.

Practical symptoms agents might notice during implementation:
- Re-running ingest on the same scan yields different object IDs or object order.
- A re-save with no edits changes serialized snapshot JSON.
- Undo restores geometry approximately, but not bit-for-bit.
- Quick render footprints differ from validation footprints by a few centimeters or rotations by 90°.

## Concrete mitigation
Before any coding beyond `step-1`, add one golden round-trip fixture and one determinism test.

Specifically:
- Create a fixture file such as `fixtures/roomplan/bedroom-01.json`
- Define expected canonical snapshot at `fixtures/scene/bedroom-01.snapshot.json`
- Require this verification in CI:

1. Ingest fixture twice.
2. Diff the produced canonical snapshot JSONs.
3. Recompute derived state twice from the same snapshot.
4. Assert the second result is byte-identical for canonical fields and stable for derived fields.
5. Assert all IDs are unchanged.

In command form, the agents should add and run something equivalent to:
- `npm test -- scene-schema-determinism`
or
- `pnpm vitest run tests/scene-schema-determinism.test.ts`

And the test should explicitly fail if:
- any canonical field changes on recompute
- any object ID changes
- any pose/OBB differs after a no-op round trip

---

# Second most likely failure chain

## Failure summary
The system ends up insecure or logically non-authoritative: the phone-to-web handoff, chat planner, apply path, and undo appear functional, but stale/tampered plans can be applied, scene edits race, or users can access scenes they should not. The result is wrong scene state and broken trust guarantees.

## Which step failed?
Primary failure: `step-3` (`Define the secure handoff and server-authoritative API contract`)

Likely follow-on breakage in:
- `step-8` atomic apply, locking, and undo
- `step-9` LLM planner and chat-driven edits
- `step-5` scene read/delete APIs

## Root cause
The API contract was probably underspecified, so later steps implemented “server authoritative” only partially.

Most likely concrete mistake:
1. The handoff link/QR redemption is implemented, but the resulting web session is not strongly bound to:
   - a specific scene
   - an expiry
   - one-time redemption
   - a server-side session record

2. The planner/apply flow trusts client-provided data too much:
   - client sends `scene_version`
   - client sends typed edit ops
   - server validates syntax but not a server-issued plan token tied to the exact scene head and user session

3. Apply is not truly atomic:
   - validate against head version N
   - commit happens after another write advanced the head
   - stale edits are still accepted or “merged” incorrectly

4. Undo is implemented as “apply inverse op” rather than “restore previous immutable snapshot”, so races or derived recomputation differences cause wrong restored state.

A plausible file-level failure pattern:
- `/server/src/routes/handoff.ts` creates a redeem token but does not mark it single-use
- `/server/src/routes/session.ts` exchanges it for a generic auth cookie not scoped to `scene_id`
- `/server/src/routes/apply.ts` checks `expectedVersion` from the client but does not verify a server-issued plan token or lock ownership
- `/web/src/chat/useApplyPlan.ts` retries stale applies automatically
- `/server/src/store/scenes.ts` increments head version outside a transaction

That yields subtle wrongness:
- two tabs can both apply against the same scene
- copied links still work after first use
- a stale chat plan applies to the wrong scene state
- undo restores the wrong arrangement after intervening edits

## Why the checks did not catch it
Again, the plan’s checks are `noop`, and this class of failure often slips past happy-path demos.

Weak checks that would pass:
- QR handoff opens the correct scene once
- one user can edit successfully
- undo appears to work in a single-tab manual test
- planner returns typed ops that validate

What wouldn’t be tested unless explicitly added:
- redeeming the same handoff link twice
- redeeming after expiry
- applying the same plan token twice
- applying with stale `expectedVersion`
- editing from two browser tabs concurrently
- undo after an intervening edit
- attempting scene read/delete with a session scoped to another scene

## Warning signs the agents would have seen
The plan itself contains several warnings:
- `step-3` says “preferably” a one-time handoff link or QR flow, which leaves room for a weaker implementation.
- “server authoritative” is described conceptually, but no required negative tests are listed.
- `step-8` depends on a “server-issued plan token,” but no earlier step guarantees token shape, storage, TTL, or binding semantics.
- `step-5` includes delete APIs early, before access control validation is concretely tested.

Implementation red flags agents should notice:
- Handoff tokens are plain JWTs with no server-side redemption table.
- Apply endpoint accepts raw typed ops plus `expectedVersion` with no token proving the plan was generated from that exact head.
- Database write path lacks a compare-and-swap or transaction around head version advancement.
- Undo is implemented by reversing the last op instead of restoring snapshot N-1.
- Frontend caches full scene state and can continue editing after authorization changes.

## Concrete mitigation
Add one concurrency/auth integration test suite before `step-8` is considered complete.

Specifically, agents should implement and run tests equivalent to:
- `tests/integration/handoff-and-apply-auth.test.ts`
- `tests/integration/concurrent-apply.test.ts`

The suite should verify:
1. A handoff token can be redeemed exactly once.
2. A redeemed session can only read/write its scoped `scene_id`.
3. Apply with stale `expectedVersion` is rejected.
4. Apply without a valid server-issued plan token is rejected.
5. Reusing the same plan token is rejected.
6. Two concurrent applies against the same head result in exactly one success.
7. Undo restores the exact previous immutable snapshot, not a recomputed approximation.

A concrete command:
- `npm test -- tests/integration/handoff-and-apply-auth.test.ts tests/integration/concurrent-apply.test.ts`

If agents cannot build full integration tests immediately, the minimum mitigation is:
- ensure the storage layer has a single transactional compare-and-swap on scene head version before proceeding with any apply implementation.

---

# Short conclusion
The two most likely failure chains are:

1. **Wrong canonical scene semantics from `step-1`** leading to inconsistent validation/render/version behavior.
2. **Not truly server-authoritative from `step-3`/`step-8`** leading to stale, tampered, or concurrent edits corrupting scene state.

Both are highly plausible because the plan has no nontrivial required checks at the exact points where irreversible architectural mistakes are introduced.