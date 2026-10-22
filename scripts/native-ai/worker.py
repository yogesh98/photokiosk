#!/usr/bin/env python3
"""Private, serial JSON-lines worker: no socket, network access, or saved camera images."""
import base64
import gc
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys
import tempfile

SIZE = 512
BYTES = SIZE * SIZE * 4
MAX_LINE = 5_650_000
GENERAL_MODELS = ("birefnet-lite", "birefnet-general", "birefnet-matting")
BACKGROUND_MATTING_MODEL = "background-matting-mobilenet"
REFERENCE_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


def configuration(request):
    model_id = request.get("model", "modnet")
    acceleration = request.get("acceleration", "auto" if "model" in request else "gpu")
    if model_id not in ("modnet", *GENERAL_MODELS, BACKGROUND_MATTING_MODEL) or acceleration not in ("auto", "cpu", "gpu"):
        raise ValueError("Choose a supported native AI model and acceleration.")
    return model_id, acceleration


def model_size(model_id):
    return SIZE if model_id == "modnet" else 1024


def model_dimensions(model_id):
    if model_id == BACKGROUND_MATTING_MODEL:
        return 768, 512
    size = model_size(model_id)
    return size, size


def request_configuration(request):
    model_id, acceleration = configuration(request)
    reference_id = request.get("referenceId")
    if model_id == BACKGROUND_MATTING_MODEL:
        if not isinstance(reference_id, str) or not REFERENCE_ID.fullmatch(reference_id):
            raise ValueError("Capture an empty scene before using BackgroundMattingV2.")
    elif reference_id is not None:
        raise ValueError("This model does not use an empty-scene reference.")
    return model_id, acceleration, reference_id


def verify_model(root, model_id, model_path):
    if not model_path.is_file():
        raise RuntimeError(f"The {model_id} model is not installed. Run npm run setup:foreground -- {model_id} on the booth computer.")
    if model_id == "modnet":
        return
    manifest_name = "background-matting-models.json" if model_id == BACKGROUND_MATTING_MODEL else "general-foreground-models.json"
    manifest = json.loads((root / "public/models" / manifest_name).read_text())
    pinned = next((item for item in manifest.get("models", []) if item.get("id") == model_id), None)
    if not pinned or model_path.stat().st_size != pinned["bytes"]:
        raise RuntimeError(f"The {model_id} model failed its size check. Reinstall the background models.")
    with model_path.open("rb") as source:
        digest = hashlib.file_digest(source, "sha256").hexdigest()
    if digest != pinned["sha256"]:
        raise RuntimeError(f"The {model_id} model failed its SHA-256 check. Reinstall the background models.")


def decode_rgba(request):
    width, height = model_dimensions(request_configuration(request)[0])
    byte_count = width * height * 4
    if request.get("width") != width or request.get("height") != height:
        raise ValueError(f"Native AI requires a {width} × {height} frame.")
    encoded = request.get("rgba")
    if not isinstance(encoded, str) or len(encoded) != ((byte_count + 2) // 3) * 4:
        raise ValueError("Invalid native frame payload.")
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) != byte_count:
        raise ValueError("Invalid native frame size.")
    return raw


def preprocess(raw, np, model_id="modnet"):
    width, height = model_dimensions(model_id)
    rgb = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 4)[:, :, :3].astype(np.float32)
    if model_id == "modnet":
        rgb = rgb / np.float32(127.5) - 1
    elif model_id == BACKGROUND_MATTING_MODEL:
        rgb /= np.float32(255)
    else:
        # Pinned BiRefNet exports expect RGB ImageNet normalization, not the
        # [-1, 1] portrait-model normalization or per-image contrast stretching.
        rgb = (rgb / np.float32(255) - np.array([0.485, 0.456, 0.406], dtype=np.float32)) / np.array([0.229, 0.224, 0.225], dtype=np.float32)
    return np.ascontiguousarray(rgb.transpose(2, 0, 1)[None])


