// The TIER-1 BROWSER COMPOSITOR — a WebGL2 implementation of `renderFrame(ir,
// frame)` (DESIGN-LIVE-PREVIEW.md §4, §6 Tier 1, §7).
//
// This is the read-side mirror of the serializer's track walk, EVALUATED AT A
// FRAME and drawn to pixels instead of emitted as XML. Given the resolved z-stack
// (`resolveLayers`), it composites every layer onto one canvas in track z-order,
// with the exact §7 service mapping:
//   • a `color` clip            → a solid-fill quad (NOT decoded)               [exact]
//   • a footage clip            → a textured quad, over-composited with opacity  [exact]
//   • a same-track `dissolve`   → `gl-transitions` fade/luma between from+to     [exact]
//   • per-clip fade / opacity   → multiply the layer alpha (resolved upstream)   [exact]
// The `@remotion/player` overlay draws ON TOP of this canvas (transparent regions
// reveal the composite) — two compositors, one editor track (§4, the Remotion
// seam). `approximate` services (blur/frei0r/non-default blend) are flagged for an
// optional on-demand `melt` still (§6.3); this compositor renders their footage
// without the unmatched effect (preview shows FEWER effects than the exact export
// — the honest §8.4 posture).
//
// ── WHY RAW WebGL2, NOT PIXI ─────────────────────────────────────────────────
// The doc is explicit (§6 Tier 1): keep vean in TypeScript, do NOT adopt a heavy
// engine; port the *discipline* (z-order, decoded-frame textures keyed by source
// identity, gl-transitions shaders) not the framework. This is ~one stage, one
// quad, a handful of programs — a dependency-free WebGL2 module.
//
// ── LIFETIME (§8.3 — the dominant failure mode) ──────────────────────────────
// This compositor does NOT own decoded `ImageBitmap`s. The caller (FootageStage)
// owns the decode cache + its `close()`-on-evict discipline. The compositor only
// uploads a bitmap to a GL texture per draw; GL textures it creates (the two
// render targets for dissolves, the per-draw upload texture) are reused across
// frames and freed on `dispose()`. No bitmap is retained after `composite()`.
//
// ── COLORSPACE CAVEAT (§8.1) ─────────────────────────────────────────────────
// This is the fast/approximate path; it is NOT bit-identical to `melt` (different
// scalers, YUV→RGB matrices, range). Preview is for judgment; `melt` is ground
// truth. We composite straight sRGB over premultiplied alpha — good enough for the
// live loop, never asserted against export pixels.
import type { DissolveLayer, FootageLayer, Layer, SolidLayer } from "../resolveLayers";

/** A source a footage layer's frame comes from — either a decoded bitmap or any
 *  canvas-image source the compositor can `texImage2D`. `null` = decode pending /
 *  failed (the layer is skipped, the layer below shows through). */
export type FrameImage =
  | ImageBitmap
  | HTMLCanvasElement
  | OffscreenCanvas
  | HTMLVideoElement
  | null;

/** The compositor pulls each footage layer's pixels through this callback (so the
 *  cache/decode policy lives in the caller, §8.3). Synchronous: the caller has
 *  already awaited the decode and hands the compositor a ready image (or null). */
export type FootageProvider = (layer: FootageLayer) => FrameImage;

// ─── GLSL ────────────────────────────────────────────────────────────────────
// One full-screen-quad vertex shader, reused by every program. `aPos` is a unit
// quad in clip space; `vUv` is 0..1 with V flipped so texture row 0 is the top
// (canvas/bitmap origin is top-left; GL texture origin is bottom-left).
const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/** Solid-color fill (a `color` clip — §7 exact). `uColor` is premultiplied-alpha
 *  straight RGBA; `uOpacity` scales alpha for fades. */
const FRAG_SOLID = `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec4 uColor;
uniform float uOpacity;
out vec4 fragColor;
void main() {
  float a = uColor.a * uOpacity;
  fragColor = vec4(uColor.rgb * a, a); // premultiplied
}`;

/** Textured footage layer — over-composite with opacity. `fit: contain` is done in
 *  the decode sink, so the texture already matches the box; we sample 1:1. */
