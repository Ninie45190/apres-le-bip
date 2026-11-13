// Après le bip — fonction serveur « media » (photos & vidéos des invités)
// Rôle : autoriser les envois (livre d'or existant, tailles, quotas) et réserver lecture / suppression aux mariés (code secret).
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Limites (réglables via les variables d'environnement de la fonction)
const MAX_FILES = Number(Deno.env.get('MAX_FILES_PER_EVENT') ?? 2000);
const MAX_EVENT_BYTES = Number(Deno.env.get('MAX_EVENT_MB') ?? 3000) * 1024 * 1024;
const MAX_PHOTO = Number(Deno.env.get('MAX_PHOTO_MB') ?? 15) * 1024 * 1024;
const MAX_VIDEO = Number(Deno.env.get('MAX_VIDEO_MB') ?? 50) * 1024 * 1024;

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp', 'video/x-m4v': 'm4v',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function secretOk(row: { secret_hash: string }, secret: unknown) {
  if (typeof secret !== 'string' || secret.length < 8 || secret.length > 64) return false;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return '\\x' + [...h].map((x) => x.toString(16).padStart(2, '0')).join('') === row.secret_hash;
}

// Lecture : code secret des mariés, ou jeton de la time capsule une fois l'échéance atteinte (jamais pour supprimer)
async function readOk(row: { secret_hash: string; capsule_token: string | null; capsule_date: string | null }, secret: unknown) {
  if (await secretOk(row, secret)) return true;
  return typeof secret === 'string' && !!row.capsule_token && row.capsule_token === secret && !!row.capsule_date && row.capsule_date <= new Date().toISOString().slice(0, 10);
}

const slugOf = (s: unknown) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20) || 'invite';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Méthode refusée' }, 405);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'Requête invalide' }, 400); }

  const ev = String(b.event ?? '');
  if (!/^[a-z0-9]{6,16}$/.test(ev)) return json({ error: 'Livre d\'or introuvable' }, 404);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: row } = await sb.from('events').select('id,opt_media,secret_hash,capsule_token,capsule_date').eq('id', ev).maybeSingle();
  if (!row) return json({ error: 'Livre d\'or introuvable' }, 404);
  const bucket = sb.storage.from('media');

  try {
    switch (b.action) {
      // ---- Invité : demande d'autorisation d'envoi d'un fichier ----
      case 'sign_upload': {
        if (!row.opt_media) return json({ error: 'Les photos ne sont pas activées pour ce livre d\'or' }, 403);
        const mime = String(b.mime ?? '').toLowerCase().split(';')[0].trim();
        const ext = EXT[mime];
        if (!ext) return json({ error: 'Format non pris en charge' }, 415);
        const size = Number(b.size);
        const isVideo = mime.startsWith('video/');
        const limit = isVideo ? MAX_VIDEO : MAX_PHOTO;
        if (!(size > 0)) return json({ error: 'Fichier vide' }, 400);
        if (size > limit) return json({ error: `Fichier trop lourd (maximum ${Math.round(limit / 1048576)} Mo)` }, 413);
        const { data: st } = await sb.rpc('media_stats', { p_event: ev });
        const n = Number(st?.[0]?.n ?? 0), bytes = Number(st?.[0]?.bytes ?? 0);
        if (n >= MAX_FILES || bytes + size > MAX_EVENT_BYTES) return json({ error: 'Le livre d\'or est complet' }, 507);
        // « l » = photo envoyée sur le moment (peut être diffusée sur l'écran), « b » = lot ou vidéo (stockée seulement)
        const mode = !isVideo && b.mode === 'live' ? 'l' : 'b';
        const path = `${ev}/${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}-${mode}-${slugOf(b.guest)}.${ext}`;
        const { data, error } = await bucket.createSignedUploadUrl(path);
        if (error || !data) return json({ error: 'Autorisation impossible' }, 500);
        return json({ path, url: data.signedUrl });
      }

      // ---- Mariés (code secret) ----
      case 'list': {
        if (!(await readOk(row, b.secret))) return json({ error: 'Code incorrect' }, 403);
        const { data, error } = await sb.rpc('media_list', { p_event: ev });
        if (error) return json({ error: 'Lecture impossible' }, 500);
        const items = (data ?? []).map((o: any) => {
          const base = String(o.name).split('/')[1] ?? '';
          const parts = base.replace(/\.[^.]+$/, '').split('-');
          const hasMode = parts[2] === 'l' || parts[2] === 'b';
          const slug = parts.slice(hasMode ? 3 : 2).join('-');
          return { path: o.name, size: Number(o.size), mime: o.mime, created_at: o.created_at, guest: slug, live: parts[2] === 'l' };
        });
        return json({ items });
      }
      case 'sign_download': {
        if (!(await readOk(row, b.secret))) return json({ error: 'Code incorrect' }, 403);
        const paths: string[] = Array.isArray(b.paths) ? b.paths.slice(0, 200).map(String) : [];
        if (!paths.length || paths.some((p) => !p.startsWith(ev + '/'))) return json({ error: 'Fichiers invalides' }, 400);
        const ttl = Math.min(Math.max(Number(b.ttl) || 3600, 60), 21600); // 1 min à 6 h
        const { data, error } = await bucket.createSignedUrls(paths, ttl);
        if (error) return json({ error: 'Lecture impossible' }, 500);
        const urls: Record<string, string> = {};
        for (const d of data ?? []) if (d.signedUrl && d.path) urls[d.path] = d.signedUrl;
        return json({ urls });
      }
      case 'delete': {
        if (!(await secretOk(row, b.secret))) return json({ error: 'Code incorrect' }, 403);
        const paths: string[] = Array.isArray(b.paths) ? b.paths.slice(0, 200).map(String) : [];
        if (!paths.length || paths.some((p) => !p.startsWith(ev + '/'))) return json({ error: 'Fichiers invalides' }, 400);
        const { error } = await bucket.remove(paths);
        if (error) return json({ error: 'Suppression impossible' }, 500);
        return json({ ok: true });
      }
      default:
        return json({ error: 'Action inconnue' }, 400);
    }
  } catch (_e) {
    return json({ error: 'Erreur serveur' }, 500);
  }
});
