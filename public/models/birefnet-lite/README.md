# BiRefNet Lite

General foreground/background removal from [the upstream model](https://huggingface.co/ZhengPeng7/BiRefNet_lite), converted to ONNX by [onnx-community/BiRefNet_lite-ONNX](https://huggingface.co/onnx-community/BiRefNet_lite-ONNX). The weights are optional local files and are excluded from Git.

```sh
npm run setup:foreground -- birefnet-lite
```

- Export revision: `de15b22ba131738a16dff04aab8bdf8dc32e3ac1`
- Source file: `onnx/model.onnx`
- Local file: `model.onnx` (224,005,088 bytes, FP32, opset 17)
- SHA-256: `5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333`
- License: MIT; see [LICENSE](./LICENSE), copied from [upstream](https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE).

Input `input_image`: float32 RGB, NCHW `[1, 3, 1024, 1024]`. Rescale channels by 1/255, then normalize with mean `[0.485, 0.456, 0.406]` and standard deviation `[0.229, 0.224, 0.225]`. Output `output_image`: float32 `[1, 1, 1024, 1024]` logits; apply sigmoid to obtain alpha. Resize the complete frame to the input dimensions, then map alpha back to the original frame.

The pinned files passed `onnx.checker.check_model` locally and contain no custom operators or native `DeformConv`. They run through the optional local Python backend because the large intermediate tensors in these exports can exceed browser WebAssembly memory. Model weights and input/output settings are recorded in [the manifest](../general-foreground-models.json).

BiRefNet: Peng Zheng, Dehong Gao, Deng-Ping Fan, Liu Liu, Jorma Laaksonen, Wanli Ouyang, Nicu Sebe, *Bilateral Reference for High-Resolution Dichotomous Image Segmentation* (2024).
