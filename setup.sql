-- Le bip des mariés — installation complète de la base (état final). À coller UNE FOIS dans Supabase > SQL Editor > Run.
-- Fonctions serveur à déployer avec : supabase/functions/media (photos/vidéos), notify (e-mail du lien, secret RESEND_API_KEY)
-- et maintenance (livraison des time capsules + suppression automatique, appelée chaque jour par pg_cron).
-- Les tables sont fermées (RLS sans aucune règle) : on n'y accède que par les fonctions ci-dessous
-- et par les fonctions serveur (clé « service_role » côté Supabase).

create extension if not exists pgcrypto with schema extensions;

create table if not exists events (
  id text primary key,
  n1 text not null,
  n2 text not null,
  wedding_date date,
  secret_hash bytea not null,
  greeting bytea,
  greeting_mime text,
  opt_audio boolean not null default true,
  opt_media boolean not null default true,
  opt_screen boolean not null default false,   -- diffusion sur un écran (QR code + photos en direct)
  mail_count int not null default 0,           -- nombre d'e-mails envoyés (limite anti-abus)
  opt_capsule boolean not null default false,  -- time capsule achetée
  capsule_date date,                           -- date de livraison = date du mariage + 1 an
  capsule_audio boolean not null default true, -- conserver les messages vocaux
  capsule_media boolean not null default true, -- conserver les photos et vidéos
  capsule_emails text[],                       -- 2 adresses distinctes (seule donnée personnelle conservée, uniquement pour la livraison)
  capsule_token text,                          -- jeton de lecture seule, valable à partir de la date de livraison
  capsule_sent_at timestamptz,
  capsule_last_try timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key,
  event_id text not null references events(id) on delete cascade,
  guest text,
  mime text not null,
  dur int,
  audio bytea not null,
  created_at timestamptz not null default now()
);
create index if not exists messages_event_idx on messages(event_id, created_at);

-- Codes d'achat (Etsy, boutique en ligne) : standard = livre d'or, capsule = livre d'or + time capsule, upgrade = ajoute la capsule à un livre d'or existant
create table if not exists codes (
  code text primary key,
  kind text not null check (kind in ('standard','capsule','upgrade')),
  source text not null default 'etsy',
  note text,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  event_id text
);

alter table events enable row level security;
alter table messages enable row level security;
alter table codes enable row level security;

