// Le bip des mariés — fonction serveur « shop » : paiement en ligne (Stripe Checkout : carte bancaire, PayPal, Apple Pay…).
//  - action « checkout » : crée la page de paiement Stripe pour une formule et renvoie son adresse ;
//  - action « order »   : après paiement, renvoie le code d'achat lié à la commande (la page « merci » l'affiche).
// Les prix sont fixés ICI (jamais envoyés par le navigateur). La clé Stripe est lue dans la table fermée app_secrets.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const SITE = (Deno.env.get('SITE_URL') ?? 'https://lebipdesmaries.fr').replace(/\/$/, '');
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Prix en centimes (prix de lancement). Pour passer à 39,90 € / 59,90 € : modifier ici ET dans config.js.
const PRODUCTS: Record<string, { cents: number; name: string; desc: string }> = {
  standard: { cents: 2990, name: 'Le bip des mariés — formule Essentielle', desc: "Livre d'or sonore : messages vocaux et photos de vos invités, montage vidéo. Code d'accès envoyé par e-mail." },
  capsule: { cents: 4990, name: 'Le bip des mariés — formule Time capsule', desc: "Livre d'or sonore + time capsule livrée un an après le mariage. Code d'accès envoyé par e-mail." },
  upgrade: { cents: 2490, name: 'Le bip des mariés — ajout de la time capsule', desc: "Ajoute la time capsule (livraison un an après le mariage) à un livre d'or existant. Code envoyé par e-mail." },
};

async function secret(sb: any, name: string): Promise<string | undefined> {
  const env = Deno.env.get(name);
  if (env) return env;
  const { data } = await sb.from('app_secrets').select('value').eq('name', name).maybeSingle();
  return data?.value ?? undefined;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Méthode refusée' }, 405);
  let b: any; try { b = await req.json(); } catch { return json({ error: 'Requête invalide' }, 400); }
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  if (b.action === 'order') {
    const s = String(b.session ?? '');
    if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(s)) return json({ error: 'Commande introuvable' }, 404);
    const { data } = await sb.rpc('order_code', { p_session: s });
    const row = data?.[0];
    if (!row) return json({ pending: true });                 // le paiement est en cours de confirmation
    return json({ code: row.code, kind: row.kind });
  }

  if (b.action === 'checkout') {
    const key = await secret(sb, 'STRIPE_SECRET_KEY');
    if (!key) return json({ error: 'paiement_non_configure' }, 501);
    const kind = String(b.kind ?? ''); const p = PRODUCTS[kind];
    if (!p) return json({ error: 'Formule inconnue' }, 400);
    const f = new URLSearchParams();
    f.set('mode', 'payment'); f.set('locale', 'fr');
    f.set('line_items[0][quantity]', '1');
    f.set('line_items[0][price_data][currency]', 'eur');
    f.set('line_items[0][price_data][unit_amount]', String(p.cents));
    f.set('line_items[0][price_data][product_data][name]', p.name);
    f.set('line_items[0][price_data][product_data][description]', p.desc);
    f.set('metadata[kind]', kind); f.set('metadata[site]', 'lebipdesmaries.fr');
    // Facture automatique (franchise de TVA) envoyée par Stripe avec le reçu
    f.set('invoice_creation[enabled]', 'true');
    f.set('invoice_creation[invoice_data][description]', p.name);
    f.set('invoice_creation[invoice_data][footer]', 'TVA non applicable, art. 293 B du CGI — Virginie Lavaud, entrepreneur individuel — SIRET 102 734 712 00015');
    f.set('invoice_creation[invoice_data][metadata][kind]', kind);
    f.set('payment_intent_data[description]', p.name);
    f.set('success_url', `${SITE}/merci.html?s={CHECKOUT_SESSION_ID}`);
    f.set('cancel_url', `${SITE}/acheter.html?f=${kind}`);
    f.set('custom_text[submit][message]', "Produit numérique livré immédiatement par e-mail (code d'accès). En payant, vous acceptez les conditions générales de vente et reconnaissez perdre votre droit de rétractation dès l'envoi du code.");
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: f });
    const j = await r.json();
    if (!r.ok || !j.url) return json({ error: 'Le paiement est momentanément indisponible', detail: String(j?.error?.message ?? '').slice(0, 160) }, 502);
    return json({ url: j.url });
  }
  return json({ error: 'Action inconnue' }, 400);
});
