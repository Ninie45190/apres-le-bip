// Le bip des mariés — fonction serveur « notify » : envoie aux mariés leur lien privé et leur code secret par e-mail.
// Nécessite un compte Resend (resend.com) : secret RESEND_API_KEY (obligatoire), MAIL_FROM et SITE_URL (facultatifs).
// Tant que RESEND_API_KEY n'est pas défini, la fonction répond « mail_not_configured » et le site propose un e-mail pré-rempli.
// L'adresse e-mail n'est jamais enregistrée : elle sert uniquement à l'envoi.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const SITE = (Deno.env.get('SITE_URL') ?? 'https://lebipdesmaries.fr').replace(/\/$/, '');
const FROM = Deno.env.get('MAIL_FROM') ?? 'Le bip des mariés <contact@lebipdesmaries.fr>';
const KEY = Deno.env.get('RESEND_API_KEY');
const MAX_MAILS_PER_EVENT = 6;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

async function secretOk(row: { secret_hash: string }, secret: unknown) {
  if (typeof secret !== 'string' || secret.length < 8 || secret.length > 64) return false;
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
  return '\\x' + [...h].map((x) => x.toString(16).padStart(2, '0')).join('') === row.secret_hash;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Méthode refusée' }, 405);
  if (!KEY) return json({ error: 'mail_not_configured' }, 501);

  let b: any;
  try { b = await req.json(); } catch { return json({ error: 'Requête invalide' }, 400); }
  const ev = String(b.event ?? '');
  if (!/^[a-z0-9]{6,16}$/.test(ev)) return json({ error: 'Livre d\'or introuvable' }, 404);

  const to: string[] = (Array.isArray(b.to) ? b.to : [b.to]).map((x: unknown) => String(x ?? '').trim()).filter(Boolean).slice(0, 2);
  if (!to.length || to.some((m) => !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(m) || m.length > 120)) return json({ error: 'Adresse e-mail invalide' }, 400);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: row } = await sb.from('events').select('id,n1,n2,wedding_date,secret_hash,mail_count').eq('id', ev).maybeSingle();
  if (!row || !(await secretOk(row, b.secret))) return json({ error: 'Code incorrect' }, 403);
  if ((row.mail_count ?? 0) >= MAX_MAILS_PER_EVENT) return json({ error: 'Trop d\'e-mails envoyés pour ce livre d\'or' }, 429);

  const secret = String(b.secret);
  const names = `${row.n1} & ${row.n2}`;
  const privateLink = `${SITE}/espace.html#${ev}.${secret}`;
  const guestLink = `${SITE}/invite.html#${ev}`;
  const code = `${ev}-${secret}`;
  const subject = `Votre livre d'or « Le bip des mariés » — ${names}`;

  const text = `Bonjour,

Votre livre d'or « Le bip des mariés » est prêt.

Votre lien privé (à garder précieusement) :
${privateLink}

Votre code secret :
${code}

Avec ce lien ou ce code, vous retrouvez à tout moment les messages vocaux, les photos et les vidéos de vos invités, et vous pouvez créer votre montage. Sans eux, personne ne peut y accéder : conservez cet e-mail.

Le lien que vos invités reçoivent en scannant le QR code :
${guestLink}

Belle fête !
Le bip des mariés — ${SITE.replace(/^https?:\/\//, '')}`;

  const html = `<div style="background:#f8f5ef;padding:32px 16px;font-family:Georgia,'Times New Roman',serif;color:#3b3226">
  <div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d9c48a;padding:36px 30px;text-align:center">
    <p style="letter-spacing:.3em;text-transform:uppercase;font-size:11px;color:#8b7d68;margin:0 0 10px">Votre livre d'or</p>
    <h1 style="font-weight:400;font-size:30px;margin:0 0 6px;color:#8a6a24">${esc(names)}</h1>
    <p style="font-style:italic;margin:0 0 24px">Votre livre d'or « Le bip des mariés » est prêt.</p>
    <p style="margin:0 0 8px;font-size:13px;letter-spacing:.15em;text-transform:uppercase;color:#8b7d68">Votre lien privé</p>
    <p style="margin:0 0 22px"><a href="${esc(privateLink)}" style="display:inline-block;background:#b08d3c;color:#fff;padding:14px 26px;text-decoration:none;letter-spacing:.12em;text-transform:uppercase;font-size:12px">Ouvrir mon espace</a></p>
    <p style="margin:0 0 8px;font-size:13px;letter-spacing:.15em;text-transform:uppercase;color:#8b7d68">Votre code secret</p>
    <p style="margin:0 0 22px;font-size:20px;letter-spacing:.08em;border:1px solid #d9c48a;padding:12px;word-break:break-all">${esc(code)}</p>
    <p style="font-size:14px;line-height:1.6;margin:0 0 18px">Avec ce lien ou ce code, vous retrouvez à tout moment les messages vocaux, les photos et les vidéos de vos invités, et vous créez votre montage.<br><b>Sans eux, personne ne peut y accéder : conservez cet e-mail.</b></p>
    <p style="font-size:12px;color:#8b7d68;margin:0">Lien reçu par vos invités en scannant le QR code :<br><a href="${esc(guestLink)}" style="color:#8a6a24">${esc(guestLink)}</a></p>
  </div>
</div>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to, subject, html, text }),
  });
  if (!r.ok) return json({ error: 'L\'envoi a échoué', detail: (await r.text()).slice(0, 200) }, 502);
  await sb.from('events').update({ mail_count: (row.mail_count ?? 0) + 1 }).eq('id', ev);
  return json({ ok: true });
});
