"""Run with .venv-ai/bin/python -m unittest discover -s scripts/native-ai -p 'test_*.py'."""
import base64
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import worker


class ProtocolTests(unittest.TestCase):
    def test_rgba_bounds(self):
        raw = bytes([255, 0, 127, 255]) * (512 * 512)
        request = {"width": 512, "height": 512, "rgba": base64.b64encode(raw).decode()}
        self.assertEqual(worker.decode_rgba(request), raw)
        with self.assertRaises(ValueError):
            worker.decode_rgba({**request, "width": 4096})
        with self.assertRaises(ValueError):
            worker.decode_rgba({**request, "rgba": ""})

    def test_normalization_and_channel_order(self):
        import numpy as np
        raw = bytes([255, 0, 127, 255]) * (512 * 512)
        tensor = worker.preprocess(raw, np)
        self.assertEqual(tensor.shape, (1, 3, 512, 512))
        self.assertEqual(tensor.dtype, np.float32)
        np.testing.assert_allclose(tensor[0, :, 0, 0], [1, -1, 127 / 127.5 - 1], atol=1e-7)
        self.assertTrue(tensor.flags.c_contiguous)

    def test_alpha_preserves_continuous_opacity_and_little_endian(self):
        import numpy as np
        mask = np.full((1, 1, 512, 512), 0.25, dtype=np.float32)
        encoded = worker.encode_alpha(mask, np)
        self.assertEqual(base64.b64decode(encoded)[:4], b"\x00\x00\x80\x3e")
        mask[0, 0, 0, 0] = np.nan
        with self.assertRaises(ValueError):
            worker.encode_alpha(mask, np)
        with self.assertRaises(ValueError):
            worker.encode_alpha(np.zeros((512, 512)), np)

    def test_general_model_imagenet_normalization_and_rgba_bounds(self):
        import numpy as np
        raw = bytes([255, 0, 127, 128]) * (1024 * 1024)
        request = {"model": "birefnet-lite", "acceleration": "cpu", "width": 1024, "height": 1024, "rgba": base64.b64encode(raw).decode()}
        self.assertEqual(worker.decode_rgba(request), raw)
        tensor = worker.preprocess(raw, np, "birefnet-lite")
        self.assertEqual(tensor.shape, (1, 3, 1024, 1024))
        self.assertEqual(tensor.dtype, np.float32)
        self.assertTrue(tensor.flags.c_contiguous)
        np.testing.assert_allclose(tensor[0, :, 0, 0], [(1 - 0.485) / 0.229, -0.456 / 0.224, (127 / 255 - 0.406) / 0.225], atol=1e-6)
        for patch in ({"width": 512}, {"model": "other"}, {"acceleration": "other"}):
            with self.assertRaises(ValueError):
                worker.decode_rgba({**request, **patch})

    def test_general_logits_use_stable_sigmoid_without_contrast_stretching(self):
        import numpy as np
        mask = np.zeros((1, 1, 1024, 1024), dtype=np.float32)
        mask[0, 0, 0, :5] = [-1000, -2, 0, 2, 1000]
        for model_id in worker.GENERAL_MODELS:
            decoded = np.frombuffer(base64.b64decode(worker.encode_alpha(mask, np, model_id)), dtype="<f4")
            np.testing.assert_allclose(decoded[:5], [0, 1 / (1 + np.exp(2)), 0.5, 1 / (1 + np.exp(-2)), 1], atol=1e-7)
            self.assertEqual(float(decoded[6]), 0.5)

    def test_general_assets_are_verified_before_opening_a_session(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            directory = root / "public/models/birefnet-lite"
            directory.mkdir(parents=True)
            model_path = directory / "model.onnx"
            with self.assertRaisesRegex(RuntimeError, "not installed"):
                worker.verify_model(root, "birefnet-lite", model_path)


class BackgroundMattingTests(unittest.TestCase):
    reference_id = "5a9cfd39-7ccf-41c5-aee2-6a3c094747a6"

    def test_reference_configuration_requires_uuid_not_an_arbitrary_path(self):
        request = {"model": worker.BACKGROUND_MATTING_MODEL, "acceleration": "cpu", "referenceId": self.reference_id}
        self.assertEqual(worker.request_configuration(request), (worker.BACKGROUND_MATTING_MODEL, "cpu", self.reference_id))
        for reference in (None, "../private-photo", "", self.reference_id.upper(), self.reference_id.replace("41c5", "11c5")):
            with self.assertRaises(ValueError):
                worker.request_configuration({**request, "referenceId": reference})
        with self.assertRaises(ValueError):
            worker.request_configuration({"model": "modnet", "referenceId": self.reference_id})

    def test_source_pixels_are_rgb_zero_to_one_with_three_by_two_dimensions(self):
        import numpy as np
        raw = bytes([255, 0, 127, 0]) * (768 * 512)
        request = {"model": worker.BACKGROUND_MATTING_MODEL, "referenceId": self.reference_id,
                   "width": 768, "height": 512, "rgba": base64.b64encode(raw).decode()}
        self.assertEqual(worker.decode_rgba(request), raw)
        tensor = worker.preprocess(raw, np, worker.BACKGROUND_MATTING_MODEL)
        self.assertEqual(tensor.shape, (1, 3, 512, 768))
        self.assertEqual(tensor.dtype, np.float32)
        self.assertTrue(tensor.flags.c_contiguous)
        np.testing.assert_allclose(tensor[0, :, 0, 0], [1, 0, 127 / 255], atol=1e-7)
        with self.assertRaises(ValueError):
            worker.decode_rgba({**request, "width": 512})

    def test_reference_loading_keeps_capture_alignment_and_rejects_bad_png(self):
        import numpy as np
        from PIL import Image
        with tempfile.TemporaryDirectory() as temporary, patch.dict(worker.os.environ, {"PHOTO_KIOSK_DATA_DIR": temporary}):
            directory = Path(temporary) / "reference-backgrounds"
            directory.mkdir()
            filename = directory / f"{self.reference_id}.png"
            with self.assertRaisesRegex(ValueError, "missing"):
                worker.load_reference(Path(temporary), self.reference_id, np)
            image = Image.new("RGB", (768, 512), (255, 0, 127))
            image.putpixel((0, 0), (0, 255, 0))
            image.save(filename)
            reference = worker.load_reference(Path(temporary), self.reference_id, np)
            self.assertEqual(reference.shape, (1, 3, 512, 768))
            np.testing.assert_allclose(reference[0, :, 0, 0], [0, 1, 0])
            np.testing.assert_allclose(reference[0, :, 0, 767], [1, 0, 127 / 255], atol=1e-7)
            Image.new("RGB", (512, 768)).save(filename)
            with self.assertRaisesRegex(ValueError, "768"):
                worker.load_reference(Path(temporary), self.reference_id, np)
            Image.new("RGB", (768, 512)).save(filename, format="JPEG")
            with self.assertRaisesRegex(ValueError, "PNG"):
                worker.load_reference(Path(temporary), self.reference_id, np)

    def test_opacity_is_not_sigmoided_and_invalid_values_fail(self):
        import numpy as np
        alpha = np.full((1, 1, 512, 768), 0.25, dtype=np.float32)
        alpha[0, 0, 0, :3] = [0, 0.5, 1]
        decoded = np.frombuffer(base64.b64decode(worker.encode_alpha(alpha, np, worker.BACKGROUND_MATTING_MODEL)), dtype="<f4")
        np.testing.assert_array_equal(decoded[:4], [0, 0.5, 1, 0.25])
        for invalid in (-0.01, 1.01, np.nan):
            alpha[0, 0, 0, 0] = invalid
            with self.assertRaises(ValueError):
                worker.encode_alpha(alpha, np, worker.BACKGROUND_MATTING_MODEL)

    def test_native_session_uses_cached_background_and_only_alpha_output(self):
        import numpy as np
        model = worker.NativeModel.__new__(worker.NativeModel)
        model.model_id, model.acceleration, model.reference_id = worker.BACKGROUND_MATTING_MODEL, "cpu", self.reference_id
        model.reference = np.full((1, 3, 512, 768), 0.4, dtype=np.float32)
        source = np.full_like(model.reference, 0.8)
        calls = []
        session = SimpleNamespace(
            get_inputs=lambda: [SimpleNamespace(name=name, shape=["batch", 3, "height", "width"], type="tensor(float)") for name in ["src", "bgr"]],
            get_outputs=lambda: [SimpleNamespace(name=name) for name in ["pha", "fgr", "err_sm"]],
            run=lambda names, feeds: calls.append((names, feeds)) or [np.full((1, 1, 512, 768), 0.5, dtype=np.float32)],
        )
        model.bind_onnx(session)
        output = model.infer(source)
        self.assertEqual(output.shape, (1, 1, 512, 768))
        self.assertEqual(calls[0][0], ["pha"])
        self.assertIs(calls[0][1]["src"], source)
        self.assertIs(calls[0][1]["bgr"], model.reference)
        with self.assertRaisesRegex(ValueError, "changed"):
            model.segment({"model": worker.BACKGROUND_MATTING_MODEL, "acceleration": "cpu", "referenceId": "78c48b9b-aad9-44d8-9cef-c26c29c2ccee"})
            model_path.write_bytes(b"pinned model")
            manifest = {"models": [{"id": "birefnet-lite", "bytes": 12, "sha256": hashlib.sha256(b"pinned model").hexdigest()}]}
            (directory.parent / "general-foreground-models.json").write_text(json.dumps(manifest))
            worker.verify_model(root, "birefnet-lite", model_path)
            model_path.write_bytes(b"other model!")
            with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                worker.verify_model(root, "birefnet-lite", model_path)


if __name__ == "__main__":
    unittest.main()