const FRAG_TEX = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
out vec4 fragColor;
void main() {
  vec4 c = texture(uTex, vUv);
  float a = c.a * uOpacity;
  fragColor = vec4(c.rgb * a, a); // premultiplied over-composite
}`;

// The gl-transitions wrapper. We adapt the project's GLSL (which defines a
// `transition(vec2 uv)` returning the blended color) by providing `getFromColor`
// / `getToColor` + the `progress`/`ratio` uniforms it expects. `from`/`to` are the
// two RENDER TARGETS (outgoing/incoming) the dissolve cross-fades (omniclip
// `transition-manager.ts:179` `#fragmentShader`).
function dissolveFrag(transitionGlsl: string): string {
  return `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D from, to;
uniform float progress, ratio;
uniform sampler2D luma; // bound for the luma transition; ignored by fade
out vec4 fragColor;
vec4 getFromColor(vec2 uv){ return texture(from, uv); }
vec4 getToColor(vec2 uv){ return texture(to, uv); }
${transitionGlsl}
void main(){
  fragColor = transition(vUv);
}`;
}

// gl-transitions/transitions/fade.glsl — `mix(from,to,progress)` (MIT, gre). The
// MLT `luma` dissolve with no luma file is exactly this (§7 row 1).
const FADE_GLSL = `vec4 transition (vec2 uv) {
  return mix(getFromColor(uv), getToColor(uv), progress);
}`;

// gl-transitions/transitions/luma.glsl — a matte wipe driven by a luma texture
// (MIT, gre). For a luma-FILE dissolve (§7 row 2). Unused for the default `luma`
// (no file) demo dissolve, but wired so a luma-matte dissolve is exact too.
const LUMA_GLSL = `vec4 transition(vec2 uv) {
  return mix(getToColor(uv), getFromColor(uv), step(progress, texture(luma, uv).r));
}`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("createShader failed");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader compile: ${log}`);
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vert: string, frag: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vert);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, frag);
  const prog = gl.createProgram();
  if (!prog) throw new Error("createProgram failed");
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`program link: ${log}`);
  }
  return prog;
}

/** Parse a vean color resource (`#RRGGBB`, `#AARRGGBB`, or a CSS/named color) to
 *  straight RGBA 0..1. vean's `color` resources are `#AARRGGBB` (alpha FIRST,
 *  Shotcut/MLT convention — `src/ir/builder.ts mltColor`); a 6-digit hex is opaque
 *  RGB; anything else is resolved via a scratch 2D canvas (named CSS colors). */
function parseColor(resource: string): [number, number, number, number] {
  const s = resource.trim();
  const hex = s.startsWith("#") ? s.slice(1) : null;
  if (hex && /^[0-9a-fA-F]{8}$/.test(hex)) {
    // #AARRGGBB (MLT order: alpha, red, green, blue).
    const a = Number.parseInt(hex.slice(0, 2), 16) / 255;
    const r = Number.parseInt(hex.slice(2, 4), 16) / 255;
    const g = Number.parseInt(hex.slice(4, 6), 16) / 255;
    const b = Number.parseInt(hex.slice(6, 8), 16) / 255;
    return [r, g, b, a];
  }
  if (hex && /^[0-9a-fA-F]{6}$/.test(hex)) {
    return [
      Number.parseInt(hex.slice(0, 2), 16) / 255,
      Number.parseInt(hex.slice(2, 4), 16) / 255,
      Number.parseInt(hex.slice(4, 6), 16) / 255,
      1,
    ];
  }
  // Named / functional CSS color — resolve once via a scratch canvas.
  return resolveNamedColor(s);
}

let scratchCtx: CanvasRenderingContext2D | null = null;
function resolveNamedColor(css: string): [number, number, number, number] {
  if (!scratchCtx) {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    scratchCtx = c.getContext("2d", { willReadFrequently: true });
  }
  if (!scratchCtx) return [0, 0, 0, 1];
  scratchCtx.clearRect(0, 0, 1, 1);
  scratchCtx.fillStyle = "#000";
  scratchCtx.fillStyle = css; // invalid → stays #000
  scratchCtx.fillRect(0, 0, 1, 1);
  const d = scratchCtx.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
}

/** A reusable GL render target (texture + framebuffer) at the canvas size. */
interface RenderTarget {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  width: number;
  height: number;
}

