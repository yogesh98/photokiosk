import contextlib
import io
import unittest
from unittest.mock import patch
import setup


class SetupTests(unittest.TestCase):
    def run_platform(self, system, machine, version="14.0"):
        with patch.object(setup.sys, "version_info", (3, 12)), \
             patch.object(setup.platform, "system", return_value=system), \
             patch.object(setup.platform, "machine", return_value=machine), \
             patch.object(setup.platform, "mac_ver", return_value=(version, (), "")), \
             patch.object(setup.venv, "EnvBuilder") as builder, \
             patch.object(setup.subprocess, "run") as run, \
             contextlib.redirect_stdout(io.StringIO()):
            setup.main()
            return builder, run

    def test_intel_linux_installs_openvino_and_disables_telemetry(self):
        builder, run = self.run_platform("Linux", "x86_64")
        builder.return_value.create.assert_called_once()
        self.assertIn("openvino==2026.0.0", run.call_args_list[0].args[0])
        self.assertIn("numpy==2.4.3", run.call_args_list[0].args[0])
        self.assertEqual(run.call_args_list[1].args[0][-1], "--opt_out")

    def test_apple_silicon_installs_coreml_runtime(self):
        _, run = self.run_platform("Darwin", "arm64")
        self.assertEqual(run.call_count, 1)
        self.assertIn("onnxruntime==1.24.4", run.call_args.args[0])
        self.assertIn("onnx==1.20.1", run.call_args.args[0])

    def test_unsupported_platforms_stop_before_creating_environment(self):
        for system, machine, version in [("Darwin", "arm64", "13.0"), ("Darwin", "x86_64", "14.0"), ("Linux", "aarch64", "")]:
            with self.assertRaises(SystemExit):
                self.run_platform(system, machine, version)


if __name__ == "__main__":
    unittest.main()
