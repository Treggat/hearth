/**
 * A slice of rising smoke, lit by a fanned sheet of light and drawn in ASCII,
 * behind the Queue, Models, Keys and Lending pages. The busier the node, the
 * thicker and quicker it rises, the warmer the coals glow under it, and the
 * more embers come off them.
 * WebGL2 in two passes: the first works out, for each character cell, how
 * bright the lit smoke is, how hot the coals are and whether an ember is
 * passing; the second draws each cell's glyph from a small atlas, the smoke
 * in the page's greys warmed by the fire, the coals and embers in its colours.
 * The node's name seeds it, so every node burns its own way and the same way
 * each time. No WebGL2, no smoke; with reduced motion, one still frame. It
 * takes no input.
 */
import { useEffect, useRef } from "react";
import { fire, seedOf } from "./fire.js";
import { useStore } from "./store.js";

// Least ink first. The smoke is punctuation only: anything heavier clumps into blocks where it is
// dense and fights the page, and a dash reads as a ruled line. The fire ends in two shades, so
// only its hottest cells go solid.
const SMOKE = " ·,:;~=+*";
const FIRE = " ·,:;~=+*░▒";
// An ember's glyph by age, least ink first: a round spark as it leaves the coals, hollow as it
// cools, a speck as it goes out.
const EMBER = "·◦*•";
// The faintest step of either ramp is a speck high, mid or low in its cell, picked per cell, so
// thin haze does not line up in rows.
const SPECK = "˙·.";
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
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
`;

const VS = "#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}";

// One texel per cell, all 0..1: r = the sheet-lit smoke, g = the fire-lit smoke, b = an ember's
// brightness and a = its age, or the cell's heat with no ember passing. uLoad is how busy the node
// is, uHeat and uEmbers its fire, uSeed the node's own noise slice, light, flicker, coals and embers.
const FS_DENSITY = `#version 300 es
precision highp float;
uniform vec2 uGrid; uniform vec2 uCell; uniform float uT; uniform float uRise; uniform float uLoad;
uniform float uHeat; uniform float uEmbers; uniform vec4 uSeed;
out vec4 o;
${NOISE}
const float LANE=5.0; const float LIFE=4.0; const float CYCLE=4.6; const float CLIMB=9.0;
void main(){
  vec2 c=vec2(gl_FragCoord.x,uGrid.y-gl_FragCoord.y);
  vec2 px=c*uCell; vec2 size=uGrid*uCell; float t=uT;
  // Embers: every LANE cells may send one up each CYCLE, on its own phase; it climbs, drifts and
  // cools over LIFE, the cells it just passed keep a fainter speck each, and it lifts the smoke
  // around it and in a wake below. Only uEmbers of the chances are taken: idle sends a stray one.
  float ember=0.0, age=0.0, lift=0.0;
  float lane0=floor(c.x/LANE);
  for(int i=-1;i<=1;i++){
    float lane=lane0+float(i);
    float tt=t+hash(vec2(lane,7.0+uSeed.x*100.0))*CYCLE;
    float cyc=floor(tt/CYCLE);
    float born=tt-cyc*CYCLE;
    if(born>LIFE||hash(vec2(lane,cyc)+uSeed.yz*50.0)>uEmbers) continue;
    float h=hash(vec2(cyc,lane)+uSeed.wx*50.0);
    float u=born/LIFE;
    float climb=CLIMB*(0.7+0.6*h)*(0.85+0.3*uSeed.y), wander=0.8+1.4*uSeed.z;
    for(int k=0;k<4;k++){
      float ago=born-float(k)*0.12;
      if(ago<0.0) break;
      float ex=(lane+h)*LANE+sin(ago*(2.0+2.0*h)+h*6.28)*wander;
      float ey=uGrid.y-0.5-h*3.0-ago*climb;
      if(k==0){
        float dx=c.x+0.5-ex, dy=c.y+0.5-ey;
        float w=exp(-dx*dx/6.0)*(dy>0.0?exp(-dy*dy/40.0):exp(-dy*dy/2.0));
        lift+=0.12*w*(1.0-u);
      }
      if(floor(ex)!=floor(c.x)||floor(ey)!=floor(c.y)) continue;
      float keep=k==0?1.0:0.4*pow(0.55,float(k-1));
      float b=keep*(1.0-u)*(0.8+0.2*sin(t*13.0+h*20.0));
      if(b>ember){ember=b;age=k==0?u:1.0;}
      break;
    }
  }
  vec3 p=vec3(px/340.0+uSeed.xy*37.0,t*0.03+uSeed.z*11.0); p.y+=uRise+lift;
  vec3 q=vec3(fbm(p+vec3(0.0,0.0,1.7)),fbm(p+vec3(5.2,1.3,2.8)),0.0);
  float n=fbm(p+1.8*q);
  float wisps=1.0-abs(fbm(p*1.7+q));
  float lo=mix(0.42,0.28,uLoad);
  float d=smoothstep(lo,0.9,n*0.65+0.45)*mix(0.45,1.0,wisps*wisps);
  vec2 v=px-vec2(-0.06*size.x,-0.18*size.y);
  float ang=atan(v.y,v.x);
  float aim=0.72+0.10*sin(t*0.21)+(uSeed.x-0.5)*0.3;
  // A bright core, then a dim tail that fades over a wide angle: no hard shadow beside the sheet.
  float off=abs(ang-aim);
  float fan=mix(0.22,1.0,1.0-smoothstep(0.22,0.5+(uSeed.y-0.5)*0.2,off))*(1.0-smoothstep(0.8,1.6,off));
  float ray=0.88+0.12*sin(ang*55.0+sin(t*0.5)*1.5);
  float r=length(v)/max(size.x,size.y); float fall=1.0/(1.0+r*r*1.1);
  float y=c.y/uGrid.y;
  // The bottom fade lifts as the fire builds, so dense smoke sits right over the coals.
  float fade=smoothstep(0.0,0.05,y)*(1.0-smoothstep(0.75,1.0,y)*(1.0-0.6*uLoad));
  float smoke=d*fan*ray*fall*fade*mix(0.75,1.15,uLoad);
  // The coals: a band along the bottom edge, patchy with a slow noise of its own, flickering.
  float band=smoothstep(0.45,1.0,y); band*=band;
  float spots=0.55+0.45*(0.5+0.5*snoise(vec3(px.x/150.0+uSeed.w*50.0,px.y/70.0,t*0.07)));
  float flick=0.86+0.14*sin(t*(6.0+2.6*uSeed.z))*sin(t*(2.4+1.4*uSeed.w));
  float heat=band*spots*flick*uHeat;
  // The fire lights the smoke from below: the wisps nearest the coals take its colour.
  float glow=d*heat*0.8;
  o=vec4(smoke,glow,ember,ember>0.0?age:heat);
}`;

// Every pixel: which cell it is in and that cell's glyph from the atlas, in the page's greys where
// the sheet of light reaches it and in the fire's colours, red through orange to the tip, where
// the coals light it from below; an ember passing draws its glyph over either.
const FS_GLYPH = `#version 300 es
precision highp float;
uniform sampler2D uDensity; uniform sampler2D uAtlas; uniform vec2 uCellDev; uniform float uCanvasH;
uniform float uN; uniform float uNSmoke; uniform float uNFire; uniform float uNEmber; uniform float uNSpeck; uniform float uGain; uniform float uAlpha;
uniform vec3 uDim; uniform vec3 uHot; uniform vec3 uRed; uniform vec3 uOrange; uniform vec3 uTip;
out vec4 o;
vec3 fireOf(float h){vec3 c=mix(uRed,uOrange,smoothstep(0.0,0.55,h));return mix(c,uTip,smoothstep(0.6,1.0,h));}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
void main(){
  vec2 f=vec2(gl_FragCoord.x,uCanvasH-gl_FragCoord.y);
  ivec2 cell=ivec2(floor(f/uCellDev)); ivec2 sz=textureSize(uDensity,0);
  vec4 d=texelFetch(uDensity,ivec2(cell.x,sz.y-1-cell.y),0);
  vec2 inC=fract(f/uCellDev);
  float gi; vec3 col; float a;
  if(d.b>0.0){
    // An ember leaves the coals orange and cools to red; it never reaches the tip's yellow.
    gi=uNSmoke+uNFire+floor((1.0-d.a)*(uNEmber-1.0)+0.5);
    col=fireOf(0.5-0.4*d.a);
    a=d.b*0.9;
  } else {
    // The brighter of the two lights picks the glyph, from its own ramp; the cell's colour is
    // as much the fire's as the fire's share of its light.
    float s=clamp(d.r*uGain,0.0,1.0);
    float g=clamp(d.g*uGain,0.0,1.0);
    bool lit=g>s;
    float lvl=lit?g:s, n=lit?uNFire:uNSmoke, base=lit?uNSmoke:0.0;
    float step=floor(min(lvl,0.999)*n);
    if(step<1.0) discard;
    gi=step>1.0?base+step:uNSmoke+uNFire+uNEmber+floor(hash(vec2(cell))*uNSpeck);
    float warm=g/max(lvl,0.001);
    vec3 grey=mix(uDim,uHot,smoothstep(0.2,0.7,s));
    col=mix(grey,fireOf(d.a),warm);
    a=uAlpha*(0.35+0.65*lvl)*(1.0+0.5*warm);
  }
  float alpha=texture(uAtlas,vec2((gi+inC.x)/uN,inC.y)).a*a;
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

/** The smoke behind a page: as busy as the node is, counting a backlog of twice its slots as full, and seeded by its name. */
export function NodeSmoke() {
  const jobs = useStore((s) => s.data?.q.jobs.length ?? 0);
  const slots = useStore((s) => s.data?.q.capacity.slots ?? 1);
  const name = useStore((s) => s.data?.net.nodes.find((n) => n.self)?.name ?? "");
  return <Smoke load={jobs / Math.max(4, slots * 2)} seed={seedOf(name)} />;
}

/**
 * `load` is how busy the node is, 0 for idle to 1 for a full queue; it eases, so a burst does not
 * jolt. `seed` is the node's own four numbers in [0, 1).
 */
function Smoke({ load, seed }: { load: number; seed: [number, number, number, number] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const target = useRef(load);
  target.current = Math.max(0, Math.min(1, load));
  const own = useRef(seed);
  own.current = seed;

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
    const GLYPHS = SMOKE + FIRE + EMBER + SPECK;

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
      // The glyphs, white on transparent: only alpha is read. The smoke's and the fire's ramps go in
      // by their ink as this font draws it, least first, so every step is a step up in tone; the
      // ember's by age; the specks last.
      const a = document.createElement("canvas");
      a.width = cw * GLYPHS.length;
      a.height = ch;
      const x = a.getContext("2d", { willReadFrequently: true })!;
      x.fillStyle = "#fff";
      x.font = `${Math.round(FONT_PX * dpr)}px ${getComputedStyle(document.documentElement).getPropertyValue("--font-mono") || "monospace"}`;
      x.textAlign = "center";
      x.textBaseline = "middle";
      const ink = (g: string) => {
        x.clearRect(0, 0, cw, ch);
        x.fillText(g, cw / 2, ch / 2 + dpr);
        const d = x.getImageData(0, 0, cw, ch).data;
        let s = 0;
        for (let i = 3; i < d.length; i += 4) s += d[i]!;
        return s;
      };
      const byInk = (set: string) => [...set].map((g) => [g, ink(g)] as const).sort((p, q) => p[1] - q[1]).map((p) => p[0]).join("");
      const glyphs = byInk(SMOKE) + byInk(FIRE) + EMBER + SPECK;
      x.clearRect(0, 0, a.width, a.height);
      for (let i = 1; i < glyphs.length; i++) x.fillText(glyphs[i]!, i * cw + cw / 2, ch / 2 + dpr);
      gl.bindTexture(gl.TEXTURE_2D, atlas);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a);
    };

    // The theme's own colours, as 0..1 RGB: the thin smoke in --dim, the dense halfway to --fg,
    // and the fire from --bad through the ember accent to --warn.
    const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    probe.canvas.width = probe.canvas.height = 1;
    // A colour the canvas cannot read leaves the sentinel in place; that, or an empty
    // variable, gives the fallback, so a missing theme colour never draws invisible smoke.
    const SENTINEL = "#010203";
    const rgb = (css: string, fallback: [number, number, number]): [number, number, number] => {
      if (!css) return fallback;
      probe.fillStyle = SENTINEL;
      probe.fillStyle = css;
      if (probe.fillStyle === SENTINEL) return fallback;
      probe.clearRect(0, 0, 1, 1);
      probe.fillRect(0, 0, 1, 1);
      const d = probe.getImageData(0, 0, 1, 1).data;
      return [d[0]! / 255, d[1]! / 255, d[2]! / 255];
    };
    type RGB = [number, number, number];
    const GREY: RGB = [0.55, 0.55, 0.55];
    let dim = GREY, hot = GREY, alpha = 0.4;
    let red: RGB = [0.72, 0.25, 0.2], orange: RGB = [0.9, 0.5, 0.2], tip: RGB = [0.95, 0.75, 0.4];
    const colours = () => {
      const s = getComputedStyle(document.documentElement);
      const v = (name: string) => s.getPropertyValue(name).trim();
      dim = rgb(v("--dim"), GREY);
      const fg = rgb(v("--fg"), [0.75, 0.75, 0.75]);
      hot = [0, 1, 2].map((i) => dim[i]! + (fg[i]! - dim[i]!) * 0.55) as RGB;
      red = rgb(v("--bad"), red);
      orange = rgb(v("--accent"), orange);
      tip = rgb(v("--warn"), tip);
      const bg = rgb(v("--bg"), [0.5, 0.5, 0.5]);
      alpha = (bg[0] + bg[1] + bg[2]) / 3 < 0.5 ? 0.42 : 0.34;
    };

    let load = target.current, rise = 0, lastT = 0;
    const draw = (t: number) => {
      // Ease toward the queue's load, and let the smoke climb faster the busier it is.
      const dt = lastT ? Math.min(0.1, t - lastT) : 0;
      lastT = t;
      load += (target.current - load) * Math.min(1, dt * 1.5);
      rise += dt * (0.05 + 0.09 * load);
      const { heat, embers } = fire(load);
      gl.bindVertexArray(vao);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, cols, rows);
      gl.useProgram(pD.p);
      gl.uniform2f(pD.u.uGrid!, cols, rows);
      gl.uniform2f(pD.u.uCell!, cw / dpr, ch / dpr);
      gl.uniform1f(pD.u.uT!, t);
      gl.uniform1f(pD.u.uRise!, still ? STILL_T * 0.05 : rise);
      gl.uniform1f(pD.u.uLoad!, load);
      gl.uniform1f(pD.u.uHeat!, heat);
      gl.uniform1f(pD.u.uEmbers!, embers);
      gl.uniform4fv(pD.u.uSeed!, own.current);
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
      gl.uniform1f(pG.u.uN!, GLYPHS.length);
      gl.uniform1f(pG.u.uNSmoke!, SMOKE.length);
      gl.uniform1f(pG.u.uNFire!, FIRE.length);
      gl.uniform1f(pG.u.uNEmber!, EMBER.length);
      gl.uniform1f(pG.u.uNSpeck!, SPECK.length);
      gl.uniform1f(pG.u.uGain!, GAIN);
      gl.uniform1f(pG.u.uAlpha!, alpha);
      gl.uniform3fv(pG.u.uDim!, dim);
      gl.uniform3fv(pG.u.uHot!, hot);
      gl.uniform3fv(pG.u.uRed!, red);
      gl.uniform3fv(pG.u.uOrange!, orange);
      gl.uniform3fv(pG.u.uTip!, tip);
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