export class GlCompositor {
  private gl: WebGL2RenderingContext;
  private quad: WebGLBuffer;
  private vao: WebGLVertexArrayObject;
  private progSolid: WebGLProgram;
  private progTex: WebGLProgram;
  private progFade: WebGLProgram;
  private progLuma: WebGLProgram;
  /** A single texture object reused for every footage upload (re-`texImage2D`'d
   *  per draw — one GPU allocation, not one per frame; §8.3 bounded VRAM). */
  private uploadTex: WebGLTexture;
  /** Two render targets for the dissolve from/to passes (allocated lazily, resized
   *  with the canvas). */
  private rtFrom: RenderTarget | null = null;
  private rtTo: RenderTarget | null = null;
  private width = 0;
  private height = 0;

  constructor(private canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", {
      premultipliedAlpha: true,
      alpha: true,
      antialias: false,
      preserveDrawingBuffer: true, // so toDataURL/readPixels after a draw is stable
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.progSolid = linkProgram(gl, VERT, FRAG_SOLID);
    this.progTex = linkProgram(gl, VERT, FRAG_TEX);
    this.progFade = linkProgram(gl, VERT, dissolveFrag(FADE_GLSL));
    this.progLuma = linkProgram(gl, VERT, dissolveFrag(LUMA_GLSL));

    // One unit-quad (two triangles) shared by every program via a VAO.
    const buf = gl.createBuffer();
    if (!buf) throw new Error("createBuffer failed");
    this.quad = buf;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // prettier-ignore
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("createVertexArray failed");
    this.vao = vao;
    gl.bindVertexArray(vao);
    // aPos is location 0 in every program (only attribute).
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const t = gl.createTexture();
    if (!t) throw new Error("createTexture failed");
    this.uploadTex = t;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /** Size the drawing buffer (idempotent). Call before `composite` when the box
   *  changes; re-allocates the dissolve render targets to match. */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    // Drop stale render targets so the next dissolve re-allocates at the new size.
    if (this.rtFrom) this.freeTarget(this.rtFrom);
    if (this.rtTo) this.freeTarget(this.rtTo);
    this.rtFrom = null;
    this.rtTo = null;
  }

