# Stretch Goals: The Full Product Vision
*v0.4 Draft · Owner: Applied AI / 3D Systems*

## TL;DR

The MVP is a tool for scanning and redesigning one bedroom with an iPhone + web editor, featuring two-fidelity rendering and conversational editing. The full vision is a tool for understanding and redesigning any space — a room, an apartment, a whole house — starting from any input (scan, floorplan, prompt) and supporting any edit (rearranging furniture, regenerating rooms, redesigning entire layouts). The core bet: once scanned and synthetic rooms live in the same canonical representation, the interesting product space is *hybrid redesign* — keep what you love about your current home, regenerate the parts you don't, and see it all rendered photoreal.

This document describes the ambitious long-term product as **three independent tracks** that can advance at different speeds: scene acquisition, design intelligence, and professional outputs. The MVP (`MVP.md`) is explicitly designed to preserve every option here without schema migrations or rewrites.

---

## The Killer Feature

A homeowner says: *"Keep my living room and kitchen as they are. Redesign my upstairs — instead of three small bedrooms, make it two bedrooms and a home office, with the primary suite on the east side."*

The system, working from a scan of the current home and a generative model for the redesigned upstairs, produces: a new floorplan for the redesigned portion, fully-furnished rooms within that plan, preserved downstairs exactly as scanned, photoreal visualizations across the whole home, and a BOM-adjacent materials list the user can hand to a contractor.

Nobody can do this today. Matterport scans but doesn't redesign. Planner 5D designs from scratch or from scans but doesn't offer this kind of structured regenerative editing. RoomGPT restyles 2D images. Architects do it but take months and charge thousands.

This killer feature isn't a single track — it's a *cross-track milestone* that requires mature capabilities from all three tracks below (multi-room acquisition, hybrid regeneration intelligence, coherent photoreal output). Seeing it land is what tells us the whole vision is working.

---

## Three Tracks

The roadmap below is structured as three independent tracks. They advance at different paces — scene acquisition moves with platform SDKs and model research, design intelligence moves with LLM and layout-gen progress, professional outputs move with standards-integration work. Reading each track in isolation gives a clearer picture than mashing them into one timeline.

### Track 1: Scene Acquisition & Representation

The capability to get a room — any room, any space — into the canonical schema.

**v1 (MVP).** iPhone capture via RoomPlan. Parametric shell plus object detection, with attributes and parent relationships preserved. Splat trains asynchronously for the scan pane. Single bedroom.

**v1.1.** Splat quality and speed improvements as the open-source 3DGS ecosystem matures. Splat editing — modifying the scan directly (repaint a real wall, replace a real object inside the splat).

**v1.2.** Floorplan ingestion — upload 2D plans (DXF, raster PDF with scale) and extrude shells. Same schema, same editor. Synthetic ingestion — generate a shell and populate from a prompt. The three entry points converge on identical `Scene` JSON.

**v1.3.** Android capture via ARCore Scene Semantics + Depth API, with a bespoke object-detection pipeline bridging the quality gap against RoomPlan. Quality initially lags iOS.

**v2.** Multi-room scenes. The room-adjacency graph activates — `Opening.connects_to_room_id` starts being populated, rooms link via doorways, halls, and stairs. This track item is *less speculative than it looks*: Apple already supports continuous ARSession and multi-room merging workflows, with best results on single-floor homes around 2,000 sqft. This is a product/UX expansion more than a research moonshot.

**v2.5.** Whole-house acquisition — scan multiple rooms across sessions, link them with taps or automated merging. Floorplan upload extends to whole-house plans.

**v3+.** Non-Manhattan and curved architecture. Historic, unusual, or luxury-market rooms. Outdoor capture for patios, pool areas, and indoor-outdoor transitions.

---

### Track 2: Design Intelligence

The capability to understand, edit, and generate room and house designs.

**v1 (MVP).** Conversational editing against a bedroom scene. Five hard + three soft constraints. Typed edit operations with interpretable rejection. Photoreal generation from fixed viewpoints.

