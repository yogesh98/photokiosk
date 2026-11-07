import type { KioskSettings } from "./kiosk-types";

/**
 * Green-screen keying and compositing on the GPU.
 *
 * The 2D-canvas path keys 614,400 pixels per 960 x 640 frame in JavaScript,
 * which saturates one core of the booth's N100 at 15 fps. A fragment shader
 * does the same arithmetic for every pixel at once, so the main thread only
 * uploads the camera frame and issues one draw call per frame.
 *
 * The maths matches applyChromaKey exactly: distance from pure green in
 * Cb/Cr space, a smoothstep edge, and spill suppression on green pixels.
 */

export interface WebGLCompositeOptions {
  source: TexImageSource;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
  settings: KioskSettings;
  background: HTMLImageElement | null;
  overlay?: HTMLImageElement | null;
}

export interface WebGLCompositor {
  /** Draws one frame. Returns false while the context is lost; the caller then skips the frame. */
  draw(options: WebGLCompositeOptions): boolean;
  destroy(): void;
}

const VERTEX_SHADER = `
attribute vec2 aPosition;
varying vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uSource;
uniform sampler2D uBackground;
uniform sampler2D uOverlay;
uniform vec2 uSourceScale;
uniform vec2 uSourceOffset;
uniform vec2 uBackgroundScale;
uniform vec2 uBackgroundOffset;
uniform float uMirror;
uniform float uKey;
uniform float uHasBackground;
uniform float uHasOverlay;
uniform vec3 uFill;
uniform float uThreshold;
uniform float uSoftness;
uniform float uSpill;

void main() {
  // Images upload top row first while WebGL's v axis points up, so flip v
  // here rather than with UNPACK_FLIP_Y_WEBGL, which browsers do not apply
  // consistently to every source type (ImageBitmap in particular).
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 sourceUv = uv;
  if (uMirror > 0.5) sourceUv.x = 1.0 - sourceUv.x;
  sourceUv = sourceUv * uSourceScale + uSourceOffset;
  vec3 rgb = texture2D(uSource, sourceUv).rgb;
  float alpha = 1.0;
  if (uKey > 0.5) {
    float r = rgb.r * 255.0;
    float g = rgb.g * 255.0;
    float b = rgb.b * 255.0;
    // Leave neutral, skin, and non-green pixels untouched.
    if (g > r && g > b) {
      float cb = -0.168736 * r - 0.331264 * g + 0.5 * b;
      float cr = 0.5 * r - 0.418688 * g - 0.081312 * b;
      float distance = length(vec2(cb + 84.47232, cr + 106.76544)) / 255.0;
      float edge = clamp((distance - uThreshold) / uSoftness, 0.0, 1.0);
      alpha = edge * edge * (3.0 - 2.0 * edge);
      rgb.g = (g - (g - max(r, b)) * uSpill * (1.0 - alpha * 0.5)) / 255.0;
    }
  }
  vec3 back = uFill;
  if (uHasBackground > 0.5)
    back = texture2D(uBackground, uv * uBackgroundScale + uBackgroundOffset).rgb;
  vec3 color = mix(back, rgb, alpha);
  if (uHasOverlay > 0.5) {
    vec4 overlay = texture2D(uOverlay, uv);
    color = mix(color, overlay.rgb, overlay.a);
  }
  gl_FragColor = vec4(color, 1.0);
}`;

const UNIFORMS = [
  "uSource", "uBackground", "uOverlay", "uSourceScale", "uSourceOffset", "uBackgroundScale",
  "uBackgroundOffset", "uMirror", "uKey", "uHasBackground", "uHasOverlay", "uFill", "uThreshold",
  "uSoftness", "uSpill",
] as const;
type UniformName = (typeof UNIFORMS)[number];

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