def encode_alpha(output, np, model_id="modnet"):
    alpha = np.asarray(output, dtype=np.float32)
    width, height = model_dimensions(model_id)
    if alpha.shape != (1, 1, height, width) or not np.isfinite(alpha).all():
        raise ValueError("Native AI returned an invalid alpha mask.")
    if model_id in GENERAL_MODELS:
        # Exports return logits. Stable sigmoid keeps both very positive and
        # very negative logits finite without introducing per-frame flicker.
        magnitude = np.exp(-np.abs(alpha))
        alpha = np.where(alpha >= 0, 1 / (1 + magnitude), magnitude / (1 + magnitude))
    elif model_id == BACKGROUND_MATTING_MODEL and (np.min(alpha) < -1e-6 or np.max(alpha) > 1 + 1e-6):
        raise ValueError("BackgroundMattingV2 returned alpha outside its documented opacity range.")
    return base64.b64encode(np.clip(alpha, 0, 1).astype("<f4", copy=False).tobytes()).decode("ascii")


def load_reference(root, reference_id, np):
    from PIL import Image
    # The ID is a server-generated immutable UUID, never a filename or URL.
    request_configuration({"model": BACKGROUND_MATTING_MODEL, "referenceId": reference_id})
    directory = Path(os.environ.get("PHOTO_KIOSK_DATA_DIR", str(root / ".data"))) / "reference-backgrounds"
    filename = directory / f"{reference_id}.png"
    try:
        if filename.is_symlink() or filename.stat().st_size > 4_000_000:
            raise ValueError("The empty-scene reference is invalid. Capture it again.")
        with Image.open(filename) as image:
            if image.format != "PNG" or image.size != (768, 512) or getattr(image, "n_frames", 1) != 1:
                raise ValueError("The empty-scene reference must be a 768 × 512 PNG. Capture it again.")
            rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / np.float32(255)
    except FileNotFoundError as error:
        raise ValueError("The empty-scene reference is missing. Capture it again.") from error
    return np.ascontiguousarray(rgb.transpose(2, 0, 1)[None])


