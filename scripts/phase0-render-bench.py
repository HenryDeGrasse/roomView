#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "torch",
#   "torchvision",
#   "diffusers>=0.30.0",
#   "transformers>=4.44.0",
#   "accelerate>=0.34.0",
#   "controlnet-aux>=0.0.10",
#   "pillow>=10.4.0",
#   "numpy>=1.26.4",
#   "safetensors>=0.4.4",
# ]
# ///

from __future__ import annotations

import argparse
import csv
import gc
import hashlib
import json
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import numpy as np
from PIL import Image, ImageOps
import torch

MODELS = {
    "base": "stabilityai/stable-diffusion-xl-base-1.0",
    "vae": "madebyollin/sdxl-vae-fp16-fix",
    "controlnet_depth_small": "diffusers/controlnet-depth-sdxl-1.0-small",
    "ip_adapter_repo": "h94/IP-Adapter",
    "ip_adapter_base_weight": "ip-adapter_sdxl.safetensors",
    "ip_adapter_plus_weight": "ip-adapter-plus_sdxl_vit-h.safetensors",
    "ip_adapter_plus_encoder_subfolder": "models/image_encoder",
    "dpt_depth_model": "Intel/dpt-hybrid-midas",
    "controlnet_aux_repo": "lllyasviel/Annotators",
}

DEFAULT_NEGATIVE_PROMPT = (
    "low quality, blurry, distorted perspective, warped furniture, bad geometry, "
    "extra windows, extra doors, duplicate furniture, text, watermark"
)

ALL_MODES: tuple[str, ...] = ("prompt_only", "ref_only", "depth_only", "ref_depth")

_DEPTH_MODEL_CACHE: dict[tuple[str, str], Any] = {}


@dataclass(frozen=True)
class FrameSpec:
    frame_id: str
    rgb_path: Path
    depth_path: Path | None
    pose_path: Path | None
    intrinsics_path: Path | None
    tags: tuple[str, ...]


@dataclass(frozen=True)
class CaseSpec:
    case_id: str
    reference_frame_id: str | None
    prompt: str
    negative_prompt: str | None
    tags: tuple[str, ...]


@dataclass(frozen=True)
class RoomBundle:
    room_id: str
    capture_id: str
    bundle_dir: Path
    primary_frame_id: str | None
    roomplan_raw_path: Path | None
    frames: dict[str, FrameSpec]
    cases: tuple[CaseSpec, ...]
    default_negative_prompt: str | None
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class CaseAssets:
    reference_image: Image.Image
    reference_frame_id: str
    reference_source_path: Path
    depth_image: Image.Image | None
    depth_source: str | None
    output_dir: Path


@dataclass(frozen=True)
class JobSpec:
    room_id: str
    case_id: str
    reference_frame_id: str
    mode: str
    sample_index: int
    seed: int
    prompt: str
    negative_prompt: str
    output_dir: Path
    blind_id: str
    reference_source_path: Path
    depth_source: str | None


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parent.parent
    phase0_root = repo_root / "experiments" / "phase0"

    parser = argparse.ArgumentParser(
        description="Run the local Phase 0 SDXL indoor-room render benchmark.",
    )
    parser.add_argument(
        "--rooms-dir",
        type=Path,
        default=phase0_root / "rooms",
        help="Directory containing one subdirectory per room bundle.",
    )
    parser.add_argument(
        "--results-dir",
        type=Path,
        default=phase0_root / "results",
        help="Directory where benchmark runs are written.",
    )
    parser.add_argument(
        "--room",
        action="append",
        dest="rooms",
        default=[],
        help="Specific room_id to include. Repeat to include multiple rooms.",
    )
    parser.add_argument(
        "--modes",
        default=",".join(ALL_MODES),
        help="Comma-separated subset of modes: prompt_only,ref_only,depth_only,ref_depth",
    )
    parser.add_argument(
        "--samples",
        type=int,
        default=2,
        help="Number of samples per case per mode.",
    )
    parser.add_argument(
        "--seed-base",
        type=int,
        default=12345,
        help="Base seed. Sample i uses seed_base + i.",
    )
    parser.add_argument(
        "--width",
        type=int,
        default=1024,
        help="Output width in pixels.",
    )
    parser.add_argument(
        "--height",
        type=int,
        default=1024,
        help="Output height in pixels.",
    )
    parser.add_argument(
        "--resize-mode",
        choices=("crop", "pad"),
        default="crop",
        help="How to resize source room photos onto the SDXL canvas.",
    )
    parser.add_argument(
        "--num-steps",
        type=int,
        default=30,
        help="Number of SDXL denoising steps.",
    )
    parser.add_argument(
        "--guidance-scale",
        type=float,
        default=5.0,
        help="Classifier-free guidance scale.",
    )
    parser.add_argument(
        "--controlnet-scale",
        type=float,
        default=0.5,
        help="ControlNet depth conditioning scale.",
    )
    parser.add_argument(
        "--ip-adapter-scale",
        type=float,
        default=0.6,
        help="IP-Adapter conditioning scale.",
    )
    parser.add_argument(
        "--ip-adapter-kind",
        choices=("base", "plus"),
        default="base",
        help="IP-Adapter weight variant.",
    )
    parser.add_argument(
        "--depth-source",
        choices=("auto", "manifest", "midas", "dpt"),
        default="auto",
        help=(
            "How to obtain a depth conditioning image. 'auto' uses manifest depth when present, "
            "otherwise MiDaS via controlnet_aux."
        ),
    )
    parser.add_argument(
        "--depth-device",
        choices=("cpu", "mps"),
        default="cpu",
        help="Device for depth preprocessing. CPU is recommended for stability.",
    )
    parser.add_argument(
        "--device",
        choices=("auto", "mps", "cpu"),
        default="auto",
        help="Device for SDXL generation.",
    )
    parser.add_argument(
        "--attention-slicing",
        action="store_true",
        help="Enable attention slicing on the diffusion pipelines.",
    )
    parser.add_argument(
        "--vae-slicing",
        action="store_true",
        help="Enable VAE slicing on the diffusion pipelines.",
    )
    parser.add_argument(
        "--warmup",
        action="store_true",
        help="Run a one-step warmup inference per pipeline before timing.",
    )
    parser.add_argument(
        "--max-cases",
        type=int,
        default=None,
        help="Limit the number of cases per room for quick iteration.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate room bundles and print the planned jobs without loading models.",
    )
    parser.add_argument(
        "--skip-existing",
        action="store_true",
        help="Skip a render if the blind output path already exists in the current run directory.",
    )
    return parser.parse_args()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip())
    return slug.strip("-") or "item"


