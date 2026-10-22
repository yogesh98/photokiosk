# BiRefNet Matting

General foreground/background removal from [the upstream model](https://huggingface.co/ZhengPeng7/BiRefNet-matting), converted to ONNX by [emrikol/birefnet-matting-onnx](https://huggingface.co/emrikol/birefnet-matting-onnx). The weights are optional local files and are excluded from Git.

```sh
npm run setup:foreground -- birefnet-matting
```

- Export revision: `0d58d809b3a360b44c556223d2f5812aeace9ba3`
- Source file: `birefnet-matting.onnx`
- Local file: `model.onnx` (940,840,787 bytes, FP32, opset 16)
- SHA-256: `f0843e38f6a4e88efc8c5fad4178ad7ed6c818346ce12f82e7b579324fe7e0c5`
- License: MIT; see [LICENSE](./LICENSE), copied from [upstream](https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE).

Input `input_image`: float32 RGB, NCHW `[1, 3, 1024, 1024]`. Rescale channels by 1/255, then normalize with mean `[0.485, 0.456, 0.406]` and standard deviation `[0.229, 0.224, 0.225]`. Output `output_image`: float32 `[1, 1, 1024, 1024]` logits; apply sigmoid to obtain alpha. Resize the complete frame to the input dimensions, then map alpha back to the original frame.

The pinned files passed `onnx.checker.check_model` locally and contain no custom operators or native `DeformConv`. They run through the optional local Python backend because the large intermediate tensors in these exports can exceed browser WebAssembly memory. Model weights and input/output settings are recorded in [the manifest](../general-foreground-models.json).

BiRefNet: Peng Zheng, Dehong Gao, Deng-Ping Fan, Liu Liu, Jorma Laaksonen, Wanli Ouyang, Nicu Sebe, *Bilateral Reference for High-Resolution Dichotomous Image Segmentation* (2024).