class NativeModel:
    def __init__(self, root, model_id="modnet", acceleration="gpu", reference_id=None):
        import numpy as np
        self.np = np
        self.model_id, self.acceleration = configuration({"model": model_id, "acceleration": acceleration})
        _, _, self.reference_id = request_configuration({"model": model_id, "acceleration": acceleration, **({"referenceId": reference_id} if reference_id is not None else {})})
        self.size = model_size(model_id)
        self.width, self.height = model_dimensions(model_id)
        self.reference = load_reference(root, reference_id, np) if model_id == BACKGROUND_MATTING_MODEL else None
        self.fallback_reason = None
        model_path = root / "public/models" / model_id / "model.onnx"
        verify_model(root, model_id, model_path)
        cache = Path(os.environ.get("PHOTO_KIOSK_DATA_DIR", str(root / ".data"))) / "native-ai"
        cache.mkdir(parents=True, exist_ok=True)
        system, machine = platform.system(), platform.machine().lower()
        if acceleration == "cpu" or (acceleration == "auto" and model_id != "modnet"):
            self.load_cpu(model_path)
            if acceleration == "auto":
                self.fallback_reason = "Auto uses native CPU for this model. Select GPU to test native acceleration."
        else:
            try:
                if system == "Linux" and machine in ("x86_64", "amd64"):
                    self.load_openvino(model_path, cache)
                elif system == "Darwin" and machine == "arm64":
                    self.load_coreml(model_path, cache)
                else:
                    raise RuntimeError("Native GPU inference supports Intel GPU Linux and Apple Silicon macOS.")
            except ModuleNotFoundError:
                raise
            except Exception as error:
                raise RuntimeError(f"Native GPU could not run {model_id}: {error}. Select CPU to run this model.") from error

    def warmup(self):
        source = self.reference if self.reference is not None else self.np.zeros((1, 3, self.height, self.width), dtype=self.np.float32)
        encode_alpha(self.infer(source), self.np, self.model_id)

    def bind_onnx(self, session):
        inputs, outputs = session.get_inputs(), session.get_outputs()
        if self.model_id == BACKGROUND_MATTING_MODEL:
            if [item.name for item in inputs] != ["src", "bgr"] or not {"pha", "fgr"}.issubset({item.name for item in outputs}):
                raise RuntimeError("The installed BackgroundMattingV2 model has unexpected input or output names.")
            for item in inputs:
                if item.type != "tensor(float)" or len(item.shape) != 4 or item.shape[1] != 3:
                    raise RuntimeError("The installed BackgroundMattingV2 model expects invalid input tensors.")
            self.infer = lambda tensor: session.run(["pha"], {"src": tensor, "bgr": self.reference})[0]
            return
        expected = ("input", "output") if self.model_id == "modnet" else ("input_image", "output_image")
        if len(inputs) != 1 or len(outputs) != 1 or (inputs[0].name, outputs[0].name) != expected:
            raise RuntimeError("The installed native model has unexpected input or output names.")
        self.infer = lambda tensor: session.run([outputs[0].name], {inputs[0].name: tensor})[0]

    def load_cpu(self, model_path):
        import onnxruntime as ort
        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        # Large general models should not retain a second packed copy of their
        # weights. Each worker owns exactly one session and one serial frame.
        options.add_session_config_entry("session.disable_prepacking", "1")
        session = ort.InferenceSession(str(model_path), sess_options=options, providers=["CPUExecutionProvider"])
        session.disable_fallback()
        if session.get_providers() != ["CPUExecutionProvider"]:
            raise RuntimeError("Native CPU inference selected an unexpected provider.")
        self.bind_onnx(session)
        self.warmup()
        self.provider = "onnx-cpu"
        self.device = "Native CPU (ONNX Runtime)"

    def load_openvino(self, model_path, cache):
        import openvino as ov
        core = ov.Core()
        if not any(device == "GPU" or device.startswith("GPU.") for device in core.available_devices):
            raise RuntimeError("OpenVINO cannot find an Intel GPU. Install the Intel compute driver and check access to /dev/dri/render*. You can use CPU in the meantime.")
        model = core.read_model(str(model_path))
        if self.model_id == BACKGROUND_MATTING_MODEL:
            model.reshape({"src": [1, 3, self.height, self.width], "bgr": [1, 3, self.height, self.width]})
        else:
            model.reshape([1, 3, self.height, self.width])
        compiled = core.compile_model(model, "GPU", {"PERFORMANCE_HINT": "LATENCY", "CACHE_DIR": str(cache / "openvino")})
        devices = compiled.get_property("EXECUTION_DEVICES")
        if not devices or not all(str(device).startswith("GPU") for device in devices):
            raise RuntimeError("OpenVINO did not select an Intel GPU.")
        request = compiled.create_infer_request()
        if self.model_id == BACKGROUND_MATTING_MODEL:
            self.infer = lambda tensor: request.infer({"src": tensor, "bgr": self.reference})[compiled.output("pha")]
        else:
            self.infer = lambda tensor: request.infer({compiled.input(0): tensor})[compiled.output(0)]
        self.warmup()
        self.provider = "openvino"
        self.device = f"Intel OpenVINO GPU · {core.get_property('GPU', 'FULL_DEVICE_NAME')}"

    def load_coreml(self, model_path, cache):
        import onnxruntime as ort
        if "CoreMLExecutionProvider" not in ort.get_available_providers():
            raise RuntimeError("This ONNX Runtime does not include Core ML. Run scripts/native-ai/setup.py using native Apple Silicon Python.")
        fixed_path = model_path
        if self.model_id == "modnet":
            import onnx
            with model_path.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()[:24]
            fixed_path = cache / f"modnet-{digest}-512.onnx"
            if not fixed_path.exists():
                model = onnx.load(str(model_path))
                dimensions = model.graph.input[0].type.tensor_type.shape.dim
                for dimension, value in zip(dimensions, (1, 3, SIZE, SIZE), strict=True):
                    dimension.ClearField("dim_param")
                    dimension.dim_value = value
                # Old intermediate symbolic shapes would prevent Core ML partitions.
                del model.graph.value_info[:]
                for output in model.graph.output:
                    output.type.tensor_type.ClearField("shape")
                model = onnx.shape_inference.infer_shapes(model)
                with tempfile.NamedTemporaryFile(dir=cache, suffix=".onnx", delete=False) as file:
                    temporary_path = Path(file.name)
                try:
                    onnx.save(model, str(temporary_path))
                    temporary_path.replace(fixed_path)
                finally:
                    temporary_path.unlink(missing_ok=True)
        options = ort.SessionOptions()
        options.enable_profiling = True
        options.profile_file_prefix = str(cache / "coreml-probe")
        options.intra_op_num_threads = 2
        options.log_severity_level = 3
        session = ort.InferenceSession(str(fixed_path), sess_options=options, providers=[("CoreMLExecutionProvider", {
            # MODNet's resize graph fails MLProgram compilation on some macOS
            # versions. NeuralNetwork is verified with this pinned export.
            "ModelFormat": "NeuralNetwork" if self.model_id == "modnet" else "MLProgram",
            "MLComputeUnits": "CPUAndGPU", "RequireStaticInputShapes": "1",
            "ModelCacheDirectory": str(cache / f"coreml-{self.model_id}"),
        })])
        # ONNX Runtime may silently fall back during provider creation. Require
        # both the provider and at least one real Core ML kernel in a warmup run.
        session.disable_fallback()
        if "CoreMLExecutionProvider" not in session.get_providers():
            raise RuntimeError("Core ML could not initialize; use CPU or check the native runtime installation.")
        self.bind_onnx(session)
        self.warmup()
        profile = Path(session.end_profiling())
        try:
            events = json.loads(profile.read_text())
        finally:
            profile.unlink(missing_ok=True)
        if not any(event.get("args", {}).get("provider") == "CoreMLExecutionProvider" for event in events):
            raise RuntimeError("Core ML could not accelerate this model; select CPU instead.")
        self.provider = "coreml"
        self.device = "Apple Core ML (GPU + CPU)"

    def info(self):
        result = {"provider": self.provider, "device": self.device[:180], "model": self.model_id,
                  "width": self.width, "height": self.height, "kind": "alpha"}
        if self.reference_id is not None:
            result["referenceId"] = self.reference_id
        if self.fallback_reason:
            result["fallbackReason"] = self.fallback_reason
        return result

    def segment(self, request):
        if request_configuration(request) != (self.model_id, self.acceleration, self.reference_id):
            raise ValueError("The native model changed. Initialize the selected model before sending another frame.")
        tensor = preprocess(decode_rgba(request), self.np, self.model_id)
        return {**self.info(), "alpha": encode_alpha(self.infer(tensor), self.np, self.model_id)}


