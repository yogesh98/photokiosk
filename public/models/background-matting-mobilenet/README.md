# BackgroundMattingV2 MobileNetV2

This is the official MobileNetV2 HD ONNX export from [BackgroundMattingV2 v1.0.0](https://github.com/PeterL1n/BackgroundMattingV2/releases/tag/v1.0.0), licensed under MIT by the University of Washington. The original model and refinement network are used without changing the weights. See the accompanying LICENSE.

Install or verify this optional model:

```sh
npm run setup:foreground -- background-matting-mobilenet
npm run setup:foreground -- background-matting-mobilenet --verify
npm run setup:ai
```

The pinned artifact is `onnx_mobilenetv2_hd.onnx`, 20,007,646 bytes, SHA-256 `6d6c3fbecbc330d070c3d89c7542ef476f849e7d5e7e8c914f85ba5730d744dd`. Its ONNX opset is 11. The HD export uses a MobileNetV2 backbone at scale 0.25 and sampling refinement of up to 80,000 pixels. Download provenance and the transport contract are recorded in `../background-matting-models.json`.

The model receives both the current camera image (`src`) and a captured empty scene (`bgr`). Both are RGB float32 tensors in NCHW layout, with values divided by 255. The ONNX graph accepts dynamic dimensions; the booth uses 768 × 512 inputs so its existing 3:2 camera crop remains aligned with the reference. The reference must come from the same stationary camera, framing, mirror setting, focus, exposure, and lighting.

The `pha` output already represents alpha opacity in [0, 1]. It must not receive a sigmoid or per-frame contrast adjustment. The app upsamples this alpha to composite the original photo pixels. The model also predicts corrected foreground `fgr`; this integration retains original camera RGB to preserve detail in the saved full-resolution photo. That choice does not apply the model's foreground color correction near translucent edges.

Auto and CPU use native ONNX Runtime CPU. GPU requests require an actual accelerated Core ML/OpenVINO warmup and report an error if this export cannot run on that provider. Models and the empty-scene reference remain local to the booth. The worker verifies the model's pinned byte count and hash before opening the inference session.

Official documentation: [model inputs, outputs, and ONNX compatibility](https://github.com/PeterL1n/BackgroundMattingV2/blob/master/doc/model_usage.md), [export configuration](https://github.com/PeterL1n/BackgroundMattingV2/blob/master/export_onnx.py).
