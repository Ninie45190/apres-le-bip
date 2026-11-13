-- Après le bip — installation complète de la base (état final).
-- Fonctions serveur à déployer avec : supabase/functions/media (photos/vidéos) et supabase/functions/notify (e-mails, secret RESEND_API_KEY). À coller UNE FOIS dans Supabase > SQL Editor > Run.
-- Les tables sont fermées (RLS sans aucune règle) : on n'y accède que par les fonctions ci-dessous
-- et par la fonction serveur « media » (supabase/functions/media/index.ts) pour les photos et vidéos.

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

alter table events enable row level security;
alter table messages enable row level security;

-- Vérifie le code secret des mariés (jamais appelable depuis l'extérieur)
create or replace function check_secret(p_event text, p_secret text) returns boolean
language sql security definer set search_path = public, extensions stable as $$
  select exists (select 1 from events where id = p_event and secret_hash = digest(p_secret, 'sha256'));
$$;
revoke all on function check_secret(text, text) from public, anon, authenticated;

-- Création d'un livre d'or (l'annonce peut être enregistrée plus tard depuis un smartphone)
create or replace function create_event(p_id text, p_secret text, p_n1 text, p_n2 text, p_date date, p_greeting text, p_mime text, p_opt_audio boolean default true, p_opt_media boolean default true, p_opt_screen boolean default false)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_id !~ '^[a-z0-9]{6,16}$' or length(p_secret) < 8 then raise exception 'Identifiants invalides'; end if;
  if length(p_n1) > 60 or length(p_n2) > 60 or length(p_greeting) > 2500000 then raise exception 'Données trop longues'; end if;
  if not p_opt_audio and not p_opt_media then raise exception 'Activez au moins une option'; end if;
  insert into events(id, n1, n2, wedding_date, secret_hash, greeting, greeting_mime, opt_audio, opt_media, opt_screen)
  values (p_id, p_n1, p_n2, p_date, digest(p_secret, 'sha256'), decode(p_greeting, 'base64'), p_mime, p_opt_audio, p_opt_media, p_opt_screen);
end $$;

-- Ce que voit l'invité en scannant le QR code
create or replace function get_event(p_id text)
returns table(n1 text, n2 text, wedding_date date, greeting text, mime text, opt_audio boolean, opt_media boolean, opt_screen boolean)
language sql security definer set search_path = public as $$
  select n1, n2, wedding_date, replace(encode(greeting, 'base64'), E'\n', ''), greeting_mime, opt_audio, opt_media, opt_screen from events where id = p_id;
$$;

-- Dépôt d'un message vocal (p_id fourni par le téléphone : un renvoi ne crée pas de doublon)
create or replace function add_message(p_id uuid, p_event text, p_guest text, p_mime text, p_dur int, p_audio text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from events where id = p_event and opt_audio) then raise exception 'Livre d''or introuvable'; end if;
  if p_mime !~ '^audio/' or length(p_audio) > 3000000 then raise exception 'Message refusé'; end if;
  if (select count(*) from messages where event_id = p_event) >= 800 then raise exception 'Livre d''or complet'; end if;
  insert into messages(id, event_id, guest, mime, dur, audio)
  values (p_id, p_event, left(coalesce(p_guest, ''), 60), p_mime, p_dur, decode(p_audio, 'base64'))
  on conflict (id) do nothing;
end $$;

-- Côté mariés (code secret obligatoire)
create or replace function list_messages(p_event text, p_secret text)
returns table(id uuid, guest text, mime text, dur int, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not check_secret(p_event, p_secret) then raise exception 'Code incorrect'; end if;
  return query select m.id, m.guest, m.mime, m.dur, m.created_at from messages m where m.event_id = p_event order by m.created_at;
end $$;

create or replace function get_audio(p_event text, p_secret text, p_id uuid)
returns table(mime text, audio text)
language plpgsql security definer set search_path = public as $$
begin
  if not check_secret(p_event, p_secret) then raise exception 'Code incorrect'; end if;
  return query select m.mime, replace(encode(m.audio, 'base64'), E'\n', '') from messages m where m.id = p_id and m.event_id = p_event;
end $$;

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

-- Photos & vidéos : dossier de fichiers PRIVÉ (limite 50 Mo par fichier = maximum de l'offre gratuite Supabase)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', false, 52428800,
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','video/mp4','video/quicktime','video/webm','video/3gpp','video/x-m4v'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types, public = false;

-- Fonctions réservées à la fonction serveur « media » (jamais appelables depuis un navigateur)
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

-- OPTIONNEL — suppression automatique des messages vocaux 60 jours après le mariage
-- (active l'extension pg_cron dans Database > Extensions).
-- ATTENTION : cela ne supprime PAS les photos et vidéos (fichiers du dossier « media », à supprimer à part).
-- select cron.schedule('purge-apres-le-bip', '0 4 * * *',
--   $$ delete from events where coalesce(wedding_date, created_at::date) < current_date - 60 $$);