def json_load(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_path(bundle_dir: Path, value: str | None) -> Path | None:
    if value is None:
        return None
    path = Path(value)
    return path if path.is_absolute() else (bundle_dir / path).resolve()


def determine_device(choice: str) -> str:
    if choice == "auto":
        return "mps" if torch.backends.mps.is_available() else "cpu"
    if choice == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("--device mps requested but torch.backends.mps.is_available() is false")
    return choice


def determine_dtype(device: str) -> torch.dtype:
    return torch.float16 if device == "mps" else torch.float32


def model_kwargs(dtype: torch.dtype) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "torch_dtype": dtype,
        "use_safetensors": True,
    }
    if dtype == torch.float16:
        kwargs["variant"] = "fp16"
    return kwargs


def model_kwargs_without_variant(dtype: torch.dtype) -> dict[str, Any]:
    return {
        "torch_dtype": dtype,
        "use_safetensors": True,
    }


def sync_device(device: str) -> None:
    if device == "mps":
        torch.mps.synchronize()


def clear_device_cache(device: str) -> None:
    gc.collect()
    if device == "mps":
        torch.mps.empty_cache()


def resize_to_canvas(image: Image.Image, width: int, height: int, mode: Literal["crop", "pad"]) -> Image.Image:
    image = ImageOps.exif_transpose(image).convert("RGB")
    target = (width, height)
    if mode == "crop":
        return ImageOps.fit(image, target, method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
    return ImageOps.pad(image, target, method=Image.Resampling.LANCZOS, color=(0, 0, 0), centering=(0.5, 0.5))


def normalize_depth_array(depth: np.ndarray) -> Image.Image:
    depth = depth.astype(np.float32)
    finite = np.isfinite(depth)
    if not finite.any():
        raise ValueError("Depth array does not contain any finite values")
    lo = float(np.min(depth[finite]))
    hi = float(np.max(depth[finite]))
    if hi - lo < 1e-6:
        normalized = np.zeros_like(depth, dtype=np.uint8)
    else:
        normalized = ((depth - lo) / (hi - lo) * 255.0).clip(0, 255).astype(np.uint8)
    return Image.fromarray(normalized, mode="L").convert("RGB")


def load_depth_from_manifest(path: Path, width: int, height: int, resize_mode: Literal["crop", "pad"]) -> Image.Image:
    suffix = path.suffix.lower()
    if suffix == ".npy":
        array = np.load(path)
        image = normalize_depth_array(array)
        return resize_to_canvas(image, width, height, resize_mode)

    image = Image.open(path)
    if image.mode not in ("RGB", "RGBA"):
        array = np.array(image)
        if array.ndim == 3:
            array = array[..., 0]
        image = normalize_depth_array(array)
    else:
        image = image.convert("RGB")
    return resize_to_canvas(image, width, height, resize_mode)


def estimate_depth_with_midas(reference_image: Image.Image, depth_device: str) -> Image.Image:
    from controlnet_aux import MidasDetector

    cache_key = ("midas", depth_device)
    detector = _DEPTH_MODEL_CACHE.get(cache_key)
    if detector is None:
        print(
            f"Loading MiDaS depth preprocessor on {depth_device} (first run may download weights from Hugging Face)...",
            flush=True,
        )
        detector = MidasDetector.from_pretrained(MODELS["controlnet_aux_repo"]).to(depth_device)
        _DEPTH_MODEL_CACHE[cache_key] = detector

    image_resolution = min(reference_image.size)
    depth_image = detector(
        reference_image,
        detect_resolution=image_resolution,
        image_resolution=image_resolution,
        output_type="pil",
        depth_and_normal=False,
    )
    return depth_image.convert("RGB")


def estimate_depth_with_dpt(reference_image: Image.Image, depth_device: str) -> Image.Image:
    from transformers import DPTForDepthEstimation, DPTImageProcessor

    cache_key = ("dpt", depth_device)
    processor, model = _DEPTH_MODEL_CACHE.get(cache_key, (None, None))
    if processor is None or model is None:
        print(
            f"Loading DPT depth model on {depth_device} (first run may download weights from Hugging Face)...",
            flush=True,
        )
        processor = DPTImageProcessor.from_pretrained(MODELS["dpt_depth_model"])
        model = DPTForDepthEstimation.from_pretrained(MODELS["dpt_depth_model"]).to(depth_device).eval()
        _DEPTH_MODEL_CACHE[cache_key] = (processor, model)

    inputs = processor(images=reference_image, return_tensors="pt")
    pixel_values = inputs.pixel_values.to(depth_device)

    with torch.inference_mode():
        predicted_depth = model(pixel_values).predicted_depth

    depth = torch.nn.functional.interpolate(
        predicted_depth.unsqueeze(1),
        size=(reference_image.height, reference_image.width),
        mode="bicubic",
        align_corners=False,
    )
    array = depth[0, 0].detach().cpu().numpy()
    return normalize_depth_array(array)


def build_depth_image(
    frame: FrameSpec,
    reference_image: Image.Image,
    depth_source: str,
    depth_device: str,
    width: int,
    height: int,
    resize_mode: Literal["crop", "pad"],
) -> tuple[Image.Image | None, str | None]:
    if depth_source == "manifest":
        if frame.depth_path is None:
            raise FileNotFoundError(
                f"Frame {frame.frame_id} does not provide depth_uri but --depth-source manifest was requested"
            )
        return (
            load_depth_from_manifest(frame.depth_path, width, height, resize_mode),
            f"manifest:{frame.depth_path.name}",
        )

    if depth_source == "auto":
        if frame.depth_path is not None:
            return (
                load_depth_from_manifest(frame.depth_path, width, height, resize_mode),
                f"manifest:{frame.depth_path.name}",
            )
        depth_source = "midas"

    if depth_source == "midas":
        return estimate_depth_with_midas(reference_image, depth_device), "estimated:midas"
    if depth_source == "dpt":
        return estimate_depth_with_dpt(reference_image, depth_device), "estimated:dpt"

    raise ValueError(f"Unsupported depth source: {depth_source}")


def parse_modes(value: str) -> tuple[str, ...]:
    modes = tuple(part.strip() for part in value.split(",") if part.strip())
    invalid = [mode for mode in modes if mode not in ALL_MODES]
    if invalid:
        raise ValueError(f"Unsupported mode(s): {', '.join(invalid)}")
    if not modes:
        raise ValueError("At least one mode must be selected")
    return modes


def load_room_bundle(bundle_dir: Path, max_cases: int | None = None) -> RoomBundle:
    manifest_path = bundle_dir / "manifest.json"
    cases_path = bundle_dir / "cases.json"

    if not manifest_path.exists():
        raise FileNotFoundError(f"Missing manifest: {manifest_path}")
    if not cases_path.exists():
        raise FileNotFoundError(f"Missing cases file: {cases_path}")

    manifest = json_load(manifest_path)
    cases_doc = json_load(cases_path)

    room_id = str(manifest.get("room_id") or bundle_dir.name)
    capture_id = str(manifest.get("capture_id") or f"{room_id}-capture")
    primary_frame_id = manifest.get("primary_frame_id")
    roomplan_raw_path = resolve_path(bundle_dir, manifest.get("roomplan_raw_uri"))

    warnings: list[str] = []
    frames: dict[str, FrameSpec] = {}
    for frame_doc in manifest.get("frames", []):
        frame_id = str(frame_doc["frame_id"])
        rgb_path = resolve_path(bundle_dir, frame_doc.get("rgb_uri"))
        if rgb_path is None or not rgb_path.exists():
            raise FileNotFoundError(f"Room {room_id} frame {frame_id} is missing rgb_uri: {rgb_path}")

        depth_path = resolve_path(bundle_dir, frame_doc.get("depth_uri"))
        pose_path = resolve_path(bundle_dir, frame_doc.get("pose_uri"))
        intrinsics_path = resolve_path(bundle_dir, frame_doc.get("intrinsics_uri"))

        if depth_path is not None and not depth_path.exists():
            raise FileNotFoundError(f"Room {room_id} frame {frame_id} references missing depth file: {depth_path}")
        if pose_path is None:
            warnings.append(f"{room_id}/{frame_id}: pose_uri missing (acceptable for Phase 0, but preserve it when possible)")
        elif not pose_path.exists():
            raise FileNotFoundError(f"Room {room_id} frame {frame_id} references missing pose file: {pose_path}")
        if intrinsics_path is None:
            warnings.append(
                f"{room_id}/{frame_id}: intrinsics_uri missing (acceptable for Phase 0, but preserve it when possible)"
            )
        elif not intrinsics_path.exists():
            raise FileNotFoundError(
                f"Room {room_id} frame {frame_id} references missing intrinsics file: {intrinsics_path}"
            )

        frames[frame_id] = FrameSpec(
            frame_id=frame_id,
            rgb_path=rgb_path,
            depth_path=depth_path,
            pose_path=pose_path,
            intrinsics_path=intrinsics_path,
            tags=tuple(frame_doc.get("tags") or ()),
        )

    if not frames:
        raise ValueError(f"Room {room_id} manifest does not define any frames")

    if primary_frame_id is not None and primary_frame_id not in frames:
        raise ValueError(f"Room {room_id} primary_frame_id={primary_frame_id!r} does not exist in frames[]")

    cases: list[CaseSpec] = []
    for case_doc in cases_doc.get("cases", []):
        case_id = str(case_doc["case_id"])
        reference_frame_id = case_doc.get("reference_frame_id") or primary_frame_id
        if reference_frame_id is not None and reference_frame_id not in frames:
            raise ValueError(
                f"Room {room_id} case {case_id} references unknown frame_id={reference_frame_id!r}"
            )
        prompt = str(case_doc.get("prompt") or "").strip()
        if not prompt:
            raise ValueError(f"Room {room_id} case {case_id} is missing a non-empty prompt")

        cases.append(
            CaseSpec(
                case_id=case_id,
                reference_frame_id=reference_frame_id,
                prompt=prompt,
                negative_prompt=case_doc.get("negative_prompt"),
                tags=tuple(case_doc.get("tags") or ()),
            )
        )

    if not cases:
        raise ValueError(f"Room {room_id} cases.json does not define any cases")
    if max_cases is not None:
        cases = cases[:max_cases]

    return RoomBundle(
        room_id=room_id,
        capture_id=capture_id,
        bundle_dir=bundle_dir,
        primary_frame_id=primary_frame_id,
        roomplan_raw_path=roomplan_raw_path,
        frames=frames,
        cases=tuple(cases),
        default_negative_prompt=cases_doc.get("default_negative_prompt"),
        warnings=tuple(warnings),
    )


def load_room_bundles(rooms_dir: Path, selected_room_ids: set[str], max_cases: int | None) -> tuple[RoomBundle, ...]:
    if not rooms_dir.exists():
        raise FileNotFoundError(f"Rooms directory does not exist: {rooms_dir}")

    bundles: list[RoomBundle] = []
    for child in sorted(rooms_dir.iterdir()):
        if not child.is_dir():
            continue
        if selected_room_ids and child.name not in selected_room_ids:
            continue
        manifest_path = child / "manifest.json"
        if not manifest_path.exists():
            continue
        bundles.append(load_room_bundle(child, max_cases=max_cases))

    if not bundles:
        if selected_room_ids:
            wanted = ", ".join(sorted(selected_room_ids))
            raise FileNotFoundError(f"No room bundles found for --room {wanted} under {rooms_dir}")
        raise FileNotFoundError(
            f"No room bundles found under {rooms_dir}. Copy the templates from experiments/phase0/templates/."
        )
    return tuple(bundles)


def build_case_assets(
    bundle: RoomBundle,
    case: CaseSpec,
    output_dir: Path,
    width: int,
    height: int,
    resize_mode: Literal["crop", "pad"],
    depth_source: str,
    depth_device: str,
    needs_depth: bool,
) -> CaseAssets:
    reference_frame_id = case.reference_frame_id or bundle.primary_frame_id or next(iter(bundle.frames))
    frame = bundle.frames[reference_frame_id]

    print(
        f"Preparing assets for {bundle.room_id}/{case.case_id} using frame {reference_frame_id}...",
        flush=True,
    )

    reference_image = resize_to_canvas(Image.open(frame.rgb_path), width, height, resize_mode)
    depth_image: Image.Image | None = None
    resolved_depth_source: str | None = None
    if needs_depth:
        print(
            f"  Resolving depth image via {depth_source} for {bundle.room_id}/{case.case_id}...",
            flush=True,
        )
        depth_image, resolved_depth_source = build_depth_image(
            frame=frame,
            reference_image=reference_image,
            depth_source=depth_source,
            depth_device=depth_device,
            width=width,
            height=height,
            resize_mode=resize_mode,
        )

    output_dir.mkdir(parents=True, exist_ok=True)
    reference_image.save(output_dir / "input_reference.png")
    if depth_image is not None:
        depth_image.save(output_dir / "input_depth.png")

    return CaseAssets(
        reference_image=reference_image,
        reference_frame_id=reference_frame_id,
        reference_source_path=frame.rgb_path,
        depth_image=depth_image,
        depth_source=resolved_depth_source,
        output_dir=output_dir,
    )


def make_blind_id(run_id: str, room_id: str, case_id: str, mode: str, sample_index: int, seed: int) -> str:
    digest = hashlib.sha1(
        f"{run_id}|{room_id}|{case_id}|{mode}|{sample_index}|{seed}".encode("utf-8")
    ).hexdigest()
    return digest[:12]


def load_ip_adapter_weight_name(kind: str) -> str:
    if kind == "plus":
        return MODELS["ip_adapter_plus_weight"]
    return MODELS["ip_adapter_base_weight"]


def load_ip_adapter_image_encoder(kind: str, dtype: torch.dtype) -> Any | None:
    if kind != "plus":
        return None
    from transformers import CLIPVisionModelWithProjection

    return CLIPVisionModelWithProjection.from_pretrained(
        MODELS["ip_adapter_repo"],
        subfolder=MODELS["ip_adapter_plus_encoder_subfolder"],
        torch_dtype=dtype,
    )


def apply_runtime_options(pipe: Any, args: argparse.Namespace) -> Any:
    if args.attention_slicing:
        pipe.enable_attention_slicing()
    if args.vae_slicing:
        pipe.enable_vae_slicing()
    pipe.set_progress_bar_config(disable=False)
    return pipe


def load_base_pipe(device: str, dtype: torch.dtype, args: argparse.Namespace) -> Any:
    from diffusers import AutoencoderKL, StableDiffusionXLPipeline

    vae = AutoencoderKL.from_pretrained(MODELS["vae"], **model_kwargs_without_variant(dtype))
    image_encoder = load_ip_adapter_image_encoder(args.ip_adapter_kind, dtype)

    kwargs = model_kwargs(dtype)
    kwargs["vae"] = vae
    if image_encoder is not None:
        kwargs["image_encoder"] = image_encoder

    pipe = StableDiffusionXLPipeline.from_pretrained(MODELS["base"], **kwargs).to(device)
    return apply_runtime_options(pipe, args)


def load_control_pipe(device: str, dtype: torch.dtype, args: argparse.Namespace) -> Any:
    from diffusers import AutoencoderKL, ControlNetModel, StableDiffusionXLControlNetPipeline

    vae = AutoencoderKL.from_pretrained(MODELS["vae"], **model_kwargs_without_variant(dtype))
    image_encoder = load_ip_adapter_image_encoder(args.ip_adapter_kind, dtype)
    controlnet = ControlNetModel.from_pretrained(MODELS["controlnet_depth_small"], **model_kwargs(dtype))

    kwargs = model_kwargs(dtype)
    kwargs["vae"] = vae
    kwargs["controlnet"] = controlnet
    if image_encoder is not None:
        kwargs["image_encoder"] = image_encoder

    pipe = StableDiffusionXLControlNetPipeline.from_pretrained(MODELS["base"], **kwargs).to(device)
    return apply_runtime_options(pipe, args)


def load_ip_adapter_into(pipe: Any, device: str, args: argparse.Namespace) -> Any:
    pipe.load_ip_adapter(
        MODELS["ip_adapter_repo"],
        subfolder="sdxl_models",
        weight_name=load_ip_adapter_weight_name(args.ip_adapter_kind),
    )
    pipe.set_ip_adapter_scale(args.ip_adapter_scale)
    pipe.to(device)
    return apply_runtime_options(pipe, args)


def warmup_pipeline(pipe: Any, mode: str, args: argparse.Namespace, case_assets: dict[tuple[str, str], CaseAssets]) -> None:
    if not args.warmup:
        return

    first_assets = next(iter(case_assets.values()))
    kwargs: dict[str, Any] = {
        "prompt": "warmup",
        "negative_prompt": DEFAULT_NEGATIVE_PROMPT,
        "width": args.width,
        "height": args.height,
        "num_inference_steps": 1,
        "guidance_scale": 1.0,
    }
    if mode in ("depth_only", "ref_depth"):
        kwargs["image"] = first_assets.depth_image
        kwargs["controlnet_conditioning_scale"] = min(args.controlnet_scale, 0.2)
    if mode in ("ref_only", "ref_depth"):
        kwargs["ip_adapter_image"] = first_assets.reference_image

    with torch.inference_mode():
        _ = pipe(**kwargs).images[0]


def make_latents(width: int, height: int, dtype: torch.dtype, device: str, seed: int) -> torch.Tensor:
    from diffusers.utils.torch_utils import randn_tensor

    shape = (1, 4, height // 8, width // 8)
    generator = torch.Generator(device="cpu").manual_seed(seed)
    return randn_tensor(shape, generator=generator, device=device, dtype=dtype)


def run_job(
    *,
    pipe: Any,
    mode: str,
    device: str,
    args: argparse.Namespace,
    job: JobSpec,
    assets: CaseAssets,
    latents: torch.Tensor,
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "prompt": job.prompt,
        "negative_prompt": job.negative_prompt,
        "width": args.width,
        "height": args.height,
        "num_inference_steps": args.num_steps,
        "guidance_scale": args.guidance_scale,
        "latents": latents.clone(),
        "output_type": "pil",
    }

    if mode in ("depth_only", "ref_depth"):
        kwargs["image"] = assets.depth_image
        kwargs["controlnet_conditioning_scale"] = args.controlnet_scale
    if mode in ("ref_only", "ref_depth"):
        kwargs["ip_adapter_image"] = assets.reference_image

    output_path = job.output_dir / f"{job.blind_id}.png"
    sync_device(device)
    started = time.perf_counter()
    with torch.inference_mode():
        output_image = pipe(**kwargs).images[0]
    sync_device(device)
    elapsed = time.perf_counter() - started
    output_image.save(output_path)

    return {
        "blind_id": job.blind_id,
        "room_id": job.room_id,
        "case_id": job.case_id,
        "reference_frame_id": job.reference_frame_id,
        "mode": mode,
        "seed": job.seed,
        "sample_index": job.sample_index,
        "prompt": job.prompt,
        "negative_prompt": job.negative_prompt,
        "reference_source_path": str(job.reference_source_path),
        "depth_source": job.depth_source,
        "output_path": str(output_path),
        "elapsed_seconds": round(elapsed, 4),
        "width": args.width,
        "height": args.height,
        "num_steps": args.num_steps,
        "guidance_scale": args.guidance_scale,
        "controlnet_scale": args.controlnet_scale if mode in ("depth_only", "ref_depth") else None,
        "ip_adapter_scale": args.ip_adapter_scale if mode in ("ref_only", "ref_depth") else None,
        "device": device,
        "dtype": str(determine_dtype(device)),
        "base_model": MODELS["base"],
        "vae_model": MODELS["vae"],
        "controlnet_model": MODELS["controlnet_depth_small"] if mode in ("depth_only", "ref_depth") else None,
        "ip_adapter_repo": MODELS["ip_adapter_repo"] if mode in ("ref_only", "ref_depth") else None,
        "ip_adapter_weight": load_ip_adapter_weight_name(args.ip_adapter_kind)
        if mode in ("ref_only", "ref_depth")
        else None,
        "pipeline_class": pipe.__class__.__name__,
    }


def build_case_asset_map(
    bundles: tuple[RoomBundle, ...],
    run_dir: Path,
    args: argparse.Namespace,
    needs_depth: bool,
) -> dict[tuple[str, str], CaseAssets]:
    asset_map: dict[tuple[str, str], CaseAssets] = {}
    for bundle in bundles:
        room_slug = slugify(bundle.room_id)
        for case in bundle.cases:
            case_slug = slugify(case.case_id)
            output_dir = run_dir / room_slug / case_slug
            asset_map[(bundle.room_id, case.case_id)] = build_case_assets(
                bundle=bundle,
                case=case,
                output_dir=output_dir,
                width=args.width,
                height=args.height,
                resize_mode=args.resize_mode,
                depth_source=args.depth_source,
                depth_device=args.depth_device,
                needs_depth=needs_depth,
            )
    return asset_map


def build_jobs(
    bundles: tuple[RoomBundle, ...],
    asset_map: dict[tuple[str, str], CaseAssets],
    modes: tuple[str, ...],
    run_id: str,
    args: argparse.Namespace,
) -> list[JobSpec]:
    jobs: list[JobSpec] = []
    for bundle in bundles:
        for case in bundle.cases:
            assets = asset_map[(bundle.room_id, case.case_id)]
            negative_prompt = case.negative_prompt or bundle.default_negative_prompt or DEFAULT_NEGATIVE_PROMPT
            for sample_index in range(args.samples):
                seed = args.seed_base + sample_index
                for mode in modes:
                    blind_id = make_blind_id(run_id, bundle.room_id, case.case_id, mode, sample_index, seed)
                    jobs.append(
                        JobSpec(
                            room_id=bundle.room_id,
                            case_id=case.case_id,
                            reference_frame_id=assets.reference_frame_id,
                            mode=mode,
                            sample_index=sample_index,
                            seed=seed,
                            prompt=case.prompt,
                            negative_prompt=negative_prompt,
                            output_dir=assets.output_dir,
                            blind_id=blind_id,
                            reference_source_path=assets.reference_source_path,
                            depth_source=assets.depth_source,
                        )
                    )
    return jobs


def write_json(path: Path, payload: Any) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=False), encoding="utf-8")


