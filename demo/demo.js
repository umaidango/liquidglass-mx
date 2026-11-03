/* Halcyon — sample site behaviour (uses window.LiquidGlass) */
(function () {
  'use strict';

  var root = document.documentElement;
  var LG = window.LiquidGlass;
  var reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  function token(name) { return getComputedStyle(root).getPropertyValue(name).trim(); }
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }

  /* ---------------------------------------------------------------- */
  /* Theme                                                             */
  /* ---------------------------------------------------------------- */
  try {
    var saved = localStorage.getItem('halcyon-theme');
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  } catch (e) { /* storage unavailable */ }

  function currentTheme() {
    var t = root.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  $('#theme-toggle').addEventListener('click', function () {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('halcyon-theme', next); } catch (e) { /* ignore */ }
    themeChanged();
  });
  if (window.matchMedia) {
    var mqd = matchMedia('(prefers-color-scheme: dark)');
    (mqd.addEventListener ? mqd.addEventListener.bind(mqd, 'change') : mqd.addListener.bind(mqd))(themeChanged);
  }

  function themeChanged() {
    paintScene(lastT);
    paintPlayground();
    paintArt();
    if (LG) { LG.refresh(); LG.invalidateBackdrop(); }
  }

  /* ---------------------------------------------------------------- */
  /* Background scene: colour fields + sound ripples                   */
  /* ---------------------------------------------------------------- */
  var scene = $('#scene');
  var sctx = scene.getContext('2d');
  var lastT = 0;

  function sizeCanvas(c, w, h, maxDpr) {
    var dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    var cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
    if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
    return dpr;
  }

  function ripple(ctx, cx, cy, maxR, spacing, t, seed, wobble) {
    var offset = (t * 9) % spacing;
    var n = Math.ceil(maxR / spacing) + 1;
    for (var k = 0; k < n; k++) {
      var r = k * spacing + offset;
      if (r < 6) continue;
      var amp = wobble * Math.min(1, r / 300);
      ctx.beginPath();
      var steps = Math.max(48, Math.min(160, Math.round(r / 6)));
      for (var i = 0; i <= steps; i++) {
        var a = i / steps * Math.PI * 2;
        var rr = r + Math.sin(a * 3 + seed + k * 0.35 + t * 0.25) * amp + Math.sin(a * 5 - seed * 2 + t * 0.4) * amp * 0.4;
        var x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.stroke();
    }
  }

  function blob(ctx, x, y, r, color) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, 'transparent');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  function paintScene(t) {
    lastT = t;
    var w = window.innerWidth, h = window.innerHeight;
    var dpr = sizeCanvas(scene, w, h, 1.5);
    var ctx = sctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = token('--bg');
    ctx.fillRect(0, 0, w, h);

    var s = Math.max(w, h);
    var dark = currentTheme() === 'dark';
    ctx.globalAlpha = dark ? 0.75 : 0.85;
    blob(ctx, w * (0.78 + Math.sin(t * 0.05) * 0.05), h * (0.22 + Math.cos(t * 0.04) * 0.05), s * 0.42, token('--scene-1'));
    blob(ctx, w * (0.12 + Math.cos(t * 0.03) * 0.04), h * (0.78 + Math.sin(t * 0.05) * 0.04), s * 0.40, token('--scene-2'));
    blob(ctx, w * (0.45 + Math.sin(t * 0.04) * 0.06), h * (0.55 + Math.sin(t * 0.03) * 0.05), s * 0.30, token('--scene-3'));
    blob(ctx, w * (0.92 + Math.cos(t * 0.05) * 0.03), h * (0.92 + Math.sin(t * 0.04) * 0.03), s * 0.28, token('--scene-4'));
    ctx.globalAlpha = 1;

    // large faint lettering: refraction makes it visibly bend
    ctx.fillStyle = token('--scene-text');
    ctx.font = '800 ' + Math.round(s * 0.2) + 'px ' + token('--font-display');
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('静', w * 0.56, h * 0.62);

    ctx.strokeStyle = token('--scene-line');
    ctx.lineWidth = 1;
    var diag = Math.sqrt(w * w + h * h);
    ripple(ctx, w * 0.82, h * 0.18, diag, 22, t, 0.7, 7);
    ctx.globalAlpha = 0.55;
    ripple(ctx, w * 0.06, h * 0.96, diag * 0.7, 30, t * 0.8, 2.1, 10);
    ctx.globalAlpha = 1;
    if (LG) LG.invalidateBackdrop(scene);
  }

  var motionToggle = $('#motion-toggle');
  if (reduceMotion) motionToggle.checked = false;
  var animStart = performance.now(), lastFrame = 0, sceneRaf = 0;

  function loop(now) {
    sceneRaf = 0;
    if (!motionToggle.checked) return;
    // a slow drift needs few frames; the WebGL mirror path re-renders every glass surface per frame
    var interval = LG && !LG.capabilities.native ? 80 : 40;
    if (now - lastFrame >= interval) {
      lastFrame = now;
      paintScene((now - animStart) / 1000);
    }
    sceneRaf = requestAnimationFrame(loop);
  }
  function startLoop() { if (!sceneRaf && motionToggle.checked) sceneRaf = requestAnimationFrame(loop); }
  motionToggle.addEventListener('change', function () {
    if (motionToggle.checked) { animStart = performance.now() - lastT * 1000; startLoop(); }
  });

  var resizeT = 0;
  window.addEventListener('resize', function () {
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { paintScene(lastT); paintPlayground(); }, 60);
  });

  /* ---------------------------------------------------------------- */
  /* Album art                                                         */
  /* ---------------------------------------------------------------- */
  function paintArt() {
    var c = $('#art');
    var ctx = c.getContext('2d');
    var g = ctx.createLinearGradient(0, 0, 128, 128);
    g.addColorStop(0, token('--scene-1'));
    g.addColorStop(0.55, token('--scene-3'));
    g.addColorStop(1, token('--scene-2'));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.5;
    for (var r = 10; r < 150; r += 12) {
      ctx.beginPath();
      ctx.arc(96, 100, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Player                                                            */
  /* ---------------------------------------------------------------- */
  var play = $('#play');
  var progress = $('#progress-input');
  var tNow = $('#t-now');
  var playTimer = 0;

  function fmtTime(s) {
    s = Math.round(s);
    return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }
  function setProgress(v) {
    progress.value = v;
    progress.dispatchEvent(new Event('input', { bubbles: true }));
  }
  progress.addEventListener('input', function () { tNow.textContent = fmtTime(+progress.value); });

  play.addEventListener('click', function () {
    var on = play.getAttribute('aria-pressed') !== 'true';
    play.setAttribute('aria-pressed', on ? 'true' : 'false');
    play.setAttribute('aria-label', on ? '一時停止' : '再生');
    clearInterval(playTimer);
    if (on) {
      playTimer = setInterval(function () {
        var v = +progress.value + 1;
        setProgress(v > +progress.max ? 0 : v);
      }, 1000);
    }
  });

  /* ---------------------------------------------------------------- */
  /* Mixer                                                             */
  /* ---------------------------------------------------------------- */
  var CHANNELS = [
    { id: 'rain', name: '雨', place: '京都・町家' },
    { id: 'wave', name: '波', place: '葉山・森戸海岸' },
    { id: 'fire', name: '焚き火', place: '八ヶ岳' },
    { id: 'forest', name: '森', place: '屋久島・白谷雲水峡' },
    { id: 'cafe', name: 'カフェ', place: '神保町' }
  ];
  var PRESETS = {
    focus: { rain: 0.62, wave: 0.28, fire: 0, forest: 0.44, cafe: 0.52 },
    rest: { rain: 0.30, wave: 0.70, fire: 0.48, forest: 0.36, cafe: 0 },
    sleep: { rain: 0.54, wave: 0.42, fire: 0.22, forest: 0, cafe: 0 }
  };

  var list = $('#channels');
  list.innerHTML = CHANNELS.map(function (c) {
    return '<li class="channel" data-id="' + c.id + '">' +
      '<span class="channel-name"><b>' + c.name + '</b><small>' + c.place + '</small></span>' +
      '<div class="lg-slider"><input type="range" id="ch-' + c.id + '-level" min="0" max="1" step="0.01" value="0.5" aria-label="' + c.name + 'の音量">' +
      '<span class="lg-slider__track"></span><span class="lg lg-slider__thumb"></span></div>' +
      '<output class="db" id="ch-' + c.id + '-db" for="ch-' + c.id + '-level"></output>' +
      '<label class="lg-switch" for="ch-' + c.id + '-on"><input type="checkbox" id="ch-' + c.id + '-on" checked>' +
      '<span class="lg-switch__track"><span class="lg lg-switch__knob"></span></span><span class="sr-only">' + c.name + 'を再生</span></label>' +
      '</li>';
  }).join('');
  if (LG) { LG.initComponents(list); }

  function dbText(v, on) {
    if (!on || v <= 0.001) return '−∞ dB';
    var d = 20 * Math.log10(v);
    return (d < 0 ? '−' : '+') + Math.abs(d).toFixed(1) + ' dB';
  }
  function updateMixer() {
    var power = 0;
    CHANNELS.forEach(function (c) {
      var lv = $('#ch-' + c.id + '-level'), on = $('#ch-' + c.id + '-on');
      $('#ch-' + c.id + '-db').textContent = dbText(+lv.value, on.checked);
      lv.closest('.channel').classList.toggle('is-off', !on.checked);
      if (on.checked) power += lv.value * lv.value;
    });
    var lufs = power > 0 ? -23 + 10 * Math.log10(power / 0.9) : -Infinity;
    $('#master').textContent = isFinite(lufs) ? '−' + Math.abs(lufs).toFixed(1) + ' LUFS' : '無音';
  }
  list.addEventListener('input', updateMixer);
  list.addEventListener('change', updateMixer);

  var tween = 0;
  function applyPreset(name) {
    var p = PRESETS[name];
    var from = {}, start = performance.now();
    CHANNELS.forEach(function (c) {
      from[c.id] = +$('#ch-' + c.id + '-level').value;
      $('#ch-' + c.id + '-on').checked = p[c.id] > 0;
    });
    cancelAnimationFrame(tween);
    var dur = reduceMotion ? 1 : 520;
    (function step(now) {
      var k = Math.min(1, (now - start) / dur);
      var e = 1 - Math.pow(1 - k, 3);
      CHANNELS.forEach(function (c) {
        var target = p[c.id] > 0 ? p[c.id] : from[c.id];
        var lv = $('#ch-' + c.id + '-level');
        lv.value = from[c.id] + (target - from[c.id]) * e;
        lv.dispatchEvent(new Event('input', { bubbles: true }));
      });
      if (k < 1) tween = requestAnimationFrame(step);
    })(start);
  }
  $('#mode').addEventListener('lg:change', function (e) { applyPreset(e.detail.value); });
  applyPreset('focus');

  /* ---------------------------------------------------------------- */
  /* Pricing                                                           */
  /* ---------------------------------------------------------------- */
  $('#billing').addEventListener('lg:change', function (e) {
    var period = e.detail.value;
    document.querySelectorAll('.amount b[data-month]').forEach(function (b) {
      b.textContent = b.getAttribute('data-' + period);
      b.nextElementSibling.textContent = period === 'year' ? '/ 月（年払い）' : '/ 月';
    });
  });

  /* ---------------------------------------------------------------- */
  /* Playground                                                        */
  /* ---------------------------------------------------------------- */
  var pg = $('#pg-canvas');
  var sample = $('#pg-sample');

  function paintPlayground() {
    var stage = $('#pg-stage');
    var w = stage.clientWidth, h = stage.clientHeight;
    if (!w || !h) return;
    var dpr = sizeCanvas(pg, w, h, 2);
    var ctx = pg.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    var dark = currentTheme() === 'dark';
    var ground = dark ? '#0c1322' : '#f4f1ea';
    var ink = dark ? 'rgba(220,235,245,0.85)' : 'rgba(18,28,44,0.85)';
    ctx.fillStyle = ground;
    ctx.fillRect(0, 0, w, h);
    // colour bands
    var bands = [token('--scene-1'), token('--scene-3'), token('--scene-2'), token('--scene-4')];
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-0.38);
    var bw = 46;
    for (var i = -30; i < 30; i++) {
      ctx.fillStyle = bands[(i + 60) % 4];
      ctx.globalAlpha = 0.9;
      ctx.fillRect(i * bw, -h * 1.5, bw * 0.5, h * 3);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    // grid
    ctx.strokeStyle = dark ? 'rgba(220,235,245,0.22)' : 'rgba(18,28,44,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (var x = 0.5; x < w; x += 24) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (var y = 0.5; y < h; y += 24) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    // type specimen
    ctx.fillStyle = ink;
    ctx.textBaseline = 'top';
    var lines = ['光は境界で曲がる。', 'n₁ sin θ₁ = n₂ sin θ₂', 'LIQUID GLASS · 屈折率 1.50', '静けさを、調律する。'];
    var fs = Math.max(18, Math.min(34, w / 18));
    for (var row = 0; row * fs * 1.9 < h + fs; row++) {
      ctx.font = (row % 2 ? '500 ' : '800 ') + fs + 'px ' + (row % 2 ? token('--font-mono') : token('--font-display'));
      ctx.fillText(lines[row % lines.length], 18 - (row % 3) * 24, 14 + row * fs * 1.9);
    }
    if (LG) LG.invalidateBackdrop(pg);
  }

  var fields = {
    thickness: { el: $('#pg-thickness'), out: $('#o-thickness'), fmt: function (v) { return v.toFixed(0) + ' px'; } },
    bezel: { el: $('#pg-bezel'), out: $('#o-bezel'), fmt: function (v) { return v.toFixed(0) + ' px'; } },
    ior: { el: $('#pg-ior'), out: $('#o-ior'), fmt: function (v) { return v.toFixed(2); } },
    blur: { el: $('#pg-blur'), out: $('#o-blur'), fmt: function (v) { return v.toFixed(1) + ' px'; } },
    aberration: { el: $('#pg-aberration'), out: $('#o-aberration'), fmt: function (v) { return v.toFixed(2); } },
    specular: { el: $('#pg-specular'), out: $('#o-specular'), fmt: function (v) { return v.toFixed(2); } }
  };
  var pgOpts = { profile: 'squircle' };
  var pgRaf = 0;
  function readPlayground() {
    Object.keys(fields).forEach(function (k) {
      var f = fields[k], v = +f.el.value;
      f.out.textContent = f.fmt(v);
      pgOpts[k] = v;
    });
    if (!pgRaf) pgRaf = requestAnimationFrame(function () {
      pgRaf = 0;
      if (LG) LG.update(sample, pgOpts);
    });
  }
  $('#pg-form').addEventListener('input', readPlayground);
  $('#pg-form').addEventListener('submit', function (e) { e.preventDefault(); });
  $('#pg-profile').addEventListener('lg:change', function (e) { pgOpts.profile = e.detail.value; readPlayground(); });

  var MODE_TEXT = {
    native: ['native', 'Chromium 系ブラウザです。SVG の変位フィルターを backdrop-filter に適用し、背後にある DOM をそのまま屈折させています。'],
    mirror: ['mirror', 'WebGL で背景のキャンバスを屈折させて描いています（Safari・Firefox など）。屈折するのは data-lg-backdrop で指定した背景です。'],
    fallback: ['fallback', '屈折なしのすりガラス表示です。縁のハイライトは同じ光学計算から生成しています。']
  };
  function showMode() {
    var m = LG ? LG.getMode(sample) : null;
    var t = MODE_TEXT[m] || ['CSS のみ', 'JavaScript が読み込まれていないため、CSS だけで描いています。'];
    $('#mode-name').textContent = t[0];
    $('#mode-desc').textContent = t[1];
  }
  sample.addEventListener('lg:ready', showMode);

  /* ---------------------------------------------------------------- */
  /* Beta form                                                         */
  /* ---------------------------------------------------------------- */
  $('#beta-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('#beta-email'), msg = $('#form-msg');
    if (!input.value || !input.checkValidity()) {
      msg.textContent = 'メールアドレスの形式を確認してください（例: you@example.com）。';
      input.focus();
      return;
    }
    msg.textContent = 'これはデモページなので、' + input.value + ' はどこにも送信していません。';
  });

  /* ---------------------------------------------------------------- */
  /* Boot                                                              */
  /* ---------------------------------------------------------------- */
  paintScene(0);
  paintArt();
  paintPlayground();
  readPlayground();
  startLoop();
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { paintScene(lastT); paintPlayground(); });
  }
  setTimeout(showMode, 800);
})();
