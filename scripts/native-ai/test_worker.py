"""Run with .venv-ai/bin/python -m unittest discover -s scripts/native-ai -p 'test_*.py'."""
import base64
import unittest
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


if __name__ == "__main__":
    unittest.main()
