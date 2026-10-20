#!/usr/bin/env python3
"""Private, serial JSON-lines worker: no socket, network access, or saved camera images."""
import base64
import hashlib
import json
import os
from pathlib import Path
import platform
import sys
import tempfile

SIZE = 512
BYTES = SIZE * SIZE * 4
MAX_LINE = 1_450_000


def decode_rgba(request):
    if request.get("width") != SIZE or request.get("height") != SIZE:
        raise ValueError("Native Portrait requires a 512 × 512 frame.")
    encoded = request.get("rgba")
    if not isinstance(encoded, str) or len(encoded) != ((BYTES + 2) // 3) * 4:
        raise ValueError("Invalid native frame payload.")
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) != BYTES:
        raise ValueError("Invalid native frame size.")
    return raw


def preprocess(raw, np):
    rgb = np.frombuffer(raw, dtype=np.uint8).reshape(SIZE, SIZE, 4)[:, :, :3]
    return np.ascontiguousarray((rgb.astype(np.float32) / np.float32(127.5) - 1).transpose(2, 0, 1)[None])


def encode_alpha(output, np):
    alpha = np.asarray(output, dtype=np.float32)
    if alpha.shape != (1, 1, SIZE, SIZE) or not np.isfinite(alpha).all():
        raise ValueError("Native Portrait returned an invalid alpha mask.")
    return base64.b64encode(np.clip(alpha, 0, 1).astype("<f4", copy=False).tobytes()).decode("ascii")


class NativeModel:
    def __init__(self, root):
        import numpy as np
        self.np = np
        model_path = root / "public/models/modnet/model.onnx"
        cache = Path(os.environ.get("PHOTO_KIOSK_DATA_DIR", str(root / ".data"))) / "native-ai"
        cache.mkdir(parents=True, exist_ok=True)
        system, machine = platform.system(), platform.machine().lower()
        if system == "Linux" and machine in ("x86_64", "amd64"):
            self.load_openvino(model_path, cache)
        elif system == "Darwin" and machine == "arm64":
            self.load_coreml(model_path, cache)
        else:
            raise RuntimeError("Native GPU inference supports Intel GPU Linux and Apple Silicon macOS. Select CPU on this computer.")

    def load_openvino(self, model_path, cache):
        import openvino as ov
        core = ov.Core()
        if not any(device == "GPU" or device.startswith("GPU.") for device in core.available_devices):
            raise RuntimeError("OpenVINO cannot find an Intel GPU. Install the Intel compute driver and check access to /dev/dri/render*. You can use CPU in the meantime.")
        model = core.read_model(str(model_path))
        model.reshape([1, 3, SIZE, SIZE])
        compiled = core.compile_model(model, "GPU", {"PERFORMANCE_HINT": "LATENCY", "CACHE_DIR": str(cache / "openvino")})
        devices = compiled.get_property("EXECUTION_DEVICES")
        if not devices or not all(str(device).startswith("GPU") for device in devices):
            raise RuntimeError("OpenVINO did not select an Intel GPU.")
        request = compiled.create_infer_request()
        self.infer = lambda tensor: request.infer({compiled.input(0): tensor})[compiled.output(0)]
        encode_alpha(self.infer(self.np.zeros((1, 3, SIZE, SIZE), dtype=self.np.float32)), self.np)
        self.provider = "openvino"
        self.device = f"Intel OpenVINO GPU · {core.get_property('GPU', 'FULL_DEVICE_NAME')}"

    def load_coreml(self, model_path, cache):
        import onnx
        import onnxruntime as ort
        if "CoreMLExecutionProvider" not in ort.get_available_providers():
            raise RuntimeError("This ONNX Runtime does not include Core ML. Run scripts/native-ai/setup.py using native Apple Silicon Python.")
        digest = hashlib.sha256(model_path.read_bytes()).hexdigest()[:24]
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
            "ModelFormat": "NeuralNetwork", "MLComputeUnits": "CPUAndGPU", "RequireStaticInputShapes": "1",
            "ModelCacheDirectory": str(cache / "coreml-neuralnetwork"),
        })])
        # ONNX Runtime may silently fall back during provider creation. Require
        # both the provider and at least one real Core ML kernel in a warmup run.
        session.disable_fallback()
        if "CoreMLExecutionProvider" not in session.get_providers():
            raise RuntimeError("Core ML could not initialize; use CPU or check the native runtime installation.")
        name = session.get_inputs()[0].name
        self.infer = lambda tensor: session.run(None, {name: tensor})[0]
        encode_alpha(self.infer(self.np.zeros((1, 3, SIZE, SIZE), dtype=self.np.float32)), self.np)
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
        return {"provider": self.provider, "device": self.device[:180], "width": SIZE, "height": SIZE, "kind": "alpha"}

    def segment(self, request):
        tensor = preprocess(decode_rgba(request), self.np)
        return {**self.info(), "alpha": encode_alpha(self.infer(tensor), self.np)}


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
            if request["type"] == "segment":
                decode_rgba(request)
            if model is None:
                model = NativeModel(root)
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
