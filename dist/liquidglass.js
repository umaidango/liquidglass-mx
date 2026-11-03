/*!
 * LiquidGlass MX v1.0.0
 * Physically based "liquid glass" surfaces for the web.
 *
 * Render paths (chosen per element, automatically):
 *   native   – Chromium: SVG displacement filter on `backdrop-filter`.
 *              Refracts any live DOM content behind the element.
 *   mirror   – Safari / Firefox / others with WebGL: the declared backdrop
 *              (canvas / img / video / CSS background image) is refracted
 *              in a shared WebGL renderer and drawn under the element.
 *   fallback – frosted `backdrop-filter` + physically derived specular rim.
 *
 * Zero dependencies. UMD: window.LiquidGlass / CommonJS.
 */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root && root.document) root.LiquidGlass = api;
})(typeof window !== 'undefined' ? window : globalThis, function (win) {
  'use strict';

  var VERSION = '1.0.0';
  var doc = win && win.document;

  /* ------------------------------------------------------------------ *
   * 1. Optics (pure functions – no DOM, testable in Node)
   * ------------------------------------------------------------------ */

  /** Surface height profiles h(t), t = 0 at the edge … 1 where the top turns flat. */
  var PROFILES = {
    squircle: function (t) { return Math.pow(1 - Math.pow(1 - t, 4), 0.25); },
    circle: function (t) { return Math.sqrt(1 - (1 - t) * (1 - t)); },
    parabolic: function (t) { return 1 - (1 - t) * (1 - t); }
  };

  var DEFAULTS = {
    thickness: 24,     // glass height in CSS px at the flat top
    bezel: 'auto',     // width of the curved rim in CSS px ('auto' = from border-radius)
    ior: 1.5,          // index of refraction (crown glass ≈ 1.5)
    profile: 'squircle',
    blur: 2,           // backdrop blur std-deviation in CSS px
    saturation: 1.5,
    brightness: 1.05,
    aberration: 0.08,  // chromatic dispersion: relative R/B displacement spread
    specular: 0.7,     // rim highlight strength 0..1.5
    lightAngle: -55,   // degrees, screen space (0 = from the right, -90 = from the top)
    mode: 'auto',      // auto | native | mirror | fallback
    mirror: 'full',    // full | rim  (mirror path: refract everything / only the rim)
    backdrop: null     // selector or element for the mirror path
  };

  var TABLE_SAMPLES = 256;
  var MAX_SLOPE = Math.tan(89 * Math.PI / 180);

  /**
   * 1-D lookup table over t ∈ [0,1]:
   *   disp[i] – lateral displacement (CSS px) of the refracted view ray
   *   tilt[i] – sin of the surface tilt angle (used for specular)
   * A vertical view ray hits the surface, refracts by Snell's law
   * (n1 = 1, n2 = ior) and travels down through glass of local height
   * h(t)·thickness to the ground plane; the lateral offset is
   * height · tan(θi − θt).
   */
  function buildProfileTable(bezel, thickness, ior, profile) {
    var f = typeof profile === 'function' ? profile : (PROFILES[profile] || PROFILES.squircle);
    var n = TABLE_SAMPLES;
    var disp = new Float32Array(n + 1);
    var tilt = new Float32Array(n + 1);
    var e = 0.5 / n;
    var maxDisp = 0;
    for (var i = 0; i <= n; i++) {
      var t = i / n;
      var t0 = Math.max(0, t - e), t1 = Math.min(1, t + e);
      var dh = (f(t1) - f(t0)) / (t1 - t0);              // dh/dt
      var slope = Math.min(MAX_SLOPE, Math.abs(dh) * thickness / Math.max(1e-6, bezel));
      var thetaI = Math.atan(slope);
      var thetaT = Math.asin(Math.sin(thetaI) / ior);
      var height = f(t) * thickness;
      var d = height * Math.tan(thetaI - thetaT);
      if (i === n) d = 0;
      disp[i] = d;
      tilt[i] = Math.sin(thetaI);
      if (d > maxDisp) maxDisp = d;
    }
    return { disp: disp, tilt: tilt, maxDisp: maxDisp };
  }

  function lookup(table, t) {
    var x = t * TABLE_SAMPLES;
    var i = x | 0;
    if (i >= TABLE_SAMPLES) return table[TABLE_SAMPLES];
    var fr = x - i;
    return table[i] + (table[i + 1] - table[i]) * fr;
  }

  /**
   * Signed geometry of a rounded rectangle (w × h, radius r) at point (x, y).
   * Writes [distanceFromEdge (≥0 inside), outwardNormalX, outwardNormalY] to out.
   */
  function roundedRectField(x, y, w, h, r, out) {
    var px = x - w / 2, py = y - h / 2;
    var sx = px < 0 ? -1 : 1, sy = py < 0 ? -1 : 1;
    var qx = Math.abs(px) - (w / 2 - r);
    var qy = Math.abs(py) - (h / 2 - r);
    if (qx > 0 && qy > 0) {
      var len = Math.sqrt(qx * qx + qy * qy) || 1e-6;
      out[0] = r - len; out[1] = sx * qx / len; out[2] = sy * qy / len;
    } else if (qx > qy) {
      out[0] = r - qx; out[1] = sx; out[2] = 0;
    } else {
      out[0] = r - qy; out[1] = 0; out[2] = sy;
    }
    return out;
  }

  function resolveGeometry(w, h, opts) {
    var half = Math.min(w, h) / 2;
    var radius = Math.max(0, Math.min(opts.radius || 0, half));
    var bezel = opts.bezel === 'auto' || opts.bezel == null || isNaN(+opts.bezel)
      ? Math.max(radius, Math.min(16, half))
      : +opts.bezel;
    bezel = Math.max(1, Math.min(bezel, half));
    // Use at least the bezel as corner radius for the optical field so the
    // rim normals stay continuous (no diagonal crease in sharp corners).
    var fieldRadius = Math.min(half, Math.max(radius, bezel));
    return { radius: radius, bezel: bezel, fieldRadius: fieldRadius };
  }

  /**
   * Displacement map for feDisplacementMap / the WebGL lens shader.
   *   R,G – x/y sample offset, 128 = none, ±127 = ±maxDisp CSS px
   *   B   – rim mask (255 at the edge → 0 where the top is flat)
   * Returns { data: Uint8ClampedArray, width, height, maxDisp, scale }.
   */
  function computeLensMap(w, h, o) {
    o = assign({}, DEFAULTS, o || {});
    var geo = resolveGeometry(w, h, o);
    var table = buildProfileTable(geo.bezel, +o.thickness, +o.ior, o.profile);
    var maxDisp = Math.max(table.maxDisp, 1e-3);
    var res = Math.min(1, (o.maxResolution || 640) / Math.max(w, h));
    var mw = Math.max(1, Math.round(w * res)), mh = Math.max(1, Math.round(h * res));
    var data = new Uint8ClampedArray(mw * mh * 4);
    var f = [0, 0, 0];
    var sxScale = w / mw, syScale = h / mh;
    var inset = Math.max(geo.bezel, geo.fieldRadius) + 1;
    for (var y = 0; y < mh; y++) {
      var cy = (y + 0.5) * syScale;
      var rowFlat = cy >= inset && cy <= h - inset;
      var x0 = Math.ceil(inset / sxScale), x1 = Math.floor((w - inset) / sxScale);
      for (var x = 0; x < mw; x++) {
        var k = (y * mw + x) * 4;
        if (rowFlat && x > x0 && x < x1) {
          data[k] = 128; data[k + 1] = 128; data[k + 2] = 0; data[k + 3] = 255;
          continue;
        }
        roundedRectField((x + 0.5) * sxScale, cy, w, h, geo.fieldRadius, f);
        var dist = f[0];
        var r = 128, g = 128, b = 0;
        if (dist < geo.bezel) {
          var t = Math.max(0, dist) / geo.bezel;
          var d = lookup(table.disp, t) / maxDisp * 127;
          // sample inward (towards the centre): view rays bend toward the normal
          r = 128 - f[1] * d;
          g = 128 - f[2] * d;
          b = (1 - t) * 255;
        }
        data[k] = r; data[k + 1] = g; data[k + 2] = b; data[k + 3] = 255;
      }
    }
    return { data: data, width: mw, height: mh, maxDisp: maxDisp, scale: maxDisp * 255 / 127, bezel: geo.bezel };
  }

  /**
   * Specular rim highlight (white, alpha encodes intensity), derived from the
   * same surface normals. Rendered at device resolution for crisp rims.
   */
  function computeSpecularMap(w, h, o, pixelRatio) {
    o = assign({}, DEFAULTS, o || {});
    var geo = resolveGeometry(w, h, o);
    var table = buildProfileTable(geo.bezel, +o.thickness, +o.ior, o.profile);
    var pr = pixelRatio || 1;
    var mw = Math.max(1, Math.round(w * pr)), mh = Math.max(1, Math.round(h * pr));
    var data = new Uint8ClampedArray(mw * mh * 4);
    var a = (+o.lightAngle) * Math.PI / 180;
    var lx = Math.cos(a), ly = Math.sin(a);
    var strength = Math.max(0, +o.specular);
    var f = [0, 0, 0];
    var limit = geo.bezel + 2;
    var g2 = [0, 0, 0];
    var inset = Math.max(limit, geo.fieldRadius) + 1;
    var x0 = Math.ceil(inset * pr), x1 = Math.floor((w - inset) * pr);
    for (var y = 0; y < mh; y++) {
      var cy = (y + 0.5) / pr;
      var rowFlat = cy >= inset && cy <= h - inset;
      for (var x = 0; x < mw; x++) {
        if (rowFlat && x > x0 && x < x1) { x = x1 - 1; continue; }
        roundedRectField((x + 0.5) / pr, cy, w, h, geo.radius, f);
        var dist = f[0];
        if (dist >= limit || dist < -0.5) continue;
        var k = (y * mw + x) * 4;
        // normals follow the optical field so highlights match the refraction
        var nx = f[1], ny = f[2];
        if (geo.fieldRadius !== geo.radius) {
          roundedRectField((x + 0.5) / pr, cy, w, h, geo.fieldRadius, g2);
          nx = g2[1]; ny = g2[2];
        }
        var t = Math.min(1, Math.max(0, dist) / geo.bezel);
        var tl = lookup(table.tilt, t);
        var dot = nx * lx + ny * ly;
        var front = dot > 0 ? dot * Math.sqrt(dot) : 0;     // facing the light
        var back = dot < 0 ? -dot * Math.sqrt(-dot) : 0;    // internal reflection on the far rim
        var lobe = tl * tl * tl * (front * 0.85 + back * 0.4);
        var line = Math.exp(-Math.max(0, dist) / 0.9) * (0.35 + 0.45 * Math.abs(dot));
        var aa = dist < 0 ? Math.max(0, 1 + dist * 2) : 1;
        var I = Math.min(1, (lobe + line) * strength) * aa;
        data[k] = 255; data[k + 1] = 255; data[k + 2] = 255; data[k + 3] = I * 255;
      }
    }
    return { data: data, width: mw, height: mh };
  }

  function assign(t) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (s) for (var k in s) if (Object.prototype.hasOwnProperty.call(s, k) && s[k] !== undefined) t[k] = s[k];
    }
    return t;
  }

  var pure = {
    version: VERSION,
    defaults: DEFAULTS,
    profiles: PROFILES,
    buildProfileTable: buildProfileTable,
    computeLensMap: computeLensMap,
    computeSpecularMap: computeSpecularMap
  };

  if (!doc) return pure;

  /* ------------------------------------------------------------------ *
   * 2. Capability detection
   * ------------------------------------------------------------------ */

  var nav = win.navigator || {};
  var CSSs = win.CSS && win.CSS.supports ? win.CSS.supports.bind(win.CSS) : function () { return false; };

  function detectChromium() {
    var ua = nav.userAgent || '';
    if (/iPhone|iPad|iPod/.test(ua)) return false;                       // all iOS browsers are WebKit
    if (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) return false;     // iPadOS desktop mode
    if (/Firefox|FxiOS/.test(ua)) return false;
    var brands = nav.userAgentData && nav.userAgentData.brands;
    if (brands && brands.length) {
      return brands.some(function (b) { return /Chromium|Google Chrome|Microsoft Edge|Opera|Brave/.test(b.brand); });
    }
    return /Chrome\/\d+|Chromium\/\d+|Edg\/\d+/.test(ua);
  }

  function detectWebGL() {
    try {
      var c = doc.createElement('canvas');
      return !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
    } catch (e) { return false; }
  }

  var backdropFilter = CSSs('backdrop-filter', 'blur(1px)') || CSSs('-webkit-backdrop-filter', 'blur(1px)');
  var caps = {
    backdropFilter: backdropFilter,
    native: backdropFilter && detectChromium(),
    webgl: null, // lazy
    reducedTransparency: false,
    reducedMotion: false
  };
  function mq(q) { try { return win.matchMedia(q); } catch (e) { return null; } }
  var mqTransparency = mq('(prefers-reduced-transparency: reduce)');
  var mqMotion = mq('(prefers-reduced-motion: reduce)');
  caps.reducedTransparency = !!(mqTransparency && mqTransparency.matches);
  caps.reducedMotion = !!(mqMotion && mqMotion.matches);

  function hasWebGL() {
    if (caps.webgl === null) caps.webgl = detectWebGL();
    return caps.webgl;
  }

  var config = {
    selector: '.lg',
    autoInit: true,
    forceMode: null,        // override every element: 'native' | 'mirror' | 'fallback'
    maxPixelRatio: 2,
    observe: true
  };
  // optional pre-configuration: window.LiquidGlassConfig = { forceMode: 'mirror', ... }
  if (win.LiquidGlassConfig) assign(config, win.LiquidGlassConfig);
  // `native: false` disables the Chromium path (useful to preview the Safari/Firefox rendering)
  function applyNativeOverride() { if (config.native === false) caps.native = false; else if (config.native === true) caps.native = true; }
  applyNativeOverride();

  /* ------------------------------------------------------------------ *
   * 3. Shared resources: maps, specular images, SVG filters (ref-counted)
   * ------------------------------------------------------------------ */

  var SVGNS = 'http://www.w3.org/2000/svg';
  var XLINK = 'http://www.w3.org/1999/xlink';
  var defsSvg = null;
  function getDefs() {
    if (defsSvg && defsSvg.isConnected) return defsSvg;
    defsSvg = doc.createElementNS(SVGNS, 'svg');
    defsSvg.setAttribute('aria-hidden', 'true');
    defsSvg.setAttribute('width', '0');
    defsSvg.setAttribute('height', '0');
    defsSvg.setAttribute('data-lg-defs', '');
    defsSvg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;left:-9999px;top:-9999px';
    (doc.body || doc.documentElement).appendChild(defsSvg);
    return defsSvg;
  }

  function Cache(create, destroy) {
    this.items = new Map();
    this.create = create;
    this.destroy = destroy;
  }
  Cache.prototype.acquire = function (key, args) {
    var it = this.items.get(key);
    if (!it) { it = { refs: 0, value: this.create(key, args) }; this.items.set(key, it); }
    it.refs++;
    return it.value;
  };
  Cache.prototype.release = function (key) {
    var it = this.items.get(key);
    if (!it) return;
    if (--it.refs <= 0) {
      this.items.delete(key);
      if (this.destroy) this.destroy(it.value);
    }
  };

  function toCanvas(map) {
    var c = doc.createElement('canvas');
    c.width = map.width; c.height = map.height;
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(map.width, map.height);
    img.data.set(map.data);
    ctx.putImageData(img, 0, 0);
    return c;
  }

  var mapCache = new Cache(function (key, a) {
    var m = computeLensMap(a.w, a.h, a.o);
    var canvas = toCanvas(m);
    return {
      canvas: canvas, width: m.width, height: m.height, maxDisp: m.maxDisp, scale: m.scale,
      _url: null,
      url: function () { return this._url || (this._url = canvas.toDataURL('image/png')); },
      version: ++mapVersion
    };
  });
  var mapVersion = 0;

  var specCache = new Cache(function (key, a) {
    var entry = { url: null, waiters: [] };
    var s = computeSpecularMap(a.w, a.h, a.o, a.pr);
    var c = toCanvas(s);
    var done = function (url) {
      entry.url = url;
      entry.waiters.forEach(function (fn) { fn(url); });
      entry.waiters = null;
    };
    if (c.toBlob) {
      c.toBlob(function (blob) {
        if (entry.dead) return;
        done(blob ? URL.createObjectURL(blob) : c.toDataURL());
      }, 'image/png');
    } else done(c.toDataURL());
    return entry;
  }, function (entry) {
    entry.dead = true;
    if (entry.url && entry.url.indexOf('blob:') === 0) {
      var u = entry.url;
      setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
    }
  });

  var filterSeq = 0;
  var filterCache = new Cache(function (key, a) {
    var id = 'lg-filter-' + (++filterSeq);
    var f = buildSvgFilter(id, a);
    getDefs().appendChild(f);
    return { id: id, node: f };
  }, function (v) { if (v.node.parentNode) v.node.parentNode.removeChild(v.node); });

  function svg(tag, attrs, parent) {
    var n = doc.createElementNS(SVGNS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }

  function buildSvgFilter(id, a) {
    var f = svg('filter', {
      id: id, x: '0', y: '0', width: '100%', height: '100%',
      filterUnits: 'objectBoundingBox', primitiveUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB'
    });
    var src = 'SourceGraphic';
    if (a.blur > 0) {
      svg('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: fmt(a.blur), edgeMode: 'duplicate', result: 'blur' }, f);
      src = 'blur';
    }
    var img = svg('feImage', {
      x: '0', y: '0', width: fmt(a.w), height: fmt(a.h), preserveAspectRatio: 'none', result: 'map'
    }, f);
    img.setAttribute('href', a.mapUrl);
    img.setAttributeNS(XLINK, 'xlink:href', a.mapUrl);

    var scale = a.scale;
    if (a.aberration > 0.001) {
      var chans = [
        ['r', 1 + a.aberration, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'],
        ['g', 1, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'],
        ['b', 1 - a.aberration, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0']
      ];
      chans.forEach(function (c) {
        svg('feDisplacementMap', { in: src, in2: 'map', scale: fmt(scale * c[1]), xChannelSelector: 'R', yChannelSelector: 'G', result: 'd' + c[0] }, f);
        svg('feColorMatrix', { in: 'd' + c[0], type: 'matrix', values: c[2], result: 'c' + c[0] }, f);
      });
      svg('feComposite', { in: 'cr', in2: 'cg', operator: 'arithmetic', k1: '0', k2: '1', k3: '1', k4: '0', result: 'rg' }, f);
      svg('feComposite', { in: 'rg', in2: 'cb', operator: 'arithmetic', k1: '0', k2: '1', k3: '1', k4: '0', result: 'refr' }, f);
    } else {
      svg('feDisplacementMap', { in: src, in2: 'map', scale: fmt(scale), xChannelSelector: 'R', yChannelSelector: 'G', result: 'refr' }, f);
    }
    svg('feColorMatrix', { in: 'refr', type: 'saturate', values: fmt(a.saturation), result: 'sat' }, f);
    var ct = svg('feComponentTransfer', { in: 'sat' }, f);
    ['R', 'G', 'B'].forEach(function (ch) { svg('feFunc' + ch, { type: 'linear', slope: fmt(a.brightness), intercept: '0' }, ct); });
    return f;
  }

  function fmt(n) { return (Math.round(n * 1000) / 1000).toString(); }

  /* ------------------------------------------------------------------ *
   * 4. WebGL mirror renderer (one shared context for every element)
   * ------------------------------------------------------------------ */

  var VS = 'attribute vec2 p;uniform float u_flip;varying vec2 v_uv;' +
    'void main(){v_uv=vec2((p.x+1.0)*0.5,u_flip>0.5?(1.0-p.y)*0.5:(p.y+1.0)*0.5);gl_Position=vec4(p,0.0,1.0);}';
  var FS_COPY = 'precision mediump float;varying vec2 v_uv;uniform sampler2D u_tex;void main(){gl_FragColor=texture2D(u_tex,v_uv);}';
  var FS_BLUR = 'precision mediump float;varying vec2 v_uv;uniform sampler2D u_tex;uniform vec2 u_step;uniform float u_sigma;' +
    'void main(){vec4 acc=vec4(0.0);float wsum=0.0;' +
    'float lim=ceil(u_sigma*2.5);' +
    'for(int i=-8;i<=8;i++){float x=float(i);if(abs(x)>lim)continue;float w=exp(-x*x/(2.0*u_sigma*u_sigma));acc+=texture2D(u_tex,v_uv+u_step*x)*w;wsum+=w;}' +
    'gl_FragColor=acc/wsum;}';
  var FS_LENS = 'precision highp float;varying vec2 v_uv;' +
    'uniform sampler2D u_bg;uniform sampler2D u_map;uniform vec2 u_origin;uniform vec2 u_size;uniform vec2 u_disp;' +
    'uniform float u_ab;uniform float u_sat;uniform float u_bright;uniform float u_rim;' +
    'void main(){vec4 m=texture2D(u_map,v_uv);vec2 d=(m.rg*255.0-128.0)/127.0*u_disp;vec2 b=u_origin+v_uv*u_size;' +
    // backdrop texels are premultiplied; un-premultiply after dispersion sampling
    'vec4 sr=texture2D(u_bg,b+d*(1.0+u_ab));vec4 sg=texture2D(u_bg,b+d);vec4 sb=texture2D(u_bg,b+d*(1.0-u_ab));' +
    'float al=sg.a;vec3 c=vec3(sr.r,sg.g,sb.b)/max(al,0.0001);' +
    'float l=dot(c,vec3(0.2126,0.7152,0.0722));c=clamp(mix(vec3(l),c,u_sat)*u_bright,0.0,1.0);' +
    'float a=u_rim>0.5?smoothstep(0.0,0.55,m.b):1.0;gl_FragColor=vec4(c,a*al);}';

  function Mirror() {
    var canvas = doc.createElement('canvas');
    var gl = canvas.getContext('webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true, alpha: true, antialias: false }) ||
      canvas.getContext('experimental-webgl', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('LiquidGlass: WebGL unavailable');
    this.canvas = canvas;
    this.gl = gl;
    this.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.progCopy = this.program(FS_COPY);
    this.progBlur = this.program(FS_BLUR);
    this.progLens = this.program(FS_LENS);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.backdrops = new Map();
    this.items = new Set();
    this.running = false;
    this.mapTextures = new Map();
    var self = this;
    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); self.lost = true; });
    this.tick = this.tick.bind(this);
  }

  Mirror.prototype.program = function (fs) {
    var gl = this.gl;
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    p.u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) { var info = gl.getActiveUniform(p, i); p.u[info.name] = gl.getUniformLocation(p, info.name); }
    p.a = gl.getAttribLocation(p, 'p');
    return p;
  };

  Mirror.prototype.texture = function () {
    var gl = this.gl, t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  };

  Mirror.prototype.target = function (w, h) {
    var gl = this.gl;
    var tex = this.texture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    var fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex: tex, fb: fb, w: w, h: h };
  };

  Mirror.prototype.freeTarget = function (t) {
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fb);
  };

  Mirror.prototype.draw = function (prog, target, uniforms, textures, flip) {
    var gl = this.gl;
    gl.useProgram(prog);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    if (target) gl.viewport(0, 0, target.w, target.h);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(prog.a);
    gl.vertexAttribPointer(prog.a, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(prog.u.u_flip, flip ? 1 : 0);
    var unit = 0;
    for (var name in textures) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, textures[name]);
      gl.uniform1i(prog.u[name], unit++);
    }
    for (var u in uniforms) {
      var v = uniforms[u], loc = prog.u[u];
      if (loc == null) continue;
      if (typeof v === 'number') gl.uniform1f(loc, v);
      else gl.uniform2f(loc, v[0], v[1]);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  /** Resolve the backdrop source element and how its pixels map to the viewport. */
  function describeBackdrop(el) {
    var tag = el.tagName;
    if (tag === 'CANVAS') return { source: el, w: el.width, h: el.height, fit: 'fill', live: el.hasAttribute('data-lg-live') };
    if (tag === 'VIDEO') return { source: el, w: el.videoWidth, h: el.videoHeight, fit: getComputedStyle(el).objectFit || 'contain', live: true };
    if (tag === 'IMG') return { source: el, w: el.naturalWidth, h: el.naturalHeight, fit: getComputedStyle(el).objectFit || 'fill', live: false, pending: !el.complete };
    return null;
  }

  Mirror.prototype.backdrop = function (el) {
    var bd = this.backdrops.get(el);
    if (bd) return bd;
    bd = { el: el, tex: this.texture(), version: 0, uploaded: -1, blurred: new Map(), desc: null, img: null, url: null };
    this.backdrops.set(el, bd);
    var self = this;
    if (!/^(CANVAS|VIDEO|IMG)$/.test(el.tagName)) {
      // element with a CSS background-image
      var m = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(el).backgroundImage || '');
      if (m) {
        var img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = function () { bd.version++; self.wake(); };
        img.src = m[1];
        bd.img = img;
      }
    } else if (el.tagName === 'IMG' && !el.complete) {
      el.addEventListener('load', function () { bd.version++; self.wake(); }, { once: true });
    }
    bd.version = 1;
    return bd;
  };

  Mirror.prototype.upload = function (bd) {
    var gl = this.gl;
    var d;
    if (bd.img) {
      if (!bd.img.complete || !bd.img.naturalWidth) return false;
      var cs = getComputedStyle(bd.el);
      var size = cs.backgroundSize;
      d = { source: bd.img, w: bd.img.naturalWidth, h: bd.img.naturalHeight, fit: /contain/.test(size) ? 'contain' : /cover/.test(size) ? 'cover' : 'fill', live: false };
    } else {
      d = describeBackdrop(bd.el);
    }
    if (!d || !d.w || !d.h || d.pending) return false;
    var src = d.source;
    if (d.w > this.maxTex || d.h > this.maxTex) {
      var s = this.maxTex / Math.max(d.w, d.h);
      var c = doc.createElement('canvas');
      c.width = Math.floor(d.w * s); c.height = Math.floor(d.h * s);
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      src = c;
    }
    gl.bindTexture(gl.TEXTURE_2D, bd.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); // blur in premultiplied space (no dark fringes)
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    } catch (e) {
      bd.error = e; // tainted (cross-origin) source
      return false;
    }
    bd.desc = d;
    bd.texW = src.width || d.w; bd.texH = src.height || d.h;
    bd.uploaded = bd.version;
    var self = this;
    bd.blurred.forEach(function (t) { t.stale = true; });
    return true;
  };

  /** Blurred copy of the backdrop texture, via successive 2× downsampling + separable Gaussian. */
  Mirror.prototype.blurred = function (bd, radiusTex) {
    if (radiusTex < 0.5) return bd.tex;
    // quantise to ~1/4-octave steps so scaling animations reuse cached blurs
    radiusTex = Math.pow(2, Math.round(Math.log(radiusTex) / Math.LN2 * 4) / 4);
    var key = radiusTex;
    var entry = bd.blurred.get(key);
    if (entry && !entry.stale) return entry.out.tex;
    var gl = this.gl;
    var levels = 0;
    while ((radiusTex / Math.pow(2, levels)) > 1.5 && levels < 6) levels++;
    var w = bd.texW, h = bd.texH;
    if (!entry || entry.levels !== levels) {
      if (entry) entry.targets.forEach(this.freeTarget, this);
      entry = { levels: levels, targets: [] };
      var cw = w, ch = h;
      for (var i = 0; i < levels; i++) {
        cw = Math.max(1, Math.ceil(cw / 2)); ch = Math.max(1, Math.ceil(ch / 2));
        entry.targets.push(this.target(cw, ch));
      }
      entry.a = this.target(cw, ch);
      entry.out = this.target(cw, ch);
      entry.targets.push(entry.a, entry.out);
      bd.blurred.set(key, entry);
    }
    var srcTex = bd.tex;
    for (var j = 0; j < levels; j++) {
      this.draw(this.progCopy, entry.targets[j], {}, { u_tex: srcTex }, false);
      srcTex = entry.targets[j].tex;
    }
    var sigma = Math.max(0.5, Math.min(3, radiusTex / Math.pow(2, levels)));
    var tw = entry.a.w, th = entry.a.h;
    this.draw(this.progBlur, entry.a, { u_step: [1 / tw, 0], u_sigma: sigma }, { u_tex: srcTex }, false);
    this.draw(this.progBlur, entry.out, { u_step: [0, 1 / th], u_sigma: sigma }, { u_tex: entry.a.tex }, false);
    entry.stale = false;
    return entry.out.tex;
  };

  Mirror.prototype.mapTexture = function (map) {
    var t = this.mapTextures.get(map);
    if (t) return t;
    var gl = this.gl;
    t = this.texture();
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, map.canvas);
    this.mapTextures.set(map, t);
    return t;
  };

  Mirror.prototype.add = function (inst) { this.items.add(inst); this.wake(); };
  Mirror.prototype.remove = function (inst) { this.items.delete(inst); };
  Mirror.prototype.wake = function () {
    if (this.running) return;
    this.running = true;
    win.requestAnimationFrame(this.tick);
  };

  Mirror.prototype.tick = function () {
    if (!this.items.size || this.lost) { this.running = false; return; }
    if (!doc.hidden) {
      var self = this;
      var vw = win.innerWidth, vh = win.innerHeight;
      this.backdrops.forEach(function (bd) {
        var d = bd.desc;
        if (d && d.live) bd.version++;
        if (bd.uploaded !== bd.version) self.upload(bd);
      });
      // cleanup map textures no longer referenced
      if (this.mapTextures.size > this.items.size * 2 + 8) {
        var used = new Set();
        this.items.forEach(function (i) { if (i.map) used.add(i.map); });
        this.mapTextures.forEach(function (t, m) { if (!used.has(m)) { self.gl.deleteTexture(t); self.mapTextures.delete(m); } });
      }
      this.items.forEach(function (inst) {
        var r = inst.el.getBoundingClientRect();
        if (r.bottom < -50 || r.top > vh + 50 || r.right < -50 || r.left > vw + 50 || !r.width) return;
        var bd = inst.backdropRef;
        if (!bd || bd.uploaded < 0) return;
        var br = bd.el.getBoundingClientRect();
        var key = r.left + ',' + r.top + ',' + r.width + ',' + r.height + '|' + br.left + ',' + br.top + ',' + br.width + ',' + br.height + '|' + bd.uploaded + '|' + inst.version;
        if (key === inst.mirrorKey) return;
        inst.mirrorKey = key;
        self.render(inst, r, br, bd);
      });
    }
    win.requestAnimationFrame(this.tick);
  };

  Mirror.prototype.render = function (inst, r, br, bd) {
    var gl = this.gl, d = bd.desc, o = inst.opts;
    var lw = inst.w, lh = inst.h;
    var pr = Math.min(win.devicePixelRatio || 1, config.maxPixelRatio);
    if (o.blur >= 2) pr = Math.min(pr, 1); // frosted content gains nothing from extra pixels
    var cw = Math.max(1, Math.round(lw * pr)), ch = Math.max(1, Math.round(lh * pr));
    if (cw * ch > 4e6) { var s = Math.sqrt(4e6 / (cw * ch)); cw = Math.round(cw * s); ch = Math.round(ch * s); }
    // grow-only shared canvas
    if (this.canvas.width < cw || this.canvas.height < ch) {
      this.canvas.width = Math.max(this.canvas.width, cw);
      this.canvas.height = Math.max(this.canvas.height, ch);
    }
    // where the backdrop's pixels are drawn, in viewport px
    var dx = br.left, dy = br.top, dw = br.width, dh = br.height;
    if (d.fit === 'cover' || d.fit === 'contain') {
      var sc = d.fit === 'cover' ? Math.max(br.width / d.w, br.height / d.h) : Math.min(br.width / d.w, br.height / d.h);
      dw = d.w * sc; dh = d.h * sc;
      dx = br.left + (br.width - dw) / 2; dy = br.top + (br.height - dh) / 2;
    }
    var visualScale = r.width / lw; // CSS transforms
    var texPerCss = bd.texW / dw;
    var tex = this.blurred(bd, o.blur * visualScale * texPerCss);
    var mapTex = this.mapTexture(inst.map);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, this.canvas.height - ch, cw, ch);
    gl.disable(gl.BLEND);
    var disp = inst.map.maxDisp * visualScale;
    this.draw(this.progLens, null, {
      u_origin: [(r.left - dx) / dw, (r.top - dy) / dh],
      u_size: [r.width / dw, r.height / dh],
      u_disp: [disp / dw, disp / dh],
      u_ab: o.aberration,
      u_sat: o.saturation,
      u_bright: o.brightness,
      u_rim: o.mirror === 'rim' ? 1 : 0
    }, { u_bg: tex, u_map: mapTex }, true);
    var out = inst.canvas;
    if (out.width !== cw || out.height !== ch) { out.width = cw; out.height = ch; }
    var ctx = inst.ctx || (inst.ctx = out.getContext('2d'));
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(this.canvas, 0, 0, cw, ch, 0, 0, cw, ch);
  };

  var mirror = null;
  function getMirror() {
    if (mirror) return mirror;
    try { mirror = new Mirror(); } catch (e) { mirror = false; }
    return mirror;
  }

  /* ------------------------------------------------------------------ *
   * 5. Element instances
   * ------------------------------------------------------------------ */

  var instances = new Map();
  var NUMERIC = ['thickness', 'ior', 'blur', 'saturation', 'brightness', 'aberration', 'specular', 'lightAngle'];
  var CSS_PROPS = {
    thickness: '--lg-thickness', bezel: '--lg-bezel', ior: '--lg-ior', profile: '--lg-profile',
    blur: '--lg-blur', saturation: '--lg-saturation', brightness: '--lg-brightness',
    aberration: '--lg-aberration', specular: '--lg-specular', lightAngle: '--lg-light-angle',
    mode: '--lg-mode', mirror: '--lg-mirror'
  };

  function dataName(k) { return 'lg' + k.charAt(0).toUpperCase() + k.slice(1); }

  function readOptions(el, jsOpts) {
    var cs = getComputedStyle(el);
    var o = assign({}, DEFAULTS);
    for (var k in CSS_PROPS) {
      var v = cs.getPropertyValue(CSS_PROPS[k]).trim();
      if (v) o[k] = v;
    }
    for (var k2 in DEFAULTS) {
      if (k2 === 'mode') continue; // data-lg-mode is an output (the active path), not an input
      var dv = el.dataset[dataName(k2)];
      if (dv != null && dv !== '') o[k2] = dv;
    }
    assign(o, jsOpts);
    NUMERIC.forEach(function (n) { var x = parseFloat(o[n]); o[n] = isNaN(x) ? DEFAULTS[n] : x; });
    if (o.bezel !== 'auto') { var b = parseFloat(o.bezel); o.bezel = isNaN(b) ? 'auto' : b; }
    o.profile = String(o.profile).replace(/["']/g, '');
    o.mode = String(o.mode).replace(/["']/g, '');
    o.mirror = String(o.mirror).replace(/["']/g, '');
    if (caps.reducedTransparency) { o.blur = Math.max(o.blur, 12); }
    return o;
  }

  function parseRadius(el, w, h) {
    var cs = getComputedStyle(el);
    var v = cs.borderTopLeftRadius || '0';
    var first = v.split(' ')[0];
    var n = parseFloat(first) || 0;
    if (/%$/.test(first)) n = n / 100 * Math.min(w, h);
    return Math.min(n, Math.min(w, h) / 2);
  }

  function findBackdrop(el, o) {
    var b = o.backdrop;
    if (!b) {
      var host = el.closest('[data-lg-backdrop]');
      b = host && host.getAttribute('data-lg-backdrop');
    }
    if (!b) return null;
    if (typeof b === 'string') { try { b = doc.querySelector(b); } catch (e) { b = null; } }
    return b && b.nodeType === 1 ? b : null;
  }

  function chooseMode(inst) {
    var o = inst.opts;
    var want = config.forceMode || (o.mode !== 'auto' ? o.mode : null);
    var nested = !!(inst.el.parentElement && inst.el.parentElement.closest(config.selector));
    if (caps.reducedTransparency) return 'fallback';
    if (want === 'fallback') return 'fallback';
    if (want === 'native') return 'native';
    if (want === 'mirror') return findBackdrop(inst.el, o) && hasWebGL() && getMirror() ? 'mirror' : 'fallback';
    if (caps.native) return 'native';
    if (!nested && findBackdrop(inst.el, o) && hasWebGL() && getMirror()) return 'mirror';
    return 'fallback';
  }

  function Instance(el, jsOpts) {
    this.el = el;
    this.jsOpts = jsOpts || {};
    this.version = 0;
    this.keys = { map: null, spec: null, filter: null };
  }

  Instance.prototype.build = function () {
    var el = this.el;
    if (!el.isConnected) return;
    var w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    var o = this.opts = readOptions(el, this.jsOpts);
    o.radius = parseRadius(el, w, h);
    this.w = w; this.h = h;
    var mode = chooseMode(this);

    // 1. displacement map
    var mapKey = [w, h, o.radius, o.bezel, o.thickness, o.ior, o.profile].join('|');
    if (mapKey !== this.keys.map) {
      var map = mapCache.acquire(mapKey, { w: w, h: h, o: o });
      if (this.keys.map) mapCache.release(this.keys.map);
      this.keys.map = mapKey;
      this.map = map;
    }

    // 2. specular highlight
    var pr = Math.min(win.devicePixelRatio || 1, config.maxPixelRatio);
    var specKey = o.specular > 0 ? [w, h, o.radius, o.bezel, o.thickness, o.ior, o.profile, o.specular, o.lightAngle, pr].join('|') : null;
    if (specKey !== this.keys.spec) {
      var oldSpec = this.keys.spec;
      this.keys.spec = specKey;
      if (specKey) {
        var entry = specCache.acquire(specKey, { w: w, h: h, o: o, pr: pr });
        var apply = function (url) {
          if (this.keys.spec === specKey) el.style.setProperty('--lg-specular-image', 'url("' + url + '")');
          if (oldSpec) specCache.release(oldSpec);
        }.bind(this);
        if (entry.url) apply(entry.url); else entry.waiters.push(apply);
      } else {
        el.style.removeProperty('--lg-specular-image');
        if (oldSpec) specCache.release(oldSpec);
      }
    }

    // 3. render path
    this.setMode(mode);
    if (mode === 'native') {
      var fKey = mapKey + '|' + [o.blur, o.saturation, o.brightness, o.aberration].join('|');
      if (fKey !== this.keys.filter) {
        var filt = filterCache.acquire(fKey, {
          w: w, h: h, mapUrl: this.map.url(), scale: this.map.scale,
          blur: o.blur, saturation: o.saturation, brightness: o.brightness, aberration: o.aberration
        });
        if (this.keys.filter) filterCache.release(this.keys.filter);
        this.keys.filter = fKey;
        var val = 'url(#' + filt.id + ')';
        el.style.setProperty('backdrop-filter', val);
      }
    } else if (mode === 'mirror') {
      var m = getMirror();
      var bdEl = findBackdrop(el, o);
      this.backdropRef = m.backdrop(bdEl);
      if (o.mirror === 'full') el.style.setProperty('backdrop-filter', 'none');
      else el.style.removeProperty('backdrop-filter');
      el.style.setProperty('-webkit-backdrop-filter', o.mirror === 'full' ? 'none' : '');
      this.version++;
      m.add(this);
    }
    el.classList.add('lg-enhanced');
    el.setAttribute('data-lg-mode', mode);
    if (!this.ready) {
      this.ready = true;
      try { el.dispatchEvent(new CustomEvent('lg:ready', { bubbles: true, detail: { mode: mode } })); } catch (e) { /* old browsers */ }
    }
  };

  Instance.prototype.setMode = function (mode) {
    if (this.mode === mode) return;
    var el = this.el;
    if (this.mode === 'native' && this.keys.filter) {
      filterCache.release(this.keys.filter);
      this.keys.filter = null;
      el.style.removeProperty('backdrop-filter');
    }
    if (this.mode === 'mirror') {
      if (mirror) mirror.remove(this);
      if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
      this.canvas = null; this.ctx = null;
      el.style.removeProperty('backdrop-filter');
      el.style.removeProperty('-webkit-backdrop-filter');
    }
    if (mode === 'mirror') {
      var c = doc.createElement('canvas');
      c.className = 'lg-refraction';
      c.setAttribute('aria-hidden', 'true');
      el.insertBefore(c, el.firstChild);
      this.canvas = c;
      this.mirrorKey = null;
    }
    this.mode = mode;
  };

  Instance.prototype.destroy = function () {
    this.setMode('none');
    var el = this.el;
    if (this.keys.map) mapCache.release(this.keys.map);
    if (this.keys.spec) specCache.release(this.keys.spec);
    el.style.removeProperty('--lg-specular-image');
    el.classList.remove('lg-enhanced');
    el.removeAttribute('data-lg-mode');
    this.keys = {};
  };

  /* scheduling: batch builds into animation frames, time-sliced */
  var queue = new Set();
  var scheduled = false;
  function schedule(inst) {
    queue.add(inst);
    if (scheduled) return;
    scheduled = true;
    win.requestAnimationFrame(flush);
  }
  function flush() {
    var start = performance.now();
    var it = queue.values();
    var n;
    while (!(n = it.next()).done) {
      queue.delete(n.value);
      try { n.value.build(); } catch (e) { if (win.console) console.error('[LiquidGlass]', e); }
      if (performance.now() - start > 12) break;
    }
    scheduled = false;
    if (queue.size) { scheduled = true; win.requestAnimationFrame(flush); }
  }

  var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(function (entries) {
    entries.forEach(function (e) { var i = instances.get(e.target); if (i) schedule(i); });
  }) : null;

  function attach(el, opts) {
    if (!el || el.nodeType !== 1) return null;
    var inst = instances.get(el);
    if (inst) {
      if (opts) { assign(inst.jsOpts, opts); schedule(inst); }
      return inst;
    }
    inst = new Instance(el, opts);
    instances.set(el, inst);
    if (ro) ro.observe(el);
    schedule(inst);
    return inst;
  }

  function detach(el) {
    var inst = instances.get(el);
    if (!inst) return;
    instances.delete(el);
    queue.delete(inst);
    if (ro) ro.unobserve(el);
    inst.destroy();
  }

  function refresh(el) {
    if (el) { var i = instances.get(el); if (i) schedule(i); return; }
    instances.forEach(function (i) {
      // drop cached keys so options re-read from CSS take effect
      schedule(i);
    });
  }

  function update(el, opts) {
    var inst = instances.get(el) || attach(el);
    if (inst && opts) assign(inst.jsOpts, opts);
    if (inst) schedule(inst);
    return inst;
  }

  function scan(rootNode) {
    var r = rootNode || doc;
    if (r.nodeType === 1 && r.matches(config.selector)) attach(r);
    var list = r.querySelectorAll ? r.querySelectorAll(config.selector) : [];
    for (var i = 0; i < list.length; i++) attach(list[i]);
  }

  var mo = null;
  function observeDom() {
    if (mo || typeof MutationObserver === 'undefined') return;
    mo = new MutationObserver(function (records) {
      records.forEach(function (rec) {
        rec.addedNodes.forEach(function (n) { if (n.nodeType === 1) scan(n); });
        rec.removedNodes.forEach(function (n) {
          if (n.nodeType !== 1 || n.isConnected) return;
          instances.forEach(function (inst, el) { if (n === el || n.contains(el)) detach(el); });
        });
      });
    });
    mo.observe(doc.documentElement, { childList: true, subtree: true });
  }

  /* ------------------------------------------------------------------ *
   * 6. Interaction: pointer light, press, drag with liquid stretch
   * ------------------------------------------------------------------ */

  var INTERACTIVE = '.lg-interactive, [data-lg-interactive], .lg-btn';

  function onPointerMove(e) {
    var t = e.target.closest && e.target.closest(INTERACTIVE);
    if (!t) return;
    var r = t.getBoundingClientRect();
    t.style.setProperty('--lg-px', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
    t.style.setProperty('--lg-py', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
  }
  function onPointerDown(e) {
    var t = e.target.closest && e.target.closest(INTERACTIVE);
    if (!t || t.disabled) return;
    t.classList.add('lg-pressed');
    var up = function () {
      t.classList.remove('lg-pressed');
      win.removeEventListener('pointerup', up);
      win.removeEventListener('pointercancel', up);
    };
    win.addEventListener('pointerup', up);
    win.addEventListener('pointercancel', up);
  }

  /**
   * Make an element draggable with velocity-driven squash & stretch.
   * Returns a function that removes the behaviour.
   */
  function draggable(el, opts) {
    opts = assign({ bounds: null, stretch: 0.0035, maxStretch: 0.2 }, opts);
    var x = 0, y = 0, vx = 0, vy = 0, sx = 1, sy = 1, dragging = false;
    var lastX = 0, lastY = 0, lastT = 0, raf = 0, startX = 0, startY = 0, ox = 0, oy = 0;
    var m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(el.style.transform || '');
    if (m) { x = +m[1]; y = +m[2]; }
    el.style.touchAction = 'none';
    el.style.cursor = 'grab';

    function apply() {
      el.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) scale(' + sx.toFixed(3) + ',' + sy.toFixed(3) + ')';
    }
    function clamp() {
      var b = opts.bounds;
      if (!b) return;
      var host = typeof b === 'string' ? el.closest(b) : b;
      if (!host) return;
      var hr = host.getBoundingClientRect();
      var parent = el.offsetParent || host;
      var pr = parent.getBoundingClientRect();
      var minX = hr.left - pr.left - el.offsetLeft, minY = hr.top - pr.top - el.offsetTop;
      var maxX = minX + hr.width - el.offsetWidth, maxY = minY + hr.height - el.offsetHeight;
      x = Math.max(minX, Math.min(maxX, x));
      y = Math.max(minY, Math.min(maxY, y));
    }
    function loop() {
      var speed = Math.sqrt(vx * vx + vy * vy);
      var st = Math.min(opts.maxStretch, speed * opts.stretch * 16);
      var horiz = Math.abs(vx) >= Math.abs(vy);
      var tx = 1 + (horiz ? st : -st * 0.6), ty = 1 + (horiz ? -st * 0.6 : st);
      if (caps.reducedMotion) { tx = ty = 1; }
      // spring towards the target scale
      sx += (tx - sx) * 0.25; sy += (ty - sy) * 0.25;
      vx *= 0.82; vy *= 0.82;
      apply();
      if (dragging || Math.abs(sx - 1) > 0.002 || Math.abs(sy - 1) > 0.002 || speed > 0.01) raf = win.requestAnimationFrame(loop);
      else { sx = sy = 1; apply(); raf = 0; }
    }
    function down(e) {
      if (e.button !== undefined && e.button !== 0) return;
      dragging = true;
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
      startX = e.clientX; startY = e.clientY; ox = x; oy = y;
      lastX = e.clientX; lastY = e.clientY; lastT = performance.now();
      el.style.cursor = 'grabbing';
      el.classList.add('lg-dragging');
      if (!raf) raf = win.requestAnimationFrame(loop);
    }
    function move(e) {
      if (!dragging) return;
      var now = performance.now(), dt = Math.max(1, now - lastT);
      vx = vx * 0.5 + ((e.clientX - lastX) / dt) * 0.5;
      vy = vy * 0.5 + ((e.clientY - lastY) / dt) * 0.5;
      lastX = e.clientX; lastY = e.clientY; lastT = now;
      x = ox + e.clientX - startX; y = oy + e.clientY - startY;
      clamp();
    }
    function up() {
      if (!dragging) return;
      dragging = false;
      el.style.cursor = 'grab';
      el.classList.remove('lg-dragging');
    }
    function key(e) {
      var step = e.shiftKey ? 40 : 10;
      var k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!k) return;
      e.preventDefault();
      x += k[0]; y += k[1]; vx = k[0] / 16; vy = k[1] / 16; clamp();
      if (!raf) raf = win.requestAnimationFrame(loop);
    }
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('keydown', key);
    apply();
    return function () {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('keydown', key);
    };
  }

  /* ------------------------------------------------------------------ *
   * 7. Components (segmented control, slider)
   * ------------------------------------------------------------------ */

  function initSegmented(root) {
    if (root._lgSeg) return;
    root._lgSeg = true;
    var items = Array.prototype.slice.call(root.querySelectorAll('[role="tab"], .lg-segmented__item'));
    root.style.setProperty('--lg-count', items.length);
    function select(i, focus) {
      items.forEach(function (it, j) {
        it.setAttribute('aria-selected', j === i ? 'true' : 'false');
        it.tabIndex = j === i ? 0 : -1;
      });
      root.style.setProperty('--lg-index', i);
      root.classList.add('lg-moving');
      clearTimeout(root._lgT);
      root._lgT = setTimeout(function () { root.classList.remove('lg-moving'); }, 420);
      if (focus) items[i].focus();
      root.dispatchEvent(new CustomEvent('lg:change', { bubbles: true, detail: { index: i, value: items[i].getAttribute('data-value') || items[i].textContent.trim() } }));
    }
    items.forEach(function (it, i) {
      it.addEventListener('click', function () { select(i); });
      it.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') { e.preventDefault(); select((i + 1) % items.length, true); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); select((i - 1 + items.length) % items.length, true); }
      });
    });
    var cur = items.findIndex(function (it) { return it.getAttribute('aria-selected') === 'true'; });
    root.style.setProperty('--lg-index', Math.max(0, cur));
    items.forEach(function (it, j) { it.tabIndex = j === Math.max(0, cur) ? 0 : -1; });
  }

  function initSlider(root) {
    if (root._lgSlider) return;
    root._lgSlider = true;
    var input = root.querySelector('input[type="range"]');
    if (!input) return;
    function sync() {
      var min = +input.min || 0, max = input.max === '' ? 100 : +input.max;
      var p = (input.value - min) / ((max - min) || 1);
      root.style.setProperty('--lg-value', p.toFixed(4));
    }
    input.addEventListener('input', sync);
    input.addEventListener('pointerdown', function () { root.classList.add('lg-active'); });
    win.addEventListener('pointerup', function () { root.classList.remove('lg-active'); });
    sync();
  }

  function initComponents(r) {
    r = r || doc;
    var segs = r.querySelectorAll('.lg-segmented');
    for (var i = 0; i < segs.length; i++) initSegmented(segs[i]);
    var sl = r.querySelectorAll('.lg-slider');
    for (var j = 0; j < sl.length; j++) initSlider(sl[j]);
    var dr = r.querySelectorAll('[data-lg-draggable]');
    for (var k = 0; k < dr.length; k++) {
      if (!dr[k]._lgDrag) {
        var b = dr[k].getAttribute('data-lg-draggable');
        dr[k]._lgDrag = draggable(dr[k], { bounds: b || null });
      }
    }
  }

  /* ------------------------------------------------------------------ *
   * 8. Public API
   * ------------------------------------------------------------------ */

  var started = false;
  function init(options) {
    assign(config, options);
    applyNativeOverride();
    if (started) { scan(); initComponents(); return api; }
    started = true;
    var html = doc.documentElement;
    html.classList.add('lg-js');
    html.classList.add(caps.backdropFilter ? 'lg-has-backdrop' : 'lg-no-backdrop');
    if (caps.native) html.classList.add('lg-native');
    scan();
    initComponents();
    if (config.observe) observeDom();
    doc.addEventListener('pointermove', onPointerMove, { passive: true });
    doc.addEventListener('pointerdown', onPointerDown, { passive: true });
    var onScheme = function () { refresh(); };
    var mqDark = mq('(prefers-color-scheme: dark)');
    [mqDark, mqTransparency, mqMotion].forEach(function (m) {
      if (!m) return;
      var fn = function () {
        caps.reducedTransparency = !!(mqTransparency && mqTransparency.matches);
        caps.reducedMotion = !!(mqMotion && mqMotion.matches);
        onScheme();
      };
      if (m.addEventListener) m.addEventListener('change', fn); else if (m.addListener) m.addListener(fn);
    });
    var lastPr = win.devicePixelRatio;
    win.addEventListener('resize', function () {
      if (win.devicePixelRatio !== lastPr) { lastPr = win.devicePixelRatio; refresh(); }
    });
    return api;
  }

  function invalidateBackdrop(el) {
    if (!mirror) return;
    mirror.backdrops.forEach(function (bd) { if (!el || bd.el === el) bd.version++; });
    mirror.wake();
  }

  var api = assign({}, pure, {
    capabilities: caps,
    config: config,
    init: init,
    attach: attach,
    detach: detach,
    update: update,
    refresh: refresh,
    invalidateBackdrop: invalidateBackdrop,
    draggable: draggable,
    initComponents: initComponents,
    getMode: function (el) { var i = instances.get(el); return i ? i.mode : null; },
    instances: instances,
    _mirror: function () { return mirror || null; }
  });

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', function () { if (config.autoInit && !isManual()) init(); });
  } else {
    setTimeout(function () { if (config.autoInit && !isManual() && !started) init(); }, 0);
  }
  function isManual() {
    var s = doc.querySelector('script[data-lg-manual]');
    return !!s;
  }

  return api;
});