def main():
    # C/C++ runtimes sometimes write diagnostics directly to fd 1. Keep that
    # output away from the protocol even when Python's stdout is bypassed.
    protocol = os.fdopen(os.dup(sys.stdout.fileno()), "w", buffering=1)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    root = Path(__file__).resolve().parents[2]
    model = None
    for line in iter(lambda: sys.stdin.buffer.readline(MAX_LINE + 1), b""):
        if len(line) > MAX_LINE or not line.endswith(b"\n"):
            break
        request = {}
        try:
            request = json.loads(line)
            if not isinstance(request, dict) or request.get("type") not in ("initialize", "segment"):
                raise ValueError("Invalid native inference request.")
            selected = request_configuration(request)
            if request["type"] == "segment":
                decode_rgba(request)
            if model is not None and selected != (model.model_id, model.acceleration, model.reference_id):
                if request["type"] != "initialize":
                    raise ValueError("The native model changed. Initialize the selected model before sending another frame.")
                model = None
                gc.collect()
            if model is None:
                model = NativeModel(root, *selected)
            result = model.info() if request["type"] == "initialize" else model.segment(request)
            response = {"id": request.get("id"), **result}
        except Exception as error:
            detail = str(error).strip().replace("\n", " ")[:600]
            if isinstance(error, ModuleNotFoundError):
                detail = "Native AI dependencies are missing. Run python3 scripts/native-ai/setup.py on the computer running the booth."
            response = {"id": request.get("id") if isinstance(request, dict) else None, "error": detail or "Native AI could not process this frame.", "code": "native_unavailable"}
        protocol.write(json.dumps(response, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
