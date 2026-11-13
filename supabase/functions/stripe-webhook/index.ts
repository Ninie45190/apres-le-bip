// Le bip des mariés — fonction serveur « stripe-webhook » : appelée par Stripe quand un paiement aboutit.
// Vérifie la signature, crée le code d'achat (une seule fois par paiement), l'envoie par e-mail à l'acheteur et prévient la vendeuse.
import { createClient } from 'npm:@supabase/supabase-js@2';

const SITE = (Deno.env.get('SITE_URL') ?? 'https://lebipdesmaries.fr').replace(/\/$/, '');
const FROM = Deno.env.get('MAIL_FROM') ?? 'Le bip des mariés <contact@lebipdesmaries.fr>';
const REPLY_TO = Deno.env.get('MAIL_REPLY_TO') ?? 'virginie.maitredujeu@gmail.com';
const NAMES: Record<string, string> = { standard: 'formule Essentielle', capsule: 'formule Time capsule', upgrade: 'ajout de la time capsule' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

async function secret(sb: any, name: string): Promise<string | undefined> {
  const env = Deno.env.get(name);
  if (env) return env;
  const { data } = await sb.from('app_secrets').select('value').eq('name', name).maybeSingle();
  return data?.value ?? undefined;
}

async function validSignature(body: string, header: string, whsec: string) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts['t']); if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(whsec), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${t}.${body}`)));
  const hex = [...sig].map((x) => x.toString(16).padStart(2, '0')).join('');
  return header.split(',').some((p) => p.startsWith('v1=') && p.slice(3) === hex);
}

async function sendMail(key: string, to: string, subject: string, html: string, text: string) {
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, html, text }) });
  return r.ok;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Méthode refusée', { status: 405 });
  const body = await req.text();
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const whsec = await secret(sb, 'STRIPE_WEBHOOK_SECRET');
  if (!whsec) return new Response('non configuré', { status: 501 });
  if (!(await validSignature(body, req.headers.get('stripe-signature') ?? '', whsec))) return new Response('signature invalide', { status: 400 });

  let ev: any; try { ev = JSON.parse(body); } catch { return new Response('invalide', { status: 400 }); }
  if (ev.type !== 'checkout.session.completed' && ev.type !== 'checkout.session.async_payment_succeeded') return new Response('ignoré', { status: 200 });
  const s = ev.data?.object;
  if (!s || s.payment_status !== 'paid') return new Response('en attente', { status: 200 });
  const kind = String(s.metadata?.kind ?? ''); const email = String(s.customer_details?.email ?? s.customer_email ?? '');
  if (!NAMES[kind] || !email) return new Response('commande incomplète', { status: 200 });

  const { data: code, error } = await sb.rpc('site_sale', { p_session: s.id, p_kind: kind, p_email: email, p_amount: s.amount_total ?? 0 });
  if (error || !code) return new Response('erreur', { status: 500 });          // Stripe réessaiera

  const { data: row } = await sb.from('codes').select('mail_sent').eq('code', code).maybeSingle();
  const key = await secret(sb, 'RESEND_API_KEY');
  if (key && !(row as any)?.mail_sent) {
    const link = `${SITE}/acces.html`;
    const label = NAMES[kind], amount = ((s.amount_total ?? 0) / 100).toFixed(2).replace('.', ',') + ' €';
    const how = kind === 'upgrade' ? `Ouvrez votre espace des mariés, puis « Ajouter la time capsule », et saisissez ce code.` : `Rendez-vous sur ${link}, saisissez ce code, puis créez votre livre d'or (2 minutes).`;
    const text = `Bonjour,\n\nMerci pour votre achat (${label}, ${amount}).\n\nVotre code d'accès :\n${code}\n\n${how}\n\nConservez cet e-mail : le code n'est utilisable qu'une seule fois.\n\nUne question ? Répondez simplement à cet e-mail.\n\nLe bip des mariés — ${SITE.replace(/^https?:\/\//, '')}`;
    const html = `<div style="background:#f8f5ef;padding:32px 16px;font-family:Georgia,'Times New Roman',serif;color:#3b3226"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d9c48a;padding:36px 30px;text-align:center">
      <p style="letter-spacing:.3em;text-transform:uppercase;font-size:11px;color:#8b7d68;margin:0 0 10px">Merci pour votre achat</p>
      <h1 style="font-weight:400;font-size:28px;margin:0 0 6px;color:#8a6a24">Le bip des mariés</h1>
      <p style="font-style:italic;margin:0 0 22px">${esc(label)} · ${esc(amount)}</p>
      <p style="margin:0 0 8px;font-size:13px;letter-spacing:.15em;text-transform:uppercase;color:#8b7d68">Votre code d'accès</p>
      <p style="margin:0 0 22px;font-size:22px;letter-spacing:.08em;border:1px solid #d9c48a;padding:14px">${esc(code)}</p>
      <p style="margin:0 0 22px"><a href="${esc(link)}" style="display:inline-block;background:#b08d3c;color:#fff;padding:14px 26px;text-decoration:none;letter-spacing:.12em;text-transform:uppercase;font-size:12px">J'ai un code</a></p>
      <p style="font-size:14px;line-height:1.6;margin:0 0 14px">${esc(how)}</p>
      <p style="font-size:12px;color:#8b7d68;margin:0">Conservez cet e-mail : le code n'est utilisable qu'une seule fois.<br>Une question ? Répondez simplement à ce message.</p></div></div>`;
    const ok = await sendMail(key, email, `Votre code d'accès — Le bip des mariés`, html, text);
    if (ok) await sb.from('codes').update({ mail_sent: true }).eq('code', code);
    await sendMail(key, REPLY_TO, `Nouvelle vente : ${label} (${amount})`, `<p>Nouvelle vente en ligne : ${esc(label)}, ${esc(amount)}.<br>Acheteur : ${esc(email)}<br>Code : ${esc(code)}<br>Commande : ${esc(s.id)}</p>`, `Nouvelle vente en ligne : ${label}, ${amount}. Acheteur : ${email}. Code : ${code}. Commande : ${s.id}`);
  }
  return new Response('ok', { status: 200 });
});
