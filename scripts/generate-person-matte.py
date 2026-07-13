#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "numpy>=1.26,<3",
#   "onnxruntime>=1.19,<2",
# ]
# ///
"""Generate a temporally coherent, straight-alpha person cutout with RVM.

This is an offline asset generator, not a live VEAN action. It decodes a
frame-exact source range through ffmpeg, carries Robust Video Matting's four
recurrent states across every frame, and writes an edit-quality ProRes 4444
cutout. An optional VP9-with-alpha proxy is suitable for VEAN's browser viewer.

The selected official RVM ONNX model is downloaded into a caller-selected cache
and SHA-256 verified. ResNet50 is the quality-first default; MobileNetV3 remains
available for faster iteration. No model code or weights are committed to vean.

Example:
  uv run scripts/generate-person-matte.py input.mov cutout.mov \
    --start-frame 0 --end-frame 332 --downsample-ratio 0.375 \
    --model-backbone resnet50 --browser-output cutout.webm
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import BinaryIO, NoReturn

import numpy as np
import onnxruntime as ort


MODEL_SPECS = {
    "resnet50": {
        "filename": "rvm_resnet50_fp32.onnx",
        "url": (
            "https://github.com/PeterL1n/RobustVideoMatting/releases/download/"
            "v1.0.0/rvm_resnet50_fp32.onnx"
        ),
        "sha256": "25db300fcb6ee27f941a1b52c97856e8d1f13c7f35817f81a612f89af0e8a85c",
    },
    "mobilenetv3": {
        "filename": "rvm_mobilenetv3_fp32.onnx",
        "url": (
            "https://github.com/PeterL1n/RobustVideoMatting/releases/download/"
            "v1.0.0/rvm_mobilenetv3_fp32.onnx"
        ),
        "sha256": "88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828",
    },
}


@dataclass(frozen=True)
class VideoInfo:
    width: int
    height: int
    fps: Fraction
    frame_count: int | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a temporal RVM person matte as straight-alpha ProRes 4444.",
    )
    parser.add_argument("input", type=Path, help="Source video")
    parser.add_argument("output", type=Path, help="Alpha-capable .mov output")
    parser.add_argument(
        "--start-frame", type=int, default=0, help="Inclusive source frame"
    )
    parser.add_argument(
        "--end-frame",
        type=int,
        help="Inclusive source frame; defaults to the final probed frame",
    )
    parser.add_argument(
        "--downsample-ratio",
        type=float,
        help="RVM stage-1 scale; auto keeps the long edge near 480 px",
    )
    parser.add_argument(
        "--temporal-smoothing",
        type=float,
        default=0.12,
        help=(
            "0..1 confidence-gated edge stabilization after RVM recurrence "
            "(default: 0.12)"
        ),
    )
    parser.add_argument(
        "--alpha-black-point",
        type=float,
        default=0.02,
        help="Map alpha at/below this confidence to transparent (default: 0.02)",
    )
    parser.add_argument(
        "--alpha-white-point",
        type=float,
        default=0.98,
        help="Map alpha at/above this confidence to opaque (default: 0.98)",
    )
    parser.add_argument(
        "--alpha-gamma",
        type=float,
        default=1.0,
        help="Shape the remapped soft edge; >1 tightens it (default: 1.0)",
    )
    parser.add_argument(
        "--browser-output",
        type=Path,
        help="Optional VP9 yuva420p WebM proxy for the browser viewer",
    )
    parser.add_argument(
        "--model-cache",
        type=Path,
        default=Path.home() / ".cache" / "vean" / "models",
        help="Downloaded-model cache (default: ~/.cache/vean/models)",
    )
    parser.add_argument(
        "--model-backbone",
        choices=tuple(MODEL_SPECS),
        default="resnet50",
        help="RVM backbone; ResNet50 is slower but cleaner at difficult edges",
    )
    parser.add_argument(
        "--provider",
        choices=("cpu", "coreml"),
        default="cpu",
        help="ONNX execution provider (default: cpu, the official tested path)",
    )
    parser.add_argument(
        "--rgb-source",
        choices=("foreground", "original"),
        default="foreground",
        help="Use RVM's decontaminated foreground or original source RGB",
    )
    parser.add_argument(
        "--person-roi",
        metavar="X,Y,W,H",
        help=(
            "Optional frame-space garbage matte: run RVM only inside this rectangle "
            "and place its output back into the full frame. Use it when another "
            "person-like object is isolated by the model."
        ),
    )
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--force", action="store_true", help="Replace existing outputs")
    return parser.parse_args()


def fail(message: str) -> NoReturn:
    raise SystemExit(f"error: {message}")


def require_executable(name: str) -> str:
    resolved = shutil.which(name)
    if not resolved:
        fail(f"required executable not found: {name}")
    return resolved


def probe_video(ffprobe: str, source: Path) -> VideoInfo:
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate,nb_frames",
            "-of",
            "json",
            str(source),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    streams = json.loads(result.stdout).get("streams", [])
    if len(streams) != 1:
        fail(f"expected exactly one primary video stream in {source}")
    stream = streams[0]
    fps = Fraction(stream["r_frame_rate"])
    if fps <= 0:
        fail(f"invalid source frame rate: {stream['r_frame_rate']}")
    raw_count = stream.get("nb_frames")
    frame_count = int(raw_count) if raw_count not in (None, "N/A") else None
    return VideoInfo(int(stream["width"]), int(stream["height"]), fps, frame_count)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_model(cache: Path, filename: str, url: str, expected_sha256: str) -> Path:
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / filename
    if destination.exists() and sha256(destination) == expected_sha256:
        return destination
    if destination.exists():
        destination.unlink()

    temporary = destination.with_suffix(f".download-{os.getpid()}")
    print(f"downloading official RVM model -> {destination}", file=sys.stderr)
    try:
        request = urllib.request.Request(
            url, headers={"User-Agent": "vean-rvm-matte/1"}
        )
        with (
            urllib.request.urlopen(request) as response,
            temporary.open("wb") as output,
        ):
            shutil.copyfileobj(response, output)
        actual = sha256(temporary)
        if actual != expected_sha256:
            fail(
                f"RVM model checksum mismatch: expected {expected_sha256}, got {actual}"
            )
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def read_exact(pipe: BinaryIO, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = pipe.read(remaining)
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def parse_person_roi(
    raw: str | None, info: VideoInfo
) -> tuple[int, int, int, int] | None:
    if raw is None:
        return None
    try:
        x, y, width, height = (int(part.strip()) for part in raw.split(","))
    except (TypeError, ValueError):
        fail("--person-roi must be four comma-separated integers: X,Y,W,H")
    if x < 0 or y < 0 or width <= 0 or height <= 0:
        fail("--person-roi requires X/Y >= 0 and W/H > 0")
    if x + width > info.width or y + height > info.height:
        fail(f"--person-roi {raw} exceeds the {info.width}x{info.height} frame bounds")
    return x, y, width, height


def decoder_command(
    ffmpeg: str,
    source: Path,
    info: VideoInfo,
    start_frame: int,
    end_frame: int,
) -> list[str]:
    trim = (
        f"trim=start_frame={start_frame}:end_frame={end_frame + 1},setpts=PTS-STARTPTS"
    )
    return [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-vf",
        trim,
        "-an",
        "-vsync",
        "0",
        "-frames:v",
        str(end_frame - start_frame + 1),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "pipe:1",
    ]


def encoder_command(ffmpeg: str, output: Path, info: VideoInfo) -> list[str]:
    return [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgba",
        "-video_size",
        f"{info.width}x{info.height}",
        "-framerate",
        f"{info.fps.numerator}/{info.fps.denominator}",
        "-i",
        "pipe:0",
        "-an",
        "-c:v",
        "prores_ks",
        "-profile:v",
        "4444",
        "-pix_fmt",
        "yuva444p10le",
        "-alpha_bits",
        "16",
        "-vendor",
        "apl0",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        str(output),
    ]


def stabilize_alpha(
    alpha: np.ndarray, previous: np.ndarray | None, amount: float
) -> np.ndarray:
    """Damp only uncertain, stationary edge pixels; do not trail moving hands."""
    if previous is None or amount == 0:
        return alpha
    delta = np.abs(alpha - previous)
    uncertainty = 4.0 * alpha * (1.0 - alpha)
    agreement = np.clip(1.0 - delta / 0.20, 0.0, 1.0)
    weight = amount * uncertainty * agreement
    return alpha * (1.0 - weight) + previous * weight


def remap_alpha(
    alpha: np.ndarray, black_point: float, white_point: float, gamma: float
) -> np.ndarray:
    normalized = np.clip((alpha - black_point) / (white_point - black_point), 0.0, 1.0)
    return np.power(normalized, gamma)


def create_session(model: Path, provider: str) -> ort.InferenceSession:
    available = ort.get_available_providers()
    if provider == "coreml":
        if "CoreMLExecutionProvider" not in available:
            fail(
                f"CoreMLExecutionProvider unavailable; installed providers: {available}"
            )
        providers: list[str | tuple[str, dict[str, str]]] = [
            (
                "CoreMLExecutionProvider",
                {
                    "ModelFormat": "MLProgram",
                    "MLComputeUnits": "ALL",
                    "RequireStaticInputShapes": "0",
                },
            ),
            "CPUExecutionProvider",
        ]
    else:
        providers = ["CPUExecutionProvider"]
    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.intra_op_num_threads = max(1, (os.cpu_count() or 4) - 1)
    return ort.InferenceSession(str(model), sess_options=options, providers=providers)


def render_matte(
    session: ort.InferenceSession,
    decoder: subprocess.Popen[bytes],
    encoder: subprocess.Popen[bytes],
    info: VideoInfo,
    count: int,
    ratio: float,
    smoothing: float,
    alpha_black_point: float,
    alpha_white_point: float,
    alpha_gamma: float,
    rgb_source: str,
    person_roi: tuple[int, int, int, int] | None,
) -> None:
    if decoder.stdout is None or encoder.stdin is None:
        fail("internal pipe setup failed")
    frame_bytes = info.width * info.height * 3
    recurrent = [np.zeros((1, 1, 1, 1), dtype=np.float32) for _ in range(4)]
    ratio_tensor = np.asarray([ratio], dtype=np.float32)
    previous_alpha: np.ndarray | None = None
    started = time.monotonic()

    for index in range(count):
        raw = read_exact(decoder.stdout, frame_bytes)
        if len(raw) != frame_bytes:
            fail(
                f"source decoder ended at output frame {index}; expected {count} frames"
            )
        rgb = np.frombuffer(raw, dtype=np.uint8).reshape(info.height, info.width, 3)
        if person_roi is None:
            roi_x, roi_y, roi_width, roi_height = 0, 0, info.width, info.height
        else:
            roi_x, roi_y, roi_width, roi_height = person_roi
        roi_rgb = rgb[roi_y : roi_y + roi_height, roi_x : roi_x + roi_width]
        source = (
            np.ascontiguousarray(roi_rgb.transpose(2, 0, 1)[None], dtype=np.float32)
            / 255.0
        )
        foreground, alpha, *recurrent = session.run(
            None,
            {
                "src": source,
                "r1i": recurrent[0],
                "r2i": recurrent[1],
                "r3i": recurrent[2],
                "r4i": recurrent[3],
                "downsample_ratio": ratio_tensor,
            },
        )
        roi_matte = np.clip(alpha[0, 0], 0.0, 1.0)
        roi_matte = remap_alpha(
            roi_matte,
            alpha_black_point,
            alpha_white_point,
            alpha_gamma,
        )
        roi_matte = stabilize_alpha(roi_matte, previous_alpha, smoothing)
        previous_alpha = roi_matte

        if rgb_source == "foreground":
            roi_color = np.clip(foreground[0].transpose(1, 2, 0), 0.0, 1.0)
            roi_color_u8 = np.rint(roi_color * 255.0).astype(np.uint8)
        else:
            roi_color_u8 = roi_rgb
        roi_alpha_u8 = np.rint(roi_matte * 255.0).astype(np.uint8)
        color_u8 = np.zeros((info.height, info.width, 3), dtype=np.uint8)
        alpha_u8 = np.zeros((info.height, info.width), dtype=np.uint8)
        color_u8[roi_y : roi_y + roi_height, roi_x : roi_x + roi_width] = roi_color_u8
        alpha_u8[roi_y : roi_y + roi_height, roi_x : roi_x + roi_width] = roi_alpha_u8
        # Fully transparent RGB is irrelevant to compositing and zeroing it keeps
        # encoder noise from turning into colored fringes after proxy scaling.
        color_u8 = color_u8.copy()
        color_u8[alpha_u8 == 0] = 0
        rgba = np.empty((info.height, info.width, 4), dtype=np.uint8)
        rgba[:, :, :3] = color_u8
        rgba[:, :, 3] = alpha_u8
        try:
            encoder.stdin.write(rgba.tobytes())
        except BrokenPipeError:
            fail("ProRes encoder terminated before inference completed")

        if index == 0 or (index + 1) % 15 == 0 or index + 1 == count:
            elapsed = max(time.monotonic() - started, 0.001)
            rate = (index + 1) / elapsed
            print(
                f"\rmatting {index + 1:4d}/{count} frames ({rate:5.1f} fps)",
                end="",
                file=sys.stderr,
                flush=True,
            )
    print(file=sys.stderr)
    encoder.stdin.close()


def build_browser_proxy(ffmpeg: str, source: Path, output: Path) -> None:
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            str(source),
            "-map",
            "0:v:0",
            "-an",
            "-c:v",
            "libvpx-vp9",
            "-pix_fmt",
            "yuva420p",
            "-auto-alt-ref",
            "0",
            "-row-mt",
            "1",
            "-deadline",
            "good",
            "-cpu-used",
            "3",
            "-crf",
            "18",
            "-b:v",
            "0",
            "-metadata:s:v:0",
            "alpha_mode=1",
            str(output),
        ],
        check=True,
    )


def probe_output(ffprobe: str, path: Path) -> dict[str, object]:
    result = subprocess.run(
        [
            ffprobe,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,profile,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_frames,duration:stream_tags=alpha_mode",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    streams = json.loads(result.stdout).get("streams", [])
    if len(streams) != 1:
        fail(f"could not verify output stream: {path}")
    return streams[0]


def validate_output(
    path: Path, probe: dict[str, object], info: VideoInfo, count: int
) -> None:
    if (
        int(probe.get("width", 0)) != info.width
        or int(probe.get("height", 0)) != info.height
    ):
        fail(f"output geometry mismatch for {path}: {probe}")
    frames = probe.get("nb_frames")
    if frames not in (None, "N/A") and int(str(frames)) != count:
        fail(f"output frame-count mismatch for {path}: expected {count}, got {frames}")
    codec = str(probe.get("codec_name", ""))
    pixel_format = str(probe.get("pix_fmt", ""))
    tags = probe.get("tags") if isinstance(probe.get("tags"), dict) else {}
    alpha_mode = (
        next(
            (value for key, value in tags.items() if str(key).lower() == "alpha_mode"),
            None,
        )
        if isinstance(tags, dict)
        else None
    )
    has_alpha = pixel_format.startswith("yuva") or alpha_mode == "1"
    if path.suffix.lower() == ".mov" and (codec != "prores" or not has_alpha):
        fail(f"edit output lost alpha: codec={codec}, pix_fmt={pixel_format}")
    if path.suffix.lower() == ".webm" and (codec != "vp9" or not has_alpha):
        fail(
            f"browser output lost alpha: codec={codec}, pix_fmt={pixel_format}, "
            f"alpha_mode={alpha_mode}"
        )


def main() -> None:
    args = parse_args()
    source = args.input.expanduser().resolve()
    output = args.output.expanduser().resolve()
    browser_output = (
        args.browser_output.expanduser().resolve() if args.browser_output else None
    )
    if not source.is_file():
        fail(f"source does not exist: {source}")
    if output.suffix.lower() != ".mov":
        fail("edit output must use a .mov extension for ProRes 4444")
    if browser_output and browser_output.suffix.lower() != ".webm":
        fail("browser output must use a .webm extension")
    if args.start_frame < 0:
        fail("--start-frame must be >= 0")
    if not 0.0 <= args.temporal_smoothing <= 1.0:
        fail("--temporal-smoothing must be between 0 and 1")
    if not 0.0 <= args.alpha_black_point < args.alpha_white_point <= 1.0:
        fail("alpha black/white points must satisfy 0 <= black < white <= 1")
    if args.alpha_gamma <= 0:
        fail("--alpha-gamma must be > 0")
    for candidate in (output, browser_output):
        if candidate and candidate.exists() and not args.force:
            fail(f"output exists (pass --force to replace): {candidate}")

    ffmpeg = require_executable(args.ffmpeg)
    ffprobe = require_executable(args.ffprobe)
    info = probe_video(ffprobe, source)
    end_frame = args.end_frame
    if end_frame is None:
        if info.frame_count is None:
            fail("source has no frame count; pass --end-frame explicitly")
        end_frame = info.frame_count - 1
    if end_frame < args.start_frame:
        fail("--end-frame must be >= --start-frame")
    if info.frame_count is not None and end_frame >= info.frame_count:
        fail(
            f"--end-frame {end_frame} exceeds final source frame {info.frame_count - 1}"
        )
    count = end_frame - args.start_frame + 1
    person_roi = parse_person_roi(args.person_roi, info)
    inference_width = person_roi[2] if person_roi else info.width
    inference_height = person_roi[3] if person_roi else info.height
    ratio = args.downsample_ratio or min(
        1.0,
        max(0.125, 480.0 / max(inference_width, inference_height)),
    )
    if not 0.05 <= ratio <= 1.0:
        fail("--downsample-ratio must be between 0.05 and 1")

    output.parent.mkdir(parents=True, exist_ok=True)
    if browser_output:
        browser_output.parent.mkdir(parents=True, exist_ok=True)
    model_spec = MODEL_SPECS[args.model_backbone]
    model = download_model(
        args.model_cache.expanduser().resolve(),
        model_spec["filename"],
        model_spec["url"],
        model_spec["sha256"],
    )
    session = create_session(model, args.provider)
    print(
        f"source={source}\nrange={args.start_frame}..{end_frame} ({count} frames)\n"
        f"format={info.width}x{info.height} {info.fps}fps ratio={ratio:.4f}\n"
        f"provider={session.get_providers()} model={model}",
        file=sys.stderr,
    )

    with tempfile.TemporaryDirectory(prefix="vean-rvm-") as temporary_dir:
        staged = Path(temporary_dir) / "cutout.mov"
        decoder = subprocess.Popen(
            decoder_command(ffmpeg, source, info, args.start_frame, end_frame),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        encoder = subprocess.Popen(
            encoder_command(ffmpeg, staged, info),
            stdin=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            render_matte(
                session,
                decoder,
                encoder,
                info,
                count,
                ratio,
                args.temporal_smoothing,
                args.alpha_black_point,
                args.alpha_white_point,
                args.alpha_gamma,
                args.rgb_source,
                person_roi,
            )
            decoder_stderr = (
                decoder.stderr.read().decode("utf-8", errors="replace")
                if decoder.stderr
                else ""
            )
            encoder_stderr = (
                encoder.stderr.read().decode("utf-8", errors="replace")
                if encoder.stderr
                else ""
            )
            decoder_code = decoder.wait()
            encoder_code = encoder.wait()
            if decoder_code != 0:
                fail(
                    f"source decoder failed ({decoder_code}): {decoder_stderr.strip()}"
                )
            if encoder_code != 0:
                fail(
                    f"ProRes encoder failed ({encoder_code}): {encoder_stderr.strip()}"
                )
            staged_probe = probe_output(ffprobe, staged)
            validate_output(staged, staged_probe, info, count)
            staged.replace(output)
        finally:
            if decoder.poll() is None:
                decoder.kill()
            if encoder.poll() is None:
                encoder.kill()

    output_probe = probe_output(ffprobe, output)
    validate_output(output, output_probe, info, count)
    print(
        f"edit_output={output}\nedit_probe={json.dumps(output_probe, sort_keys=True)}"
    )
    if browser_output:
        staged_browser = browser_output.with_suffix(f".tmp-{os.getpid()}.webm")
        try:
            build_browser_proxy(ffmpeg, output, staged_browser)
            browser_probe = probe_output(ffprobe, staged_browser)
            validate_output(staged_browser, browser_probe, info, count)
            staged_browser.replace(browser_output)
        finally:
            staged_browser.unlink(missing_ok=True)
        print(
            f"browser_output={browser_output}\n"
            f"browser_probe={json.dumps(probe_output(ffprobe, browser_output), sort_keys=True)}"
        )


if __name__ == "__main__":
    main()