-- Vérifie le code secret des mariés (jamais appelable depuis l'extérieur)
create or replace function check_secret(p_event text, p_secret text) returns boolean
language sql security definer set search_path = public, extensions stable as $$
  select exists (select 1 from events where id = p_event and secret_hash = digest(p_secret, 'sha256'));
$$;
revoke all on function check_secret(text, text) from public, anon, authenticated;

-- Lecture autorisée : code secret des mariés, OU jeton de la time capsule une fois l'échéance atteinte
create or replace function check_read(p_event text, p_secret text) returns boolean
language sql security definer set search_path = public, extensions stable as $$
  select exists (select 1 from events where id = p_event and (
    secret_hash = digest(p_secret, 'sha256')
    or (capsule_token is not null and capsule_token = p_secret and capsule_date is not null and capsule_date <= current_date)));
$$;
revoke all on function check_read(text, text) from public, anon, authenticated;

-- Met un code au format BIP-XXXX-XXXX-XXXX (ignore espaces, tirets et casse)
create or replace function norm_code(p text) returns text language plpgsql immutable as $$
declare v text := upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'));
begin
  if left(v, 3) = 'BIP' and length(v) = 15 then return 'BIP-' || substr(v, 4, 4) || '-' || substr(v, 8, 4) || '-' || substr(v, 12, 4); end if;
  return v;
end $$;

-- Génération de codes — réservée à l'administrateur (SQL Editor) :
--   select * from generate_codes(10, 'standard');   -- 10 codes livre d'or
--   select * from generate_codes(5, 'capsule');     -- 5 codes livre d'or + time capsule
--   select * from generate_codes(3, 'upgrade');     -- 3 codes « ajouter la time capsule »
create or replace function generate_codes(p_n int, p_kind text default 'standard', p_source text default 'etsy', p_note text default null)
returns setof text language plpgsql security definer set search_path = public, extensions as $$
declare alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; c text; i int; j int;
begin
  if p_kind not in ('standard','capsule','upgrade') then raise exception 'Type de code inconnu'; end if;
  for i in 1..p_n loop
    loop
      c := 'BIP';
      for j in 1..12 loop
        if (j - 1) % 4 = 0 then c := c || '-'; end if;
        c := c || substr(alpha, 1 + (get_byte(gen_random_bytes(1), 0) % 32), 1);
      end loop;
      begin
        insert into codes(code, kind, source, note) values (c, p_kind, p_source, p_note);
        exit;
      exception when unique_violation then null;
      end;
    end loop;
    return next c;
  end loop;
end $$;
revoke all on function generate_codes(int, text, text, text) from public, anon, authenticated;

-- Vérification d'un code par l'acheteur (ne consomme rien)
create or replace function check_code(p_code text)
returns table(valid boolean, used boolean, kind text)
language sql security definer set search_path = public as $$
  select true, c.used_at is not null, c.kind from codes c where c.code = norm_code(p_code)
  union all select false, false, null where not exists (select 1 from codes c where c.code = norm_code(p_code));
$$;

-- Création d'un livre d'or : un code d'achat valide et inutilisé et la date du mariage sont obligatoires (l'annonce peut être enregistrée plus tard depuis un smartphone)
create or replace function create_event(p_id text, p_secret text, p_n1 text, p_n2 text, p_date date, p_greeting text, p_mime text, p_code text, p_opt_audio boolean default true, p_opt_media boolean default true, p_opt_screen boolean default false)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_kind text;
begin
  if p_id !~ '^[a-z0-9]{6,16}$' or length(p_secret) < 8 then raise exception 'Identifiants invalides'; end if;
  if length(p_n1) > 60 or length(p_n2) > 60 or length(p_greeting) > 2500000 then raise exception 'Données trop longues'; end if;
  if p_date is null then raise exception 'La date du mariage est obligatoire'; end if;
  if not p_opt_audio and not p_opt_media then raise exception 'Activez au moins une option'; end if;
  update codes set used_at = now(), event_id = p_id where code = norm_code(p_code) and used_at is null and kind in ('standard','capsule') returning kind into v_kind;
  if v_kind is null then raise exception 'Code invalide ou déjà utilisé'; end if;
  insert into events(id, n1, n2, wedding_date, secret_hash, greeting, greeting_mime, opt_audio, opt_media, opt_screen, opt_capsule)
  values (p_id, p_n1, p_n2, p_date, digest(p_secret, 'sha256'), decode(p_greeting, 'base64'), p_mime, p_opt_audio, p_opt_media, p_opt_screen, v_kind = 'capsule');
end $$;

-- Ce que voit l'invité en scannant le QR code
create or replace function get_event(p_id text)
returns table(n1 text, n2 text, wedding_date date, greeting text, mime text, opt_audio boolean, opt_media boolean, opt_screen boolean, opt_capsule boolean)
language sql security definer set search_path = public as $$
  select n1, n2, wedding_date, replace(encode(greeting, 'base64'), E'\n', ''), greeting_mime, opt_audio, opt_media, opt_screen, opt_capsule from events where id = p_id;
$$;

-- Dépôt d'un message vocal : 20 secondes maximum (marge de 5 s côté serveur) ; p_id fourni par le téléphone (un renvoi ne crée pas de doublon)
create or replace function add_message(p_id uuid, p_event text, p_guest text, p_mime text, p_dur int, p_audio text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from events where id = p_event and opt_audio) then raise exception 'Livre d''or introuvable'; end if;
  if p_mime !~ '^audio/' or length(p_audio) > 900000 then raise exception 'Message refusé'; end if;
  if p_dur is null or p_dur < 1 or p_dur > 25 then raise exception 'Message trop long (20 secondes maximum)'; end if;
  if (select count(*) from messages where event_id = p_event) >= 800 then raise exception 'Livre d''or complet'; end if;
  insert into messages(id, event_id, guest, mime, dur, audio)
  values (p_id, p_event, left(coalesce(p_guest, ''), 60), p_mime, p_dur, decode(p_audio, 'base64'))
  on conflict (id) do nothing;
end $$;

