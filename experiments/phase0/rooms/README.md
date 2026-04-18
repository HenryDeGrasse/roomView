# Local room bundles

Create one subdirectory per room here.

Example:

```text
experiments/phase0/rooms/
  bedroom-a/
    manifest.json
    cases.json
    frames/
      frame_front.jpg
      frame_front.depth.png
      frame_front.pose.json
      frame_front.intrinsics.json
      frame_corner.jpg
```

Copy the templates from `experiments/phase0/templates/` and then update the file paths, room ids, and prompts.

This directory is intentionally Git-ignored so you can keep private room photos and bench inputs local.
