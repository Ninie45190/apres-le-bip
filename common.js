/* Après le bip — fonctions partagées (invités + mariés) */
const PREFIX = 'apreslebip-';

function pickMime() {
  if (!window.MediaRecorder) return '';
  const c = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  return c.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

function extFor(mime) {
  mime = (mime || '').toLowerCase();
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  return 'm4a';
}

function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  if (isNaN(d)) return '';
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

function coupleNames(a, b) {
  a = (a || '').trim(); b = (b || '').trim();
  return a && b ? a + ' & ' + b : (a || b || 'Les mariés');
}

/* Démarre un enregistrement micro. onLevel(0..1) est appelé en continu. */
async function startRecorder(onLevel) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = pickMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : {});
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  let ctx = null, raf = 0;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(an);
    const buf = new Uint8Array(an.fftSize);
    (function loop() {
      an.getByteTimeDomainData(buf);
      let s = 0;
      for (const v of buf) { const x = (v - 128) / 128; s += x * x; }
      if (onLevel) onLevel(Math.min(1, Math.sqrt(s / buf.length) * 4));
      raf = requestAnimationFrame(loop);
    })();
  } catch (e) { /* pas de visualisation, l'enregistrement continue */ }
  const t0 = Date.now();
  rec.start();
  return {
    stop() {
      return new Promise(res => {
        rec.onstop = () => {
          cancelAnimationFrame(raf);
          if (ctx) ctx.close();
          stream.getTracks().forEach(t => t.stop());
          const type = (rec.mimeType || mime || 'audio/mp4').split(';')[0];
          res({ blob: new Blob(chunks, { type }), mime: type, dur: Math.round((Date.now() - t0) / 1000) });
        };
        rec.stop();
      });
    }
  };
}

/* Le « bip » du répondeur */
function beep(ctx) {
  return new Promise(res => {
    try {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.03);
      g.gain.setValueAtTime(0.25, ctx.currentTime + 0.45);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.55);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + 0.6);
      o.onended = res;
      setTimeout(res, 900);
    } catch (e) { res(); }
  });
}

/* ---------- Supabase (appels de fonctions, sans bibliothèque) ---------- */
const CONFIGURED = typeof CFG !== 'undefined' && CFG.url && !CFG.url.includes('VOTRE-PROJET');

async function api(fn, args) {
  const h = { 'Content-Type': 'application/json', apikey: CFG.key };
  if (CFG.key.startsWith('eyJ')) h.Authorization = 'Bearer ' + CFG.key;
  const r = await fetch(CFG.url + '/rest/v1/rpc/' + fn, { method: 'POST', headers: h, body: JSON.stringify(args) });
  if (!r.ok) { let m = ''; try { m = (await r.json()).message; } catch (e) {} const err = new Error(m || ('HTTP ' + r.status)); err.status = r.status; throw err; }
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

function blobToB64(blob) {
  return new Promise((ok, ko) => { const f = new FileReader(); f.onload = () => ok(String(f.result).split(',')[1] || ''); f.onerror = ko; f.readAsDataURL(blob); });
}
function b64ToBlob(b64, mime) {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: mime });
}
function randId(n, alpha) {
  alpha = alpha || 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(n)), b => alpha[b % alpha.length]).join('');
}

/* ---------- Zip sans bibliothèque (fichiers non compressés) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const d = new Date(), dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)), dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate());
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(c.buffer, name);
    off += 30 + name.length + size;
  }
  const csize = central.reduce((s, p) => s + (p.byteLength || p.length), 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, e.buffer], { type: 'application/zip' });
}

/* ---------- Photos & vidéos ---------- */
async function fnCall(name, body) {
  const r = await fetch(CFG.url + '/functions/v1/' + name, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CFG.key }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (!r.ok) { const err = new Error(j.error || ('HTTP ' + r.status)); err.status = r.status; throw err; }
  return j;
}
const mediaApi = body => fnCall('media', body);

function fmtSize(n) { return n >= 1048576 ? (n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko'; }
function prettyGuest(slug) { const s = (slug || '').split('-').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join('-'); return !s || s === 'Invite' ? 'Invité' : s; }

const MIME_BY_EXT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', webm: 'video/webm', '3gp': 'video/3gpp' };
function mimeOf(file) {
  const t = (file.type || '').toLowerCase().split(';')[0];
  if (t) return t;
  const m = /\.([a-z0-9]+)$/i.exec(file.name || '');
  return (m && MIME_BY_EXT[m[1].toLowerCase()]) || '';
}

/* Format HEIC/HEIF (photos d'iPhone) : lu nativement par Safari ; sinon on charge un convertisseur de secours (1,3 Mo, seulement si nécessaire) */
const isHeic = (file, mime) => /hei[cf]/.test(mime || '') || /\.hei[cf]$/i.test(file.name || '');
let heicLib = null;
function loadHeicLib() {
  if (window.heic2any) return Promise.resolve();
  if (!heicLib) heicLib = new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = 'vendor/heic2any.min.js';
    s.onload = ok; s.onerror = () => { heicLib = null; ko(new Error('convertisseur HEIC indisponible')); };
    document.head.appendChild(s);
  });
  return heicLib;
}
async function heicToJpeg(file) {
  await loadHeicLib();
  const out = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 });
  return Array.isArray(out) ? out[0] : out;
}
async function decodeImage(file, mime) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    if (!isHeic(file, mime)) throw e;
    return await createImageBitmap(await heicToJpeg(file), { imageOrientation: 'from-image' });   // HEIC illisible par le navigateur : conversion en JPEG
  }
}

/* Réduit une photo (≈ 1 Mo au lieu de 4-8 Mo) et la convertit toujours en JPEG ; en cas d'échec on garde l'original */
async function compressImage(file, maxSide, quality, mirror) {
  maxSide = maxSide || 2400; quality = quality || 0.85;
  const mime = mimeOf(file);
  try {
    const bmp = await decodeImage(file, mime);
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d');
    if (mirror) { cx.translate(w, 0); cx.scale(-1, 1); }   // selfie : image retournée comme dans un miroir
    cx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', quality));
    if (blob && (mirror || mime !== 'image/jpeg' || blob.size < file.size)) return { blob, mime: 'image/jpeg' };
  } catch (e) { /* format non décodable : on envoie tel quel */ }
  return { blob: file, mime };
}

/* Envoi d'un fichier vers l'adresse signée, avec progression */
function putFile(url, blob, mime, onProgress) {
  return new Promise((ok, ko) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    x.setRequestHeader('apikey', CFG.key);
    x.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    x.onload = () => (x.status >= 200 && x.status < 300) ? ok() : ko(Object.assign(new Error('HTTP ' + x.status), { status: x.status }));
    x.onerror = () => ko(new Error('réseau'));
    x.ontimeout = () => ko(new Error('délai dépassé'));
    x.timeout = 10 * 60 * 1000;
    const fd = new FormData();
    fd.append('cacheControl', '31536000');
    fd.append('', blob instanceof File || blob.type === mime ? blob : new Blob([blob], { type: mime }), 'f');
    x.send(fd);
  });
}
