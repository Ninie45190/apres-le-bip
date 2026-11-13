/* Le bip des mariés — montage vidéo : répondeur des mariés + messages de la soirée + photos qui défilent.
   Aperçu dans le navigateur, export MP4 (H.264 + AAC) avec WebCodecs et mp4-muxer. */
const Montage = (() => {
  const W = 1280, H = 720, FPS = 20;
  const INTRO = 4, OUTRO = 5, GAP = 1.2, MIN_HOLD = 4.5, MAX_HOLD = 11, FADE = 0.9;
  const GOLD = '#8a6a24', INK = '#3b3226', SOFT = '#8b7d68';

  let shared = null;
  const actx = () => shared || (shared = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }));
  const SR = () => actx().sampleRate;
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------- Son ---------- */
  const pcmCache = new Map();   // blob -> Float32Array (mono, volume égalisé)
  async function pcm(blob) {
    if (pcmCache.has(blob)) return pcmCache.get(blob);
    const buf = await actx().decodeAudioData(await blob.arrayBuffer());
    const n = buf.length, out = new Float32Array(n);
    for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / buf.numberOfChannels; }
    let peak = 0; for (let i = 0; i < n; i++) { const a = Math.abs(out[i]); if (a > peak) peak = a; }
    const gain = peak > 0 ? Math.min(4, 0.85 / peak) : 1;           // tous les messages au même niveau
    if (gain !== 1) for (let i = 0; i < n; i++) out[i] *= gain;
    pcmCache.set(blob, out);
    if (pcmCache.size > 4) pcmCache.delete(pcmCache.keys().next().value);
    return out;
  }

  /* ---------- Plan du montage ----------
     spec : { names, date, greeting: Blob|null, voices: [{ name, blob }], photos: [{ url, guest }] } */
  const norm = x => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const author = x => { const n = norm(x); return n === 'invite' || n === 'un-invite' ? '' : n; };
  const spread = (list, n) => list.length <= n ? list.slice() : Array.from({ length: n }, (_, i) => list[Math.round(i * (list.length - 1) / Math.max(1, n - 1))]);

  async function prepare(spec, onProgress) {
    const items = [];
    if (spec.greeting) items.push({ kind: 'greeting', label: 'Le répondeur de ' + spec.names, blob: spec.greeting });
    for (const v of spec.voices) items.push({ kind: 'voice', who: v.name, label: 'Message de ' + (v.name || 'un invité'), blob: v.blob });
    // Le répondeur passe pendant l'intro ; les messages suivent l'un après l'autre
    const segs = []; let introEnd = INTRO, t = 0, skipped = 0;
    for (let i = 0; i < items.length; i++) {
      if (onProgress) onProgress(i / Math.max(1, items.length), 'Analyse du son ' + (i + 1) + ' / ' + items.length + '…');
      try {
        const p = await pcm(items[i].blob), dur = p.length / SR();
        if (items[i].kind === 'greeting') { segs.push({ ...items[i], start: 0, end: dur, dur }); introEnd = Math.max(INTRO, dur + 1.2); t = introEnd; }
        else { if (!t) t = introEnd; segs.push({ ...items[i], start: t, end: t + dur, dur }); t += dur + GAP; }
      } catch (e) { skipped++; }
    }
    pcmCache.clear();
    const photos = spec.photos || [];
    const voiceSegs = segs.filter(g => g.kind === 'voice');
    // Fenêtres d'images : une par message (jusqu'au début du suivant), ou une seule s'il n'y a que des photos
    let audioEnd, wins;
    if (voiceSegs.length) {
      audioEnd = voiceSegs[voiceSegs.length - 1].end;
      wins = voiceSegs.map((g, i) => ({ start: i === 0 ? introEnd : g.start, end: i + 1 < voiceSegs.length ? voiceSegs[i + 1].start : audioEnd, who: author(g.who), photos: [] }));
    } else {
      audioEnd = introEnd + (photos.length ? Math.min(60, photos.length * 6) : 0);
      wins = photos.length ? [{ start: introEnd, end: audioEnd, who: '', photos: [] }] : [];
    }
    // 1) chaque photo va avec le message de son auteur
    const pool = [];
    for (const ph of photos) {
      const w = author(ph.guest) && wins.find(x => x.who && x.who === author(ph.guest));
      (w ? w.photos : pool).push(ph);
    }
    for (const w of wins) { const fit = Math.max(1, Math.floor((w.end - w.start) / 3)); if (w.photos.length > fit) { const keep = spread(w.photos, fit); pool.push(...w.photos.filter(x => !keep.includes(x))); w.photos = keep; } }
    // 2) les autres photos se répartissent sur les messages qui n'ont encore aucune image
    const empty = wins.filter(w => !w.photos.length);
    if (empty.length && pool.length) {
      const per = Math.max(1, Math.round(pool.length / empty.length)); let k = 0;
      for (const w of empty) {
        const fit = Math.max(1, Math.floor((w.end - w.start) / MIN_HOLD));
        w.photos = pool.slice(k, k + Math.min(per, fit)); k += w.photos.length;
        if (!w.photos.length) w.photos = [pool[(k++) % pool.length]];
      }
    }
    // 3) s'il reste des fenêtres vides, on réutilise des photos pour ne jamais laisser l'écran vide
    for (const w of wins) if (!w.photos.length && photos.length) w.photos = [photos[Math.floor(Math.random() * photos.length)]];
    const slots = []; let rk = 0;
    for (const w of wins) {
      const n = w.photos.length; if (!n) continue;
      const hold = Math.min(MAX_HOLD, (w.end - w.start) / n);
      for (let i = 0; i < n; i++, rk++) {
        const start = w.start + i * ((w.end - w.start) / n), end = i === n - 1 ? w.end : start + (w.end - w.start) / n;
        slots.push({ start, end, hold: Math.max(2, end - start), photo: w.photos[i], rot: (rk % 2 ? 1 : -1) * (0.6 + (rk * 37 % 10) / 10) });
      }
    }
    return { names: spec.names, date: spec.date, segs, slots, introEnd, audioEnd, total: audioEnd + OUTRO, skipped, photoCount: new Set(slots.map(s => s.photo.url)).size };
  }

  /* ---------- Images ---------- */
  function imageStore() {
    const cache = new Map(), pending = new Map();
    return {
      get: u => cache.get(u) || null,
      load(u) {
        if (cache.has(u)) return Promise.resolve(cache.get(u));
        if (!pending.has(u)) pending.set(u, (async () => {
          const bmp = await createImageBitmap(await (await fetch(u)).blob());
          cache.set(u, bmp);
          while (cache.size > 6) { const k = cache.keys().next().value; try { cache.get(k).close(); } catch (e) {} cache.delete(k); }
          pending.delete(u); return bmp;
        })().catch(e => { pending.delete(u); throw e; }));
        return pending.get(u);
      },
      clear() { for (const b of cache.values()) try { b.close(); } catch (e) {} cache.clear(); }
    };
  }

  /* ---------- Dessin d'une image du film ---------- */
  function fitText(ctx, text, font, maxW, size) {
    do { ctx.font = font.replace('{s}', size); size -= 4; } while (ctx.measureText(text).width > maxW && size > 30);
    return size;
  }
  function ornament(ctx, y) {
    ctx.strokeStyle = 'rgba(176,141,60,.8)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(W / 2 - 220, y); ctx.lineTo(W / 2 - 22, y); ctx.moveTo(W / 2 + 22, y); ctx.lineTo(W / 2 + 220, y); ctx.stroke();
    ctx.fillStyle = GOLD; ctx.save(); ctx.translate(W / 2, y); ctx.rotate(Math.PI / 4); ctx.fillRect(-6, -6, 12, 12); ctx.restore();
  }
  function background(ctx) {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#fffdf8'); g.addColorStop(.55, '#f8f5ef'); g.addColorStop(1, '#f2e9d6');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const r = ctx.createRadialGradient(W * .85, H * .15, 0, W * .85, H * .15, W * .5);
    r.addColorStop(0, 'rgba(247,236,238,.8)'); r.addColorStop(1, 'rgba(247,236,238,0)'); ctx.fillStyle = r; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(176,141,60,.55)'; ctx.lineWidth = 1.5; ctx.strokeRect(26, 26, W - 52, H - 52);
    ctx.strokeStyle = 'rgba(176,141,60,.3)'; ctx.lineWidth = 1; ctx.strokeRect(34, 34, W - 68, H - 68);
  }
  function card(ctx, tl, kind, a) {
    ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, a)); ctx.textAlign = 'center'; ctx.fillStyle = INK;
    if (kind === 'intro') {
      ctx.fillStyle = SOFT; ctx.font = '400 24px Jost, sans-serif'; ctx.letterSpacing = '9px';
      ctx.fillText((fmtDate(tl.date) || 'Notre soirée').toUpperCase(), W / 2, 250);
      ctx.letterSpacing = '0px'; ctx.fillStyle = GOLD;
      fitText(ctx, tl.names, '400 {s}px "Pinyon Script", cursive', 1000, 140);
      ctx.fillText(tl.names, W / 2, 400);
      ornament(ctx, 450);
      ctx.fillStyle = INK; ctx.font = 'italic 400 38px "Cormorant Garamond", serif';
      ctx.fillText('Les messages de notre soirée', W / 2, 525);
    } else {
      ctx.fillStyle = GOLD; ctx.font = '400 150px "Pinyon Script", cursive'; ctx.fillText('Merci', W / 2, 360);
      ornament(ctx, 415);
      ctx.fillStyle = INK; ctx.font = 'italic 400 44px "Cormorant Garamond", serif'; ctx.fillText(tl.names, W / 2, 500);
      ctx.fillStyle = SOFT; ctx.font = '400 20px Jost, sans-serif'; ctx.letterSpacing = '7px'; ctx.fillText('LE BIP DES MARIÉS', W / 2, 600); ctx.letterSpacing = '0px';
    }
    ctx.restore();
  }
  function polaroid(ctx, bmp, slot, lt, alpha) {
    if (!bmp || alpha <= 0) return;
    const PAD = 20, PADB = 62, maxW = 980, maxH = 420;
    const s = Math.min(maxW / bmp.width, maxH / bmp.height), w = bmp.width * s, h = bmp.height * s;
    ctx.save(); ctx.globalAlpha = Math.min(1, alpha); ctx.translate(W / 2, 322); ctx.rotate(slot.rot * Math.PI / 180);
    ctx.shadowColor = 'rgba(80,60,20,.38)'; ctx.shadowBlur = 42; ctx.shadowOffsetY = 18; ctx.fillStyle = '#fff';
    ctx.fillRect(-w / 2 - PAD, -h / 2 - PAD, w + 2 * PAD, h + PAD + PADB);
    ctx.shadowColor = 'transparent';
    ctx.save(); ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ctx.clip();
    const k = 1 + 0.05 * Math.min(1, lt / (slot.hold + FADE)); ctx.scale(k, k);
    ctx.drawImage(bmp, -w / 2, -h / 2, w, h); ctx.restore();
    const who = slot.photo.guest;
    if (who) { ctx.fillStyle = GOLD; ctx.textAlign = 'center'; ctx.font = '400 40px "Pinyon Script", cursive'; ctx.fillText(who, 0, h / 2 + PADB - 14); }
    ctx.restore();
  }
  function drawFrame(ctx, tl, t, getImg) {
    background(ctx);
    if (t < tl.introEnd) { card(ctx, tl, 'intro', Math.min(t / .9, (tl.introEnd - t) / .8, 1)); }
    // photos
    const fadeOut = t > tl.audioEnd ? 1 - (t - tl.audioEnd) / 1.0 : 1;
    let k = -1; for (let i = 0; i < tl.slots.length; i++) if (t >= tl.slots[i].start) k = i; else break;
    if (k >= 0 && t <= tl.audioEnd + 1) {
      const s = tl.slots[k], lt = t - s.start;
      if (k > 0 && lt < FADE) { const p = tl.slots[k - 1]; polaroid(ctx, getImg(p.photo.url), p, p.hold + lt, fadeOut); }
      polaroid(ctx, getImg(s.photo.url), s, lt, Math.min(1, lt / FADE) * fadeOut);
    }
    // légende du message en cours
    const seg = tl.segs.find(g => t >= g.start && t <= g.end);
    if (seg) {
      const a = Math.max(0, Math.min(1, (t - seg.start) / .5, (seg.end - t) / .5));
      ctx.save(); ctx.globalAlpha = a; ctx.textAlign = 'center'; ctx.fillStyle = INK; ctx.font = 'italic 400 36px "Cormorant Garamond", serif';
      ctx.fillText(seg.label, W / 2, 664);
      ctx.fillStyle = 'rgba(176,141,60,.35)'; ctx.fillRect(W / 2 - 200, 684, 400, 2);
      ctx.fillStyle = GOLD; ctx.fillRect(W / 2 - 200, 684, 400 * (t - seg.start) / seg.dur, 2);
      ctx.restore();
    }
    if (t > tl.audioEnd) card(ctx, tl, 'outro', (t - tl.audioEnd) / 1.2);
  }

  async function ensureFonts() {
    try { await Promise.all(['400 40px "Pinyon Script"', 'italic 400 30px "Cormorant Garamond"', '400 20px Jost'].map(f => document.fonts.load(f, 'AaÉé'))); } catch (e) {}
  }
  const slotAt = (tl, t) => { let k = -1; for (let i = 0; i < tl.slots.length; i++) if (t >= tl.slots[i].start - 0.01) k = i; else break; return k; };

  /* ---------- Aperçu ---------- */
  function play(tl, canvas, cb) {
    const ctx = canvas.getContext('2d'), ac = actx(), store = imageStore();
    canvas.width = W; canvas.height = H;
    let stopped = false, t0 = 0; const sources = []; const started = new Set();
    const ready = (async () => {
      await ensureFonts(); if (ac.state === 'suspended') await ac.resume();
      for (const s of tl.slots.slice(0, 2)) await store.load(s.photo.url).catch(() => {});
      t0 = ac.currentTime + 0.15;
    })();
    async function startSeg(seg) {
      if (started.has(seg)) return; started.add(seg);
      try {
        const p = await pcm(seg.blob), buf = ac.createBuffer(1, p.length, ac.sampleRate); buf.copyToChannel(p, 0);
        const src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination);
        src.start(Math.max(ac.currentTime, t0 + seg.start)); sources.push(src);
      } catch (e) {}
    }
    (async function loop() {
      await ready;
      while (!stopped) {
        const t = ac.currentTime - t0;
        if (t >= tl.total) break;
        for (const g of tl.segs) if (t >= g.start - 5 && t <= g.end) startSeg(g);
        const k = slotAt(tl, Math.max(0, t));
        for (const j of [k, k + 1]) if (j >= 0 && tl.slots[j]) store.load(tl.slots[j].photo.url).catch(() => {});
        drawFrame(ctx, tl, Math.max(0, t), u => store.get(u));
        if (cb && cb.onTime) cb.onTime(Math.max(0, t));
        await new Promise(r => requestAnimationFrame(r));
      }
      sources.forEach(s => { try { s.stop(); } catch (e) {} }); store.clear();
      if (cb && cb.onEnd) cb.onEnd();
    })();
    return { stop() { stopped = true; sources.forEach(s => { try { s.stop(); } catch (e) {} }); } };
  }

  /* ---------- Export MP4 ---------- */
  function supported() {
    return typeof VideoEncoder !== 'undefined' && typeof AudioEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && typeof AudioData !== 'undefined' && typeof Mp4Muxer !== 'undefined';
  }

  async function exportMp4(tl, onProgress, ctrl) {
    ctrl = ctrl || {};
    const sr = SR(), canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d'), store = imageStore();
    const target = new Mp4Muxer.ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({ target, video: { codec: 'avc', width: W, height: H }, audio: { codec: 'aac', numberOfChannels: 1, sampleRate: sr }, fastStart: 'in-memory' });
    let fail = null;
    const venc = new VideoEncoder({ output: (c, m) => muxer.addVideoChunk(c, m), error: e => { fail = e; } });
    venc.configure({ codec: 'avc1.640028', width: W, height: H, bitrate: 1200000, framerate: FPS });
    const aenc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { fail = e; } });
    aenc.configure({ codec: 'mp4a.40.2', sampleRate: sr, numberOfChannels: 1, bitrate: 96000 });
    await ensureFonts();

    // 1) son : on assemble la piste seconde par seconde
    const totalSamples = Math.ceil(tl.total * sr);
    let cur = null;   // { seg, data }
    for (let off = 0; off < totalSamples; off += sr) {
      if (ctrl.cancel) throw new Error('annulé'); if (fail) throw fail;
      const n = Math.min(sr, totalSamples - off), chunk = new Float32Array(n);
      for (const g of tl.segs) {
        const gs = Math.round(g.start * sr), ge = gs + Math.round(g.dur * sr);
        if (ge <= off || gs >= off + n) continue;
        if (!cur || cur.seg !== g) cur = { seg: g, data: await pcm(g.blob) };
        const from = Math.max(off, gs), to = Math.min(off + n, ge);
        for (let i = from; i < to; i++) chunk[i - off] = cur.data[i - gs] || 0;
      }
      const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: n, numberOfChannels: 1, timestamp: Math.round(off / sr * 1e6), data: chunk });
      aenc.encode(ad); ad.close();
      while (aenc.encodeQueueSize > 30) await sleep(0);
      if (onProgress && (off / sr) % 20 === 0) onProgress(0.12 * off / totalSamples, 'Préparation du son…');
    }
    await aenc.flush();

    // 2) images
    const frames = Math.ceil(tl.total * FPS);
    for (let i = 0; i < frames; i++) {
      if (ctrl.cancel) throw new Error('annulé'); if (fail) throw fail;
      const t = i / FPS, k = slotAt(tl, t);
      for (const j of [k - 1, k, k + 1]) if (j >= 0 && tl.slots[j] && Math.abs(tl.slots[j].start - t) < 30) { try { await store.load(tl.slots[j].photo.url); } catch (e) {} }
      drawFrame(ctx, tl, t, u => store.get(u));
      const vf = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / FPS) });
      venc.encode(vf, { keyFrame: i % (FPS * 2) === 0 }); vf.close();
      while (venc.encodeQueueSize > 8) await sleep(0);
      if (i % 20 === 0) { if (onProgress) onProgress(0.12 + 0.88 * i / frames, 'Création de la vidéo… ' + Math.round(100 * i / frames) + ' %'); await sleep(0); }
    }
    await venc.flush(); muxer.finalize(); store.clear();
    return new Blob([target.buffer], { type: 'video/mp4' });
  }

  async function poster(canvas, names, date) {
    await ensureFonts(); canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d'); background(ctx); card(ctx, { names, date }, 'intro', 1);
  }

  return { prepare, play, poster, exportMp4, supported, durationOf: tl => tl.total };
})();