  private ensureTarget(slot: "from" | "to"): RenderTarget {
    const existing = slot === "from" ? this.rtFrom : this.rtTo;
    if (existing && existing.width === this.width && existing.height === this.height)
      return existing;
    if (existing) this.freeTarget(existing);
    const gl = this.gl;
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error("render target alloc failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      this.width,
      this.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const rt = { fbo, tex, width: this.width, height: this.height };
    if (slot === "from") this.rtFrom = rt;
    else this.rtTo = rt;
    return rt;
  }

  private freeTarget(rt: RenderTarget): void {
    this.gl.deleteTexture(rt.tex);
    this.gl.deleteFramebuffer(rt.fbo);
  }

  /** Upload an image to `uploadTex` (reused). Top-left origin: the vertex shader
   *  flips V, so we keep FLIP_Y off and let the UV handle orientation. */
  private uploadImage(img: Exclude<FrameImage, null>): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.uploadTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img as TexImageSource);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Draw a SOLID color quad (premultiplied) into the bound framebuffer. */
  private drawSolid(color: [number, number, number, number], opacity: number): void {
    const gl = this.gl;
    gl.useProgram(this.progSolid);
    gl.bindVertexArray(this.vao);
    gl.uniform4f(
      gl.getUniformLocation(this.progSolid, "uColor"),
      color[0],
      color[1],
      color[2],
      color[3],
    );
    gl.uniform1f(gl.getUniformLocation(this.progSolid, "uOpacity"), opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Draw the currently-uploaded texture quad (premultiplied over-composite). */
  private drawTex(opacity: number): void {
    const gl = this.gl;
    gl.useProgram(this.progTex);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.uploadTex);
    gl.uniform1i(gl.getUniformLocation(this.progTex, "uTex"), 0);
    gl.uniform1f(gl.getUniformLocation(this.progTex, "uOpacity"), opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Render ONE sub-layer (solid or footage) into the bound framebuffer at full
   *  opacity (the dissolve's own opacity governs the blend). Returns false if a
   *  footage frame wasn't available (the target keeps the clear color). */
  private renderSubLayer(layer: SolidLayer | FootageLayer, footage: FootageProvider): boolean {
    const gl = this.gl;
    gl.disable(gl.BLEND); // sub-layer fills its whole target opaque-ish
    if (layer.kind === "solid") {
      this.drawSolid(parseColor(layer.color), 1);
      return true;
    }
    const img = footage(layer);
    if (!img) return false;
    this.uploadImage(img);
    this.drawTex(1);
    return true;
  }

  /** Composite a same-track dissolve: render outgoing → rtFrom, incoming → rtTo,
   *  then run the gl-transitions shader into the MAIN framebuffer with the layer's
   *  z-blend (the result over-composites on the accumulation below). */
  private compositeDissolve(layer: DissolveLayer, footage: FootageProvider): void {
    const gl = this.gl;
    const from = this.ensureTarget("from");
    const to = this.ensureTarget("to");

    // Pass 1: outgoing → rtFrom (cleared to its color so a missing footage frame
    // doesn't bleed garbage).
    gl.bindFramebuffer(gl.FRAMEBUFFER, from.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.renderSubLayer(layer.from, footage);

    // Pass 2: incoming → rtTo.
    gl.bindFramebuffer(gl.FRAMEBUFFER, to.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.renderSubLayer(layer.to, footage);

    // Pass 3: blend into the main framebuffer (over the accumulation below).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const useLuma = layer.service !== "luma" && layer.service !== "dissolve";
    const prog = useLuma ? this.progLuma : this.progFade;
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied over
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.tex);
    gl.uniform1i(gl.getUniformLocation(prog, "from"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, to.tex);
    gl.uniform1i(gl.getUniformLocation(prog, "to"), 1);
    if (useLuma) {
      // No luma-FILE plumbing in this path yet — bind `to` as a stand-in so the
      // sampler is valid; the default `luma` (no file) takes the fade path above.
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, to.tex);
      gl.uniform1i(gl.getUniformLocation(prog, "luma"), 2);
    }
    gl.uniform1f(gl.getUniformLocation(prog, "progress"), layer.progress);
    gl.uniform1f(
      gl.getUniformLocation(prog, "ratio"),
      this.height === 0 ? 1 : this.width / this.height,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Composite the resolved z-stack onto the canvas. Clears to black, then draws
   * each layer BOTTOM-UP, over-compositing with its resolved opacity. After this
   * returns the canvas holds the footage frame; the `@remotion/player` overlay (a
   * separate DOM layer) draws on top.
   */
  composite(layers: Layer[]): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 1); // opaque black base (MLT's background producer)
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied over

    for (const layer of layers) {
      if (layer.kind === "dissolve") {
        this.compositeDissolve(layer, this.footage);
        // Restore the main-FBO blend state the dissolve's pass-3 set (it left
        // BLEND on with the over func — good — but rebind the main FBO/viewport).
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.width, this.height);
        continue;
      }
      gl.enable(gl.BLEND);
      if (layer.kind === "solid") {
        this.drawSolid(parseColor(layer.color), layer.opacity);
      } else {
        const img = this.footage(layer);
        if (!img) continue; // decode pending — the layer below shows through
        this.uploadImage(img);
        this.drawTex(layer.opacity);
      }
    }
    gl.flush();
  }

  /** The footage provider for the CURRENT composite call (set transiently). */
  private footage: FootageProvider = () => null;

  /** Composite with a footage provider (the caller's decode cache). */
  render(layers: Layer[], footage: FootageProvider): void {
    this.footage = footage;
    try {
      this.composite(layers);
    } finally {
      this.footage = () => null;
    }
  }

  /** Read the composited canvas back as RGBA bytes (for headless pixel assertions
   *  + the still-compare gate). `[r,g,b,a]` at the given canvas pixel. */
  readPixel(x: number, y: number): [number, number, number, number] {
    const gl = this.gl;
    const out = new Uint8Array(4);
    // GL origin is bottom-left; flip Y to a top-left coordinate the caller expects.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, this.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
    // Un-premultiply for an intuitive readout (alpha 255 → no change).
    const a = out[3] / 255;
    const un = (c: number) => (a > 0 ? Math.min(255, Math.round(c / a)) : c);
    return [un(out[0]), un(out[1]), un(out[2]), out[3]];
  }

  dispose(): void {
    const gl = this.gl;
    if (this.rtFrom) this.freeTarget(this.rtFrom);
    if (this.rtTo) this.freeTarget(this.rtTo);
    gl.deleteTexture(this.uploadTex);
    gl.deleteBuffer(this.quad);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.progSolid);
    gl.deleteProgram(this.progTex);
    gl.deleteProgram(this.progFade);
    gl.deleteProgram(this.progLuma);
  }
}