/** The visible fraction and offset of an image drawn to cover a frame, as drawCover crops it. */
function coverMapping(imageWidth: number, imageHeight: number, width: number, height: number) {
  const scale = Math.max(width / imageWidth, height / imageHeight);
  const fractionX = width / (imageWidth * scale);
  const fractionY = height / (imageHeight * scale);
  return { scale: [fractionX, fractionY], offset: [(1 - fractionX) / 2, (1 - fractionY) / 2] };
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Returns null when WebGL is unavailable, so the caller falls back to the 2D canvas path. */
export function createWebGLCompositor(canvas: HTMLCanvasElement): WebGLCompositor | null {
  if (typeof WebGLRenderingContext === "undefined") return null;
  const attributes: WebGLContextAttributes = {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    // Captures read the pixels back with toDataURL after drawing.
    preserveDrawingBuffer: true,
    premultipliedAlpha: false,
    powerPreference: "high-performance",
  };
  let gl: WebGLRenderingContext | null = null;
  try {
    gl = (canvas.getContext("webgl", attributes) ?? canvas.getContext("experimental-webgl", attributes)) as
      | WebGLRenderingContext
      | null;
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const context = gl;

  let program: WebGLProgram | null = null;
  let locations: Record<UniformName, WebGLUniformLocation | null> | null = null;
  let textures: { source: WebGLTexture; background: WebGLTexture; overlay: WebGLTexture } | null = null;
  let uploadedBackground: HTMLImageElement | null = null;
  let uploadedOverlay: HTMLImageElement | null = null;
  let lost = false;

  function createTexture(): WebGLTexture | null {
    const texture = context.createTexture();
    if (!texture) return null;
    context.bindTexture(context.TEXTURE_2D, texture);
    // Camera frames and photos are not powers of two, so clamp and skip mipmaps.
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);
    return texture;
  }

  function setup(): boolean {
    const vertex = compile(context, context.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(context, context.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!vertex || !fragment) return false;
    const linked = context.createProgram();
    if (!linked) return false;
    context.attachShader(linked, vertex);
    context.attachShader(linked, fragment);
    context.linkProgram(linked);
    if (!context.getProgramParameter(linked, context.LINK_STATUS) && !context.isContextLost()) return false;
    context.useProgram(linked);
    const buffer = context.createBuffer();
    context.bindBuffer(context.ARRAY_BUFFER, buffer);
    context.bufferData(context.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), context.STATIC_DRAW);
    const position = context.getAttribLocation(linked, "aPosition");
    context.enableVertexAttribArray(position);
    context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);
    const found = {} as Record<UniformName, WebGLUniformLocation | null>;
    for (const name of UNIFORMS) found[name] = context.getUniformLocation(linked, name);
    const source = createTexture();
    const background = createTexture();
    const overlay = createTexture();
    if (!source || !background || !overlay) return false;
    context.uniform1i(found.uSource, 0);
    context.uniform1i(found.uBackground, 1);
    context.uniform1i(found.uOverlay, 2);
    // Orientation is handled in the shader; see FRAGMENT_SHADER.
    context.pixelStorei(context.UNPACK_FLIP_Y_WEBGL, false);
    context.pixelStorei(context.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    context.pixelStorei(context.UNPACK_COLORSPACE_CONVERSION_WEBGL, context.NONE);
    context.disable(context.BLEND);
    context.disable(context.DEPTH_TEST);
    program = linked;
    locations = found;
    textures = { source, background, overlay };
    uploadedBackground = null;
    uploadedOverlay = null;
    return true;
  }

  const onLost = (event: Event) => {
    // Asking the browser to restore the context later keeps the booth running.
    event.preventDefault();
    lost = true;
    program = null;
  };
  const onRestored = () => {
    lost = !setup();
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  if (!setup()) {
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    return null;
  }

  function upload(unit: number, texture: WebGLTexture, image: TexImageSource) {
    context.activeTexture(context.TEXTURE0 + unit);
    context.bindTexture(context.TEXTURE_2D, texture);
    context.texImage2D(context.TEXTURE_2D, 0, context.RGBA, context.RGBA, context.UNSIGNED_BYTE, image);
  }

  return {
    draw({ source, sourceWidth, sourceHeight, width, height, settings, background, overlay }) {
      if (lost || !program || !locations || !textures || context.isContextLost()) return false;
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      context.viewport(0, 0, width, height);
      upload(0, textures.source, source);
      const useBackground = Boolean(background && settings.backgroundMode !== "off");
      if (useBackground && background && uploadedBackground !== background) {
        upload(1, textures.background, background);
        uploadedBackground = background;
      }
      if (overlay && uploadedOverlay !== overlay) {
        upload(2, textures.overlay, overlay);
        uploadedOverlay = overlay;
      }
      const camera = coverMapping(sourceWidth, sourceHeight, width, height);
      context.uniform2fv(locations.uSourceScale, camera.scale);
      context.uniform2fv(locations.uSourceOffset, camera.offset);
      if (useBackground && background) {
        const scene = coverMapping(background.naturalWidth || width, background.naturalHeight || height, width, height);
        context.uniform2fv(locations.uBackgroundScale, scene.scale);
        context.uniform2fv(locations.uBackgroundOffset, scene.offset);
      }
      context.uniform1f(locations.uMirror, settings.camera.mirror ? 1 : 0);
      context.uniform1f(locations.uKey, settings.backgroundMode === "green-screen" ? 1 : 0);
      context.uniform1f(locations.uHasBackground, useBackground ? 1 : 0);
      context.uniform1f(locations.uHasOverlay, overlay ? 1 : 0);
      // The same warm grey the 2D path paints behind a keyed subject without a scene.
      context.uniform3f(locations.uFill, 0xe9 / 255, 0xe5 / 255, 0xdc / 255);
      context.uniform1f(locations.uThreshold, clamp(settings.chroma.similarity, 0.01, 0.8));
      context.uniform1f(locations.uSoftness, clamp(settings.chroma.smoothness, 0.005, 0.5));
      context.uniform1f(locations.uSpill, clamp(settings.chroma.spill));
      context.drawArrays(context.TRIANGLE_STRIP, 0, 4);
      return true;
    },
    destroy() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      if (textures) {
        context.deleteTexture(textures.source);
        context.deleteTexture(textures.background);
        context.deleteTexture(textures.overlay);
      }
      if (program) context.deleteProgram(program);
      context.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
