#!/usr/bin/env python3
"""Optional local GPU runtime. Run with the Python interpreter to use for the venv."""
import platform
from pathlib import Path
import subprocess
import sys
import venv


def main():
    if not (3, 11) <= sys.version_info[:2] <= (3, 14):
        raise SystemExit("Native AI needs Python 3.11–3.14. Run this script with a supported interpreter.")
    system, machine = platform.system(), platform.machine().lower()
    packages = ["numpy==2.4.3"]
    if system == "Darwin" and machine == "arm64":
        if int(platform.mac_ver()[0].split(".")[0]) < 14:
            raise SystemExit("This pinned Apple Silicon runtime requires macOS 14 or newer.")
        packages += ["onnxruntime==1.24.4", "onnx==1.20.1"]
    elif system == "Linux" and machine in ("x86_64", "amd64"):
        packages += ["openvino==2026.0.0", "openvino-telemetry==2025.2.0"]
    else:
        raise SystemExit("Native AI supports Apple Silicon macOS and Linux x86_64 with an Intel GPU. Browser CPU inference remains available.")
    root = Path(__file__).resolve().parents[2]
    target = root / ".venv-ai"
    venv.EnvBuilder(with_pip=True).create(target)
    python = target / "bin" / "python"
    subprocess.run([str(python), "-m", "pip", "install", "--only-binary=:all:", *packages], check=True)
    if system == "Linux":
        subprocess.run([str(target / "bin" / "opt_in_out"), "--opt_out"], check=True)
        print("Install Intel GPU compute drivers and grant this user access to /dev/dri/render* if not already configured. See the README.")
    print("Native AI installed. Select Portrait and Auto or GPU in the booth. No separate server is needed.")


if __name__ == "__main__":
    main()