def write_metadata_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, sort_keys=True) + "\n")


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def print_plan(bundles: tuple[RoomBundle, ...], job_count: int, args: argparse.Namespace) -> None:
    print(f"Phase 0 plan: {len(bundles)} room(s), {job_count} job(s)")
    for bundle in bundles:
        print(f"- room={bundle.room_id} capture={bundle.capture_id} frames={len(bundle.frames)} cases={len(bundle.cases)}")
        for warning in bundle.warnings:
            print(f"  warning: {warning}")
        for case in bundle.cases:
            frame_id = case.reference_frame_id or bundle.primary_frame_id or next(iter(bundle.frames))
            print(f"  case={case.case_id} frame={frame_id}")
    print(
        f"modes={','.join(parse_modes(args.modes))} device={determine_device(args.device)} "
        f"size={args.width}x{args.height} samples={args.samples} depth_source={args.depth_source}"
    )


def main() -> int:
    args = parse_args()
    if args.width % 8 != 0 or args.height % 8 != 0:
        raise ValueError("--width and --height must both be divisible by 8 for SDXL latents")
    if args.depth_device == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("--depth-device mps requested but torch.backends.mps.is_available() is false")
    modes = parse_modes(args.modes)
    bundles = load_room_bundles(args.rooms_dir, set(args.rooms), args.max_cases)

    run_id = time.strftime("%Y%m%d-%H%M%S")
    run_dir = args.results_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    job_count = sum(len(bundle.cases) for bundle in bundles) * args.samples * len(modes)
    print_plan(bundles, job_count, args)

    config = {
        "run_id": run_id,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "modes": list(modes),
        "samples": args.samples,
        "seed_base": args.seed_base,
        "width": args.width,
        "height": args.height,
        "resize_mode": args.resize_mode,
        "num_steps": args.num_steps,
        "guidance_scale": args.guidance_scale,
        "controlnet_scale": args.controlnet_scale,
        "ip_adapter_scale": args.ip_adapter_scale,
        "ip_adapter_kind": args.ip_adapter_kind,
        "depth_source": args.depth_source,
        "depth_device": args.depth_device,
        "device": determine_device(args.device),
        "models": MODELS,
        "rooms_dir": str(args.rooms_dir),
        "results_dir": str(args.results_dir),
    }
    write_json(run_dir / "run_config.json", config)

    if args.dry_run:
        print(f"Dry run complete. Config written to {run_dir / 'run_config.json'}")
        return 0

    needs_depth = any(mode in ("depth_only", "ref_depth") for mode in modes)
    print("\nPreparing per-case input assets...", flush=True)
    asset_map = build_case_asset_map(bundles, run_dir, args, needs_depth=needs_depth)
    jobs = build_jobs(bundles, asset_map, modes, run_id, args)

    device = determine_device(args.device)
    dtype = determine_dtype(device)
    latents_by_seed = {args.seed_base + i: make_latents(args.width, args.height, dtype, device, args.seed_base + i) for i in range(args.samples)}

    rendered_rows: list[dict[str, Any]] = []
    total_jobs = len(jobs)
    completed = 0

    jobs_by_mode: dict[str, list[JobSpec]] = {mode: [job for job in jobs if job.mode == mode] for mode in modes}

    if jobs_by_mode.get("prompt_only") or jobs_by_mode.get("ref_only"):
        print("\nLoading SDXL base pipeline...")
        base_pipe = load_base_pipe(device, dtype, args)
        if jobs_by_mode.get("prompt_only"):
            warmup_pipeline(base_pipe, "prompt_only", args, asset_map)
            for job in jobs_by_mode["prompt_only"]:
                output_path = job.output_dir / f"{job.blind_id}.png"
                if args.skip_existing and output_path.exists():
                    completed += 1
                    continue
                completed += 1
                print(f"[{completed}/{total_jobs}] prompt_only {job.room_id}/{job.case_id} seed={job.seed} -> {job.blind_id}")
                row = run_job(
                    pipe=base_pipe,
                    mode="prompt_only",
                    device=device,
                    args=args,
                    job=job,
                    assets=asset_map[(job.room_id, job.case_id)],
                    latents=latents_by_seed[job.seed],
                )
                rendered_rows.append(row)

        if jobs_by_mode.get("ref_only"):
            print("Loading IP-Adapter into SDXL base pipeline...")
            base_pipe = load_ip_adapter_into(base_pipe, device, args)
            warmup_pipeline(base_pipe, "ref_only", args, asset_map)
            for job in jobs_by_mode["ref_only"]:
                output_path = job.output_dir / f"{job.blind_id}.png"
                if args.skip_existing and output_path.exists():
                    completed += 1
                    continue
                completed += 1
                print(f"[{completed}/{total_jobs}] ref_only {job.room_id}/{job.case_id} seed={job.seed} -> {job.blind_id}")
                row = run_job(
                    pipe=base_pipe,
                    mode="ref_only",
                    device=device,
                    args=args,
                    job=job,
                    assets=asset_map[(job.room_id, job.case_id)],
                    latents=latents_by_seed[job.seed],
                )
                rendered_rows.append(row)

        del base_pipe
        clear_device_cache(device)

    if jobs_by_mode.get("depth_only") or jobs_by_mode.get("ref_depth"):
        print("\nLoading SDXL depth ControlNet pipeline...")
        control_pipe = load_control_pipe(device, dtype, args)
        if jobs_by_mode.get("depth_only"):
            warmup_pipeline(control_pipe, "depth_only", args, asset_map)
            for job in jobs_by_mode["depth_only"]:
                output_path = job.output_dir / f"{job.blind_id}.png"
                if args.skip_existing and output_path.exists():
                    completed += 1
                    continue
                completed += 1
                print(f"[{completed}/{total_jobs}] depth_only {job.room_id}/{job.case_id} seed={job.seed} -> {job.blind_id}")
                row = run_job(
                    pipe=control_pipe,
                    mode="depth_only",
                    device=device,
                    args=args,
                    job=job,
                    assets=asset_map[(job.room_id, job.case_id)],
                    latents=latents_by_seed[job.seed],
                )
                rendered_rows.append(row)

        if jobs_by_mode.get("ref_depth"):
            print("Loading IP-Adapter into SDXL depth ControlNet pipeline...")
            control_pipe = load_ip_adapter_into(control_pipe, device, args)
            warmup_pipeline(control_pipe, "ref_depth", args, asset_map)
            for job in jobs_by_mode["ref_depth"]:
                output_path = job.output_dir / f"{job.blind_id}.png"
                if args.skip_existing and output_path.exists():
                    completed += 1
                    continue
                completed += 1
                print(f"[{completed}/{total_jobs}] ref_depth {job.room_id}/{job.case_id} seed={job.seed} -> {job.blind_id}")
                row = run_job(
                    pipe=control_pipe,
                    mode="ref_depth",
                    device=device,
                    args=args,
                    job=job,
                    assets=asset_map[(job.room_id, job.case_id)],
                    latents=latents_by_seed[job.seed],
                )
                rendered_rows.append(row)

        del control_pipe
        clear_device_cache(device)

    if not rendered_rows and not args.skip_existing:
        print("No images were rendered.", file=sys.stderr)
        return 1

    rendered_rows.sort(key=lambda row: (row["room_id"], row["case_id"], row["sample_index"], row["mode"]))
    write_metadata_jsonl(run_dir / "metadata.jsonl", rendered_rows)

    condition_rows = [
        {
            "blind_id": row["blind_id"],
            "room_id": row["room_id"],
            "case_id": row["case_id"],
            "mode": row["mode"],
            "seed": row["seed"],
            "sample_index": row["sample_index"],
            "output_path": row["output_path"],
            "reference_frame_id": row["reference_frame_id"],
            "depth_source": row["depth_source"] or "",
        }
        for row in rendered_rows
    ]
    write_csv(
        run_dir / "condition_map.csv",
        condition_rows,
        [
            "blind_id",
            "room_id",
            "case_id",
            "mode",
            "seed",
            "sample_index",
            "output_path",
            "reference_frame_id",
            "depth_source",
        ],
    )

    blind_scoring_rows = [
        {
            "blind_id": row["blind_id"],
            "room_id": row["room_id"],
            "case_id": row["case_id"],
            "sample_index": row["sample_index"],
            "output_path": row["output_path"],
            "edit_faithfulness": "",
            "room_preservation": "",
            "structural_realism": "",
            "artifact_severity": "",
            "notes": "",
        }
        for row in rendered_rows
    ]
    write_csv(
        run_dir / "blind_scoring_sheet.csv",
        blind_scoring_rows,
        [
            "blind_id",
            "room_id",
            "case_id",
            "sample_index",
            "output_path",
            "edit_faithfulness",
            "room_preservation",
            "structural_realism",
            "artifact_severity",
            "notes",
        ],
    )

    print(f"\nDone. Results written to {run_dir}")
    print(f"- metadata: {run_dir / 'metadata.jsonl'}")
    print(f"- blind scoring sheet: {run_dir / 'blind_scoring_sheet.csv'}")
    print(f"- condition map: {run_dir / 'condition_map.csv'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
