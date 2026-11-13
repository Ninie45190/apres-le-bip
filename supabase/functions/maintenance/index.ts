// Le bip des mariés — fonction serveur « maintenance » (appelée chaque jour par pg_cron) :
//  1) livre les time capsules arrivées à échéance (2 e-mails distincts, par sécurité) ;
//  2) supprime automatiquement les livres d'or (messages, photos, vidéos) après la durée de conservation.
// Sans danger si quelqu'un l'appelle : elle n'exécute que du travail déjà « dû » et ne renvoie que des compteurs.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const SITE = (Deno.env.get('SITE_URL') ?? 'https://lebipdesmaries.fr').replace(/\/$/, '');
const FROM = Deno.env.get('MAIL_FROM') ?? 'Le bip des mariés <contact@lebipdesmaries.fr>';
const REPLY_TO = Deno.env.get('MAIL_REPLY_TO') ?? 'virginie.maitredujeu@gmail.com';

// Clé Resend : variable d'environnement si elle existe, sinon table fermée « app_secrets » (inaccessible depuis un navigateur)
async function resendKey(sb: any): Promise<string | undefined> {
  const env = Deno.env.get('RESEND_API_KEY');
  if (env) return env;
  const { data } = await sb.from('app_secrets').select('value').eq('name', 'RESEND_API_KEY').maybeSingle();
  return data?.value ?? undefined;
}
const RETENTION_DAYS = Number(Deno.env.get('RETENTION_DAYS') ?? 90);          // après la date du mariage
const CAPSULE_KEEP_DAYS = Number(Deno.env.get('CAPSULE_KEEP_DAYS') ?? 90);    // après la livraison de la capsule

const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const bucket = sb.storage.from('media');
  const KEY = await resendKey(sb);
  const today = iso(new Date());
  const report = { delivered: 0, deliveryFailed: 0, purged: 0, trimmed: 0, mailConfigured: !!KEY };

  async function removeFiles(ev: string) {
    const { data } = await sb.rpc('media_list', { p_event: ev });
    const names: string[] = (data ?? []).map((o: any) => o.name);
    for (let i = 0; i < names.length; i += 100) await bucket.remove(names.slice(i, i + 100));
    return names.length;
  }

  async function mail(to: string, subject: string, html: string, text: string) {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, html, text }) });
    return r.ok;
  }

  // ---- 1) time capsules à livrer ----
  const { data: due } = await sb.from('events').select('id,n1,n2,capsule_emails,capsule_token,capsule_last_try')
    .eq('opt_capsule', true).is('capsule_sent_at', null).lte('capsule_date', today).not('capsule_token', 'is', null).limit(50);
  for (const e of due ?? []) {
    const emails: string[] = e.capsule_emails ?? [];
    if (!emails.length) continue;
    if (e.capsule_last_try && Date.now() - new Date(e.capsule_last_try).getTime() < 6 * 3600 * 1000) continue;   // pas plus d'un essai toutes les 6 h
    await sb.from('events').update({ capsule_last_try: new Date().toISOString() }).eq('id', e.id);
    if (!KEY) { report.deliveryFailed++; continue; }
    const names = `${e.n1} & ${e.n2}`, link = `${SITE}/espace.html#${e.id}.${e.capsule_token}`;
    const subject = `Votre time capsule est arrivée — ${names}`;
    const text = `Bonjour,\n\nIl y a quelque temps, vos invités vous ont laissé des messages et des photos. Ils vous attendent.\n\nOuvrez votre time capsule :\n${link}\n\nPensez à utiliser le bouton « Tout télécharger » : le lien reste actif ${CAPSULE_KEEP_DAYS} jours.\n\nLe bip des mariés — ${SITE.replace(/^https?:\/\//, '')}`;
    const html = `<div style="background:#f8f5ef;padding:32px 16px;font-family:Georgia,'Times New Roman',serif;color:#3b3226"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d9c48a;padding:36px 30px;text-align:center">
      <p style="letter-spacing:.3em;text-transform:uppercase;font-size:11px;color:#8b7d68;margin:0 0 10px">Votre time capsule</p>
      <h1 style="font-weight:400;font-size:30px;margin:0 0 6px;color:#8a6a24">${esc(names)}</h1>
      <p style="font-style:italic;margin:0 0 24px">Il y a quelque temps, vos invités vous ont laissé des messages et des photos.<br>Ils vous attendent.</p>
      <p style="margin:0 0 22px"><a href="${esc(link)}" style="display:inline-block;background:#b08d3c;color:#fff;padding:14px 26px;text-decoration:none;letter-spacing:.12em;text-transform:uppercase;font-size:12px">Ouvrir ma time capsule</a></p>
      <p style="font-size:13px;line-height:1.6;margin:0;color:#6d6150">Pensez à utiliser le bouton « Tout télécharger » : le lien reste actif ${CAPSULE_KEEP_DAYS} jours.</p></div></div>`;
    let ok = false;
    for (const to of emails) ok = (await mail(to, subject, html, text)) || ok;      // un e-mail par adresse
    if (ok) { await sb.from('events').update({ capsule_sent_at: new Date().toISOString() }).eq('id', e.id); report.delivered++; } else report.deliveryFailed++;
  }

  // ---- 2) suppression automatique ----
  const { data: all } = await sb.from('events').select('id,wedding_date,created_at,opt_capsule,capsule_date,capsule_audio,capsule_media,capsule_sent_at,capsule_emails').limit(1000);
  for (const e of all ?? []) {
    const ref = e.wedding_date ?? String(e.created_at).slice(0, 10);
    const keepUntil = addDays(ref, RETENTION_DAYS);
    const capsuleOn = e.opt_capsule && e.capsule_date && (e.capsule_emails ?? []).length > 0;
    const purge = async () => { await removeFiles(e.id); await sb.from('events').delete().eq('id', e.id); report.purged++; };
    if (!capsuleOn) { if (today > keepUntil) await purge(); continue; }
    if (e.capsule_sent_at && today > addDays(e.capsule_date, CAPSULE_KEEP_DAYS)) { await purge(); continue; }
    if (today > keepUntil) {      // capsule en attente : on ne garde que ce que les mariés ont choisi d'inclure
      if (!e.capsule_audio) { const { count } = await sb.from('messages').delete({ count: 'exact' }).eq('event_id', e.id); report.trimmed += count ?? 0; }
      if (!e.capsule_media) report.trimmed += await removeFiles(e.id);
    }
  }
  return json(report);
});
