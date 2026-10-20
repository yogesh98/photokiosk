/** RGB [0,255] -> NCHW float32 [-1,1], as specified by MODNet's processor. */
export function normalizeModnetPixels(rgba, width, height) {
  const pixels = width * height;
  if (rgba.length !== pixels * 4) throw new Error("Invalid portrait input pixels.");
  const tensor = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    tensor[i] = (rgba[i * 4] - 127.5) / 127.5;
    tensor[pixels + i] = (rgba[i * 4 + 1] - 127.5) / 127.5;
    tensor[pixels * 2 + i] = (rgba[i * 4 + 2] - 127.5) / 127.5;
  }
  return tensor;
}

/** MediaPipe multiclass index 0 is background; every other class is a person. */
export function personFromBackground(background) {
  const foreground = new Float32Array(background.length);
  for (let i = 0; i < background.length; i++) {
    foreground[i] = Math.max(0, Math.min(1, 1 - background[i]));
  }
  return foreground;
}