**v1.1.** Arbitrary-angle photoreal. Realistic splat+3D composite rendering (*the v1.1 flagship from the MVP doc's perspective, also counted here as an intelligence upgrade because "fit the new object into the real lighting" is a reasoning task*).

**v1.2.** Expanded constraint library — kitchen work triangle, bathroom clearance standards, class-specific ergonomic rules for ten more furniture classes. Needed as scene types expand beyond bedrooms.

**v1.3.** Photoreal style exploration — *"show me this room in five styles."* Grid generation of photoreal variants with the scene's geometry locked.

**v2.** Cross-room edits. *"Make the kitchen feel continuous with the living room."* Requires multi-room from Track 1. House-level soft constraints (bedroom-to-bathroom proximity, kitchen-to-dining adjacency).

**v2.5.** Hybrid regeneration — the signature feature. User marks rooms as "keep," "restyle," or "regenerate." System preserves, restyles, or generates under topology constraints. This is where the killer feature lands.

**v2.5.** Whole-house floorplan generation from program description. *"3BR/2BA, 1,800 sqft, ranch, open kitchen"* → plausible floorplan → per-room layouts → renders.

**v3.** Live photoreal rendering. Every edit re-renders photoreal in under a second. Latency and cost problem, not a capability problem; waits for generation models to get cheaper and faster.

**v3.** Photoreal video and walkthroughs. Short video clips of the redesigned space — camera dolly, door opening, lighting transition.

**v3+.** Style coherence with local overrides across whole homes. Scene-level style profile cascades to rooms and objects with room-specific overrides.

---

### Track 3: Professional Outputs

The capability to produce outputs real people and professionals act on.

**v1 (MVP).** Photoreal image gallery with camera-bookmark anchoring and scene-version provenance. Images are shareable artifacts.

**v1.2.** Furniture BOM — list of assets with retailer links where available. Early commerce integration.

**v1.3.** Material swatches with retailer or paint-brand matches. Rough cost estimates for furniture and finish changes.

**v2.** Room dimensions and measurement documents. USD export for Omniverse and pro 3D pipelines (schema is already USD-aligned). DXF export for contractors.

**v2.5.** IFC export for architects and builders. PDF renderings formatted for permit applications in simple remodel cases.

**v3.** Structural awareness — load-bearing wall identification, plumbing stack flags, HVAC implications surfaced when edits would affect them.

**v3+.** Code compliance checks — egress windows in bedrooms, ceiling heights, stair rise and run, fixture-to-door clearances. Building-code-aware warnings on proposed edits.

---

## Cross-Track Milestones

Specific product moments that require progress on multiple tracks simultaneously.

**"See your actual room, edited."** Requires Track 1 (good splat), Track 2 (Realistic composite rendering). Lands in v1.1.

**"Imagine a new room."** Requires Track 1 (synthetic ingestion), Track 2 (layout generation). Lands in v1.2.

**"Design your whole home."** Requires Track 1 (multi-room), Track 2 (cross-room edits). Lands in v2.

**"Redesign half your home, keep the other half."** The killer feature. Requires Track 1 (multi-room), Track 2 (hybrid regenerate), Track 3 (photoreal output across scales). Lands in v2.5.

**"Hand this to a contractor."** Requires Track 3 depth (BOMs, measurements, DXF), plus Track 2 maturity (constraint realism). Lands in v2.5 for simple cases, v3+ for anything structurally non-trivial.

**"Replace your architect for this remodel."** Requires all three tracks at near-maturity. Explicitly aspirational, not promised on any specific timeline. Honest framing below.

---

## The Honest Caveats

**"Replace your architect" is an aspiration, not a deliverable.** An architect does site analysis, navigates zoning and permitting, coordinates with structural engineers and MEP consultants, manages contractors, and bears professional liability. This system will accelerate the creative and exploratory parts of the process, and eventually produce permit-grade plans for simple projects. It will not replace a professional for anything structurally non-trivial on any timeline we can credibly promise. The right framing is *"the tool that makes layperson design inspiration-grade, and serves as high-quality input to a real architect when one gets involved."*

**Whole-house generation quality is bounded by generation models.** Current floorplan generators produce plans that look right at a glance but often have subtle issues — plumbing walls that don't line up across floors, HVAC implications that are ignored, circulation that gets weird under scrutiny. Layperson-inspiration-grade is achievable soon; professional-grade needs either significant model improvement or heavy constraint scaffolding, and we shouldn't promise it until we see it.

**Live photoreal has cost and latency floors.** Even as generative models get faster, each photoreal render costs money and takes time. Live photoreal on every edit is expensive per session. The economics work at subscription prices typical of design-tool markets, but require careful caching and per-user rate limits. This is a product-economics problem to solve at subscription-tier design time.

**Realistic compositing has a quality ceiling until lighting harmonization matures.** v1.1 Realistic will land with heuristic light matching — good enough for most rooms, imperfect in challenging lighting. True photographic quality for splat+mesh compositing requires ongoing research we're consuming, not producing.

**RoomPlan class coverage is finite and useful, not comprehensive.** The published RoomPlan taxonomy is a bounded set of room-defining objects. iOS 17 attributes make it more expressive but it's not open-vocabulary. Supplementary detection covers smaller décor, lamps, and miscellany.

---

## What Has to Be True

**Scan quality and robustness.** RoomPlan output has to be good across a wide range of rooms, lighting, and clutter. Android capture has to close the gap. Whole-house has to work across multiple sessions.

**Asset library scale.** ~500 assets for MVP bedrooms. Whole-house across styles and rooms needs tens of thousands. The library becomes its own product problem — sourcing, licensing, tagging, quality control, deduplication.

**Constraint library depth.** Five constraints for a bedroom. A whole house needs dozens: kitchen work triangle, bathroom clearance standards, stair rise and run, ceiling height minimums, bedroom window egress. All expressible in the existing framework; each needs authoring and testing.

**Generation quality and speed.** Floorplan generation has to stop producing subtle weirdness. Photoreal image generation has to get faster and cheaper for live rendering. Photoreal video has to become real. Model-capability bets plus scaffolding problems.

**LLM reliability for structured edits.** The chat-to-operation layer has to work almost all the time. Each new product surface — cross-room edits, structural edits, program-level changes — tests that reliability in a new way and may require domain-specific fine-tuning.

**Splat rendering in the browser at scale.** Realistic mode depends on fast in-browser splat rendering that composites cleanly with Three.js objects. The open-source gaussian-splats-3d ecosystem is maturing fast; we track and consume it.

None of these are blockers. All are places where near-term research and engineering progress is steady.

---

## Why Now

Five tailwinds make this the right moment.

**RoomPlan made room capture a production primitive.** Before RoomPlan, scan-to-structured-scene required custom ML pipelines that were fragile; now it's an SDK call, and iOS 17 added attributes, parent relationships, and multi-room merging that align unusually well with a canonical-scene architecture.

**Gaussian splatting solved "scan looks real."** Photogrammetry was plasticky; NeRFs were slow. Splats render photoreal at 60fps on consumer hardware. Fast indoor 3DGS reconstruction is improving quickly but still in active optimization — hence our shell-first, splat-second sequencing.

**Structural-conditioning image generation is production-grade.** Depth + edge ControlNets and native multimodal equivalents let us lock geometry while the model invents appearance. That makes photoreal-from-3D credible.

**LLMs are reliable at structured output.** Chat-to-operation translation against a typed schema is production-grade today; three years ago it was a research project.

**3D asset quality crossed a usability threshold in 2024–2025.** A curated retrieval library is a weekend's work rather than a year's, and generative 3D fills gaps on demand.

None of these were true three years ago. All of them hold together in a coherent product *only* if the underlying representation is right — which is the entire argument for the canonical room schema and the discipline enforced in the MVP.

---

## Sequencing Principle

Throughout the roadmap, a single principle holds: **never ship a feature that requires a schema migration we could have avoided.**

Every track's capabilities have to be expressible in an extension of the MVP schema, not a replacement. Realistic adds a renderer, not entities. Multi-room extends `Scene` to hold multiple `Room`s. Synthetic adds a value to the `source` enum. Whole-house generation produces floorplans that re-enter through existing ingestion. Live photoreal uses the same generation pipeline as MVP photoreal, just triggered differently. Photoreal video extends the photoreal pipeline to temporal outputs. Splat editing extends the `AssetRef` model with writable splat operations. Professional exports are transforms on top of USD-aligned JSON.

This is why the MVP is slightly more disciplined than strictly necessary. Every architectural choice in `MVP.md` is load-bearing for something here.
