/**
 * A slice of rising smoke, lit by a fanned sheet of light and drawn in ASCII,
 * behind the Queue, Models, Keys and Lending pages. The busier the node, the
 * thicker and quicker it rises.
 * WebGL2 in two passes: the first works out how bright the smoke is in each
 * character cell, the second draws each cell's glyph from a small atlas. No
 * WebGL2, no smoke; with reduced motion, one still frame. It takes no input.
 */
import { useEffect, useRef } from "react";
import { useStore } from "./store.js";

const RAMP = " .,:;-~=+*";
const CELL_W = 8;
const CELL_H = 14;
const FONT_PX = 12;
const GAIN = 2.1;
const STILL_T = 40;

const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.5-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 105.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
float fbm(vec3 p){float a=0.5,s=0.0;for(int i=0;i<4;i++){s+=a*snoise(p);p*=2.03;a*=0.5;}return s;}
`;

const VS = "#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}";

// One texel per cell: how bright the lit smoke is there, 0..1. uLoad (0..1) is how busy the node is.
const FS_DENSITY = `#version 300 es
precision highp float;
uniform vec2 uGrid; uniform vec2 uCell; uniform float uT; uniform float uRise; uniform float uLoad;
out vec4 o;
${NOISE}
void main(){
  vec2 c=vec2(gl_FragCoord.x,uGrid.y-gl_FragCoord.y);
  vec2 px=c*uCell; vec2 size=uGrid*uCell; float t=uT;
  vec3 p=vec3(px/340.0,t*0.03); p.y+=uRise;
  vec3 q=vec3(fbm(p+vec3(0.0,0.0,1.7)),fbm(p+vec3(5.2,1.3,2.8)),0.0);
  float n=fbm(p+1.8*q);
  float wisps=1.0-abs(fbm(p*1.7+q));
  float lo=mix(0.42,0.28,uLoad);
  float d=smoothstep(lo,0.9,n*0.65+0.45)*mix(0.45,1.0,wisps*wisps);
  vec2 v=px-vec2(-0.06*size.x,-0.18*size.y);
  float ang=atan(v.y,v.x);
  float aim=0.72+0.10*sin(t*0.21);
  float fan=1.0-smoothstep(0.22,0.5,abs(ang-aim));
  float ray=0.88+0.12*sin(ang*55.0+sin(t*0.5)*1.5);
  float r=length(v)/max(size.x,size.y); float fall=1.0/(1.0+r*r*1.1);
  float y=c.y/uGrid.y; float fade=smoothstep(0.0,0.05,y)*(1.0-smoothstep(0.75,1.0,y));
  o=vec4(d*fan*ray*fall*fade*mix(0.75,1.15,uLoad),0.0,0.0,1.0);
}`;

// Every pixel: which cell it is in, that cell's glyph from the atlas, in the page's greys.
const FS_GLYPH = `#version 300 es
precision mediump float;
uniform sampler2D uDensity; uniform sampler2D uAtlas; uniform vec2 uCellDev; uniform float uCanvasH;
uniform float uN; uniform float uGain; uniform vec3 uDim; uniform vec3 uHot; uniform float uAlpha;
out vec4 o;
void main(){
  vec2 f=vec2(gl_FragCoord.x,uCanvasH-gl_FragCoord.y);
  ivec2 cell=ivec2(floor(f/uCellDev)); ivec2 sz=textureSize(uDensity,0);
  float b=texelFetch(uDensity,ivec2(cell.x,sz.y-1-cell.y),0).r;
  float g=floor(clamp(b*uGain,0.0,0.999)*uN);
  if(g<1.0) discard;
  vec2 inC=fract(f/uCellDev);
  float a=texture(uAtlas,vec2((g+inC.x)/uN,inC.y)).a;
  float alpha=a*uAlpha*(0.35+0.65*clamp(b*uGain,0.0,1.0));
  vec3 col=mix(uDim,uHot,smoothstep(0.2,0.7,b*uGain));
  o=vec4(col*alpha,alpha);
}`;

type Program = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

function program(gl: WebGL2RenderingContext, fs: string): Program {
  const p = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
    gl.attachShader(p, sh);
  }
  gl.bindAttribLocation(p, 0, "p");
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  const u: Program["u"] = {};
  for (let i = 0, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number; i < n; i++) {
    const name = gl.getActiveUniform(p, i)!.name;
    u[name] = gl.getUniformLocation(p, name);
  }
  return { p, u };
}

/** The smoke behind a page: as busy as the node is, counting a backlog of twice its slots as full. */
export function NodeSmoke() {
  const jobs = useStore((s) => s.data?.q.jobs.length ?? 0);
  const slots = useStore((s) => s.data?.q.capacity.slots ?? 1);
  return <Smoke load={jobs / Math.max(4, slots * 2)} />;
}

/** `load` is how busy the node is, 0 for idle to 1 for a full queue; it eases, so a burst does not jolt. */
function Smoke({ load }: { load: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const target = useRef(load);
  target.current = Math.max(0, Math.min(1, load));

  useEffect(() => {
    const canvas = ref.current;
    const zone = canvas?.parentElement;
    const gl = canvas?.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false });
    if (!canvas || !zone || !gl) return;
    let pD: Program, pG: Program;
    try { pD = program(gl, FS_DENSITY); pG = program(gl, FS_GLYPH); } catch { return; }
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const texture = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      for (const k of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, k, gl.NEAREST);
      for (const k of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D, k, gl.CLAMP_TO_EDGE);
      return t;
    };
    const density = texture(), atlas = texture();
    const fb = gl.createFramebuffer();
    let cols = 1, rows = 1, cw = 1, ch = 1, dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      cw = Math.max(1, Math.round(CELL_W * dpr));
      ch = Math.max(1, Math.round(CELL_H * dpr));
      canvas.width = Math.max(1, Math.round(zone.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(zone.clientHeight * dpr));
      cols = Math.ceil(canvas.width / cw);
      rows = Math.ceil(canvas.height / ch);
      gl.bindTexture(gl.TEXTURE_2D, density);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, density, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      // The glyphs, white on transparent: only alpha is read.
      const a = document.createElement("canvas");
      a.width = cw * RAMP.length;
      a.height = ch;
      const x = a.getContext("2d")!;
      x.fillStyle = "#fff";
      x.font = `${Math.round(FONT_PX * dpr)}px ${getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace"}`;
      x.textAlign = "center";
      x.textBaseline = "middle";
      for (let i = 1; i < RAMP.length; i++) x.fillText(RAMP[i]!, i * cw + cw / 2, ch / 2 + dpr);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a);
    };

    // The theme's own greys, as 0..1 RGB: the thin smoke in --dim, the dense halfway to --fg.
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    probe.canvas.width = probe.canvas.height = 1;
    const rgb = (css: string): [number, number, number] => {
      probe.clearRect(0, 0, 1, 1);
      probe.fillStyle = "#000";
      probe.fillStyle = css;
      probe.fillRect(0, 0, 1, 1);
      const d = probe.getImageData(0, 0, 1, 1).data;
      return [d[0]! / 255, d[1]! / 255, d[2]! / 255];
    };
    let dim: [number, number, number] = [0.5, 0.5, 0.5], hot = dim, alpha = 0.4;
    const colours = () => {
      const s = getComputedStyle(document.documentElement);
      dim = rgb(s.getPropertyValue("--dim").trim());
      const fg = rgb(s.getPropertyValue("--fg").trim());
      hot = [0, 1, 2].map((i) => dim[i]! + (fg[i]! - dim[i]!) * 0.55) as [number, number, number];
      const bg = rgb(s.getPropertyValue("--bg").trim());
      alpha = (bg[0] + bg[1] + bg[2]) / 3 < 0.5 ? 0.42 : 0.34;
    };

    let load = target.current, rise = 0, lastT = 0;
    const draw = (t: number) => {
      // Ease toward the queue's load, and let the smoke climb faster the busier it is.
      const dt = lastT ? Math.min(0.1, t - lastT) : 0;
      lastT = t;
      load += (target.current - load) * Math.min(1, dt * 1.5);
      rise += dt * (0.05 + 0.09 * load);
      gl.bindVertexArray(vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, cols, rows);
      gl.useProgram(pD.p);
      gl.uniform2f(pD.u.uGrid!, cols, rows);
      gl.uniform2f(pD.u.uCell!, cw / dpr, ch / dpr);
      gl.uniform1f(pD.u.uT!, t);
      gl.uniform1f(pD.u.uRise!, still ? STILL_T * 0.05 : rise);
      gl.uniform1f(pD.u.uLoad!, load);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(pG.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, density);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.uniform1i(pG.u.uDensity!, 0);
      gl.uniform1i(pG.u.uAtlas!, 1);
      gl.uniform2f(pG.u.uCellDev!, cw, ch);
      gl.uniform1f(pG.u.uCanvasH!, canvas.height);
      gl.uniform1f(pG.u.uN!, RAMP.length);
      gl.uniform1f(pG.u.uGain!, GAIN);
      gl.uniform3fv(pG.u.uDim!, dim);
      gl.uniform3fv(pG.u.uHot!, hot);
      gl.uniform1f(pG.u.uAlpha!, alpha);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // About 30 frames a second, and nothing while the tab is hidden.
    let raf = 0, last = 0;
    const frame = (now: number) => {
      raf = 0;
      if (document.hidden) return;
      if (now - last >= 33) { last = now; draw(now / 1000); }
      raf = requestAnimationFrame(frame);
    };
    const wake = () => { if (still) draw(STILL_T); else if (!raf && !document.hidden) raf = requestAnimationFrame(frame); };
    const redraw = () => { if (still) draw(STILL_T); };

    resize();
    colours();
    wake();
    const sized = new ResizeObserver(() => { resize(); redraw(); });
    sized.observe(zone);
    // The theme toggle flips a class on <html>; the colours follow it.
    const themed = new MutationObserver(() => { colours(); redraw(); });
    themed.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", wake);
    return () => {
      cancelAnimationFrame(raf);
      sized.disconnect();
      themed.disconnect();
      document.removeEventListener("visibilitychange", wake);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />;
}
