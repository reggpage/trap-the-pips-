-- Business signup that starts on the web and finishes on WhatsApp.
--
-- The six questions Risip asks a new shop are the same either way (see
-- _shared/whatsappOnboarding.ts). Asking them on a web form is friendlier than
-- six round trips of chat, but a web form cannot prove who owns a phone number,
-- and phone ownership is the whole of Risip's identity model: there is no
-- password, and the way in is a link sent to a number.
--
-- So the form only writes a DRAFT. Nothing is created — no auth user, no
-- company, no profile — until the person sends the draft's code from their own
-- WhatsApp, at which point the sender's number is the verified one and the
-- account is created for it. A draft on its own grants nothing.
--
-- The plaintext code is returned to the browser once and never stored, the same
-- posture as whatsapp_link_tokens (migration 0043).

create table if not exists web_signup_drafts (
  id                   uuid primary key default gen_random_uuid(),
  code_hash            text not null unique,
  business_name        text not null,
  business_description text not null,
  full_name            text not null,
  location             text not null,
  opening_time         text not null,
  closing_time         text not null,
  lang                 text not null default 'sw',
  -- Only ever set to the number that actually sent the code, never to anything
  -- typed into the form. Kept so a support question can be answered later.
  claimed_by_phone     text,
  claimed_at           timestamptz,
  attempts             integer not null default 0,
  created_ip           text,
  created_at           timestamptz not null default now(),
  expires_at           timestamptz not null
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'web_signup_drafts_lang_check') then
    alter table web_signup_drafts add constraint web_signup_drafts_lang_check
      check (lang in ('sw', 'en'));
  end if;
  -- HH:MM, the shape parseBusinessTime already produces on the WhatsApp side.
  if not exists (select 1 from pg_constraint where conname = 'web_signup_drafts_time_check') then
    alter table web_signup_drafts add constraint web_signup_drafts_time_check
      check (opening_time ~ '^[0-2][0-9]:[0-5][0-9]$' and closing_time ~ '^[0-2][0-9]:[0-5][0-9]$');
  end if;
end $$;

-- Sweeping expired drafts is a plain delete over this index.
create index if not exists web_signup_drafts_expires_idx
  on web_signup_drafts (expires_at) where claimed_at is null;

-- Rate limiting counts recent rows from one address.
create index if not exists web_signup_drafts_ip_idx
  on web_signup_drafts (created_ip, created_at);

-- Deny by default. Only the edge functions, on the service role, ever touch
-- this table: the browser posts to web-signup-draft and gets a code back, and
-- whatsapp-webhook claims it. Neither anon nor authenticated has any business
-- reading other people's drafts, so no policy is written.
alter table web_signup_drafts enable row level security;

revoke all on table web_signup_drafts from anon, authenticated;