-- Lecture (mariés ou jeton de capsule échu)
create or replace function list_messages(p_event text, p_secret text)
returns table(id uuid, guest text, mime text, dur int, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not check_read(p_event, p_secret) then raise exception 'Code incorrect'; end if;
  return query select m.id, m.guest, m.mime, m.dur, m.created_at from messages m where m.event_id = p_event order by m.created_at;
end $$;

create or replace function get_audio(p_event text, p_secret text, p_id uuid)
returns table(mime text, audio text)
language plpgsql security definer set search_path = public as $$
begin
  if not check_read(p_event, p_secret) then raise exception 'Code incorrect'; end if;
  return query select m.mime, replace(encode(m.audio, 'base64'), E'\n', '') from messages m where m.id = p_id and m.event_id = p_event;
end $$;

-- Écriture (code secret des mariés uniquement)
create or replace function delete_message(p_event text, p_secret text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not check_secret(p_event, p_secret) then raise exception 'Code incorrect'; end if;
  delete from messages where id = p_id and event_id = p_event;
end $$;

create or replace function update_greeting(p_event text, p_secret text, p_greeting text, p_mime text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not check_secret(p_event, p_secret) then raise exception 'Code incorrect'; end if;
  if length(p_greeting) > 2500000 then raise exception 'Annonce trop longue'; end if;
  update events set greeting = decode(p_greeting, 'base64'), greeting_mime = p_mime where id = p_event;
end $$;

-- Time capsule : programmation. La livraison a TOUJOURS lieu un an après la date du mariage.
create or replace function set_capsule(p_event text, p_secret text, p_audio boolean, p_media boolean, p_emails text[])
returns void language plpgsql security definer set search_path = public as $$
declare e text; v_wedding date; v_date date;
begin
  if not check_secret(p_event, p_secret) then raise exception 'Code incorrect'; end if;
  select wedding_date into v_wedding from events where id = p_event and opt_capsule;
  if not found then raise exception 'Time capsule non activée'; end if;
  if v_wedding is null then raise exception 'La date du mariage est nécessaire'; end if;
  v_date := (v_wedding + interval '1 year')::date;
  if v_date < current_date then raise exception 'Le premier anniversaire de ce mariage est déjà passé'; end if;
  if not (p_audio or p_media) then raise exception 'Choisissez les sons et/ou les photos'; end if;
  if p_emails is null or array_length(p_emails, 1) is distinct from 2 or lower(p_emails[1]) = lower(p_emails[2]) then raise exception 'Deux adresses e-mail différentes sont nécessaires'; end if;
  foreach e in array p_emails loop
    if e !~* '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' or length(e) > 120 then raise exception 'Adresse e-mail invalide'; end if;
  end loop;
  update events set capsule_audio = p_audio, capsule_media = p_media, capsule_emails = array[lower(trim(p_emails[1])), lower(trim(p_emails[2]))],
    capsule_token = coalesce(capsule_token, 'c' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
    capsule_sent_at = case when capsule_date is distinct from v_date then null else capsule_sent_at end,
    capsule_date = v_date
  where id = p_event;
end $$;

create or replace function get_capsule(p_event text, p_secret text)
returns table(opt_capsule boolean, capsule_date date, capsule_audio boolean, capsule_media boolean, capsule_emails text[], sent boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not check_secret(p_event, p_secret) then raise exception 'Code incorrect'; end if;
  return query select e.opt_capsule, e.capsule_date, e.capsule_audio, e.capsule_media, e.capsule_emails, e.capsule_sent_at is not null from events e where e.id = p_event;
end $$;

-- Ajouter la time capsule à un livre d'or existant avec un code « upgrade »
create or replace function apply_capsule_code(p_event text, p_secret text, p_code text)
returns void language plpgsql security definer set search_path = public as $$
declare v text;
begin
  if not check_secret(p_event, p_secret) then raise exception 'Code incorrect'; end if;
  update codes set used_at = now(), event_id = p_event where code = norm_code(p_code) and used_at is null and kind = 'upgrade' returning code into v;
  if v is null then raise exception 'Code invalide ou déjà utilisé'; end if;
  update events set opt_capsule = true where id = p_event;
end $$;

-- Photos & vidéos : dossier de fichiers PRIVÉ (limite 50 Mo par fichier = maximum de l'offre gratuite Supabase)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 52428800,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm','video/3gpp','video/x-m4v'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types, public = false;

-- Fonctions réservées aux fonctions serveur (jamais appelables depuis un navigateur)
create or replace function media_stats(p_event text)
returns table(n bigint, bytes bigint)
language sql security definer set search_path = public, storage as $$
  select count(*), coalesce(sum((metadata->>'size')::bigint), 0) from storage.objects where bucket_id = 'media' and name like p_event || '/%';
$$;
create or replace function media_list(p_event text)
returns table(name text, size bigint, mime text, created_at timestamptz)
language sql security definer set search_path = public, storage as $$
  select o.name, coalesce((o.metadata->>'size')::bigint, 0), o.metadata->>'mimetype', o.created_at
  from storage.objects o where o.bucket_id = 'media' and o.name like p_event || '/%' order by o.created_at;
$$;
revoke all on function media_stats(text) from public, anon, authenticated;
revoke all on function media_list(text) from public, anon, authenticated;
grant execute on function media_stats(text) to service_role;
grant execute on function media_list(text) to service_role;

-- Maintenance quotidienne à 5 h : livraison des time capsules + suppression automatique (90 jours après le mariage, hors capsule)
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.unschedule(jobid) from cron.job where jobname = 'apres-le-bip-maintenance';
select cron.schedule('apres-le-bip-maintenance', '0 5 * * *', $$select net.http_post(url := 'https://VOTRE-PROJET.supabase.co/functions/v1/maintenance', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb)$$);

-- Suivi des ventes : une ligne par code d'achat, mise à jour automatiquement (déclencheurs sur events)
alter table codes add column if not exists order_number text;      -- n° de commande : à remplir à la main
alter table codes add column if not exists status text not null default 'Disponible';
alter table codes add column if not exists couple text;
alter table codes add column if not exists wedding_date date;
alter table codes add column if not exists mail1 text;
alter table codes add column if not exists mail2 text;

create or replace function sync_client() returns trigger language plpgsql security definer set search_path = public as $$
declare e events%rowtype; v_status text;
begin
  if tg_op = 'DELETE' then
    update codes set status = 'Supprimé', couple = null, mail1 = null, mail2 = null where event_id = old.id;
    return old;
  end if;
  e := new;
  v_status := case
    when e.opt_capsule and e.capsule_sent_at is not null then 'Capsule livrée'
    when e.opt_capsule and coalesce(array_length(e.capsule_emails, 1), 0) > 0 then 'Capsule programmée'
    when e.opt_capsule then 'Capsule à configurer'
    else 'Livre d''or créé' end;
  update codes set status = v_status, couple = e.n1 || ' & ' || e.n2, wedding_date = e.wedding_date,
    mail1 = e.capsule_emails[1], mail2 = e.capsule_emails[2] where event_id = e.id;
  return new;
end $$;

drop trigger if exists trg_sync_client_ins on events;
create trigger trg_sync_client_ins after insert on events for each row execute function sync_client();
drop trigger if exists trg_sync_client_upd on events;
create trigger trg_sync_client_upd after update on events for each row execute function sync_client();
drop trigger if exists trg_sync_client_del on events;
create trigger trg_sync_client_del after delete on events for each row execute function sync_client();

-- Le code est lié au livre d'or APRÈS l'insertion de l'event : on resynchronise aussi quand le code est marqué utilisé
create or replace function sync_client_code() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.event_id is not null and old.event_id is distinct from new.event_id then
    update events set id = id where id = new.event_id;   -- déclenche sync_client
  end if;
  return new;
end $$;
drop trigger if exists trg_sync_client_code on codes;
create trigger trg_sync_client_code after update of event_id on codes for each row execute function sync_client_code();

create or replace view ventes with (security_invoker = true) as
select code as "Clé", case kind when 'standard' then 'Standard' when 'capsule' then 'Time capsule' else 'Ajout time capsule' end as "Formule",
  status as "Statut", order_number as "N° de commande", couple as "Mariés", wedding_date as "Mariage", mail1 as "Mail 1", mail2 as "Mail 2",
  source as "Origine", note as "Note", created_at as "Code créé le", used_at as "Utilisé le"
from codes order by created_at desc, code;
revoke all on ventes from public, anon, authenticated;

-- rattrapage des livres d'or existants
update events set id = id;

-- Clé Resend (l'envoi d'e-mails) : table fermée, lue uniquement par les fonctions serveur. La valeur n'est JAMAIS écrite dans ce fichier :
--   insert into app_secrets(name, value) values ('RESEND_API_KEY', 're_...') on conflict (name) do update set value = excluded.value;
create table if not exists app_secrets (name text primary key, value text not null);
alter table app_secrets enable row level security;
revoke all on app_secrets from public, anon, authenticated;
