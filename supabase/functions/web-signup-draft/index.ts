// web-signup-draft · Stores the answers a new shop typed on the web signup form.
//
// This function creates NOTHING that grants access. It writes a row to
// web_signup_drafts and hands back a short code the browser puts in a wa.me link.
// The account is created later, by whatsapp-webhook, and only for the number
// that actually sends that code — see migration 0170 for why the split exists.
//
// verify_jwt = false: nobody signing up has an account yet, by definition. What
// stands in for auth is that a draft is worthless on its own. The rate limit
// below is about keeping the table small, not about protecting a secret.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import { sha256Hex } from '../_shared/whatsapp.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...corsHeaders },
  });
}

/** How long somebody has to walk from the form to WhatsApp. */
const DRAFT_TTL_MINUTES = 60;
/** Drafts one address may create per hour. Generous for a shared shop wifi. */
const IP_HOURLY_LIMIT = 12;

/**
 * The alphabet company invite codes already use: no O, I, L, 0 or 1, because a
 * code gets read off a screen and typed on a phone keypad. Matching it also
 * means findInviteCode's shape rules can recognise this code in a sentence.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

const clean = (value: unknown, max: number) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** HH:MM only. The form sends a time input's value, so this is a format check. */
function normalTime(value: unknown): string | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const businessName = clean(body.business_name, 80);
  const businessDescription = clean(body.business_description, 300);
  const fullName = clean(body.full_name, 80);
  const location = clean(body.location, 160);
  const openingTime = normalTime(body.opening_time);
  const closingTime = normalTime(body.closing_time);
  const lang = body.lang === 'en' ? 'en' : 'sw';

  // The same minimums advanceOnboarding enforces on the WhatsApp side, so the
  // two doors cannot disagree about what counts as an answer.
  if (businessName.length < 2) return json({ error: 'business_name' }, 400);
  if (businessDescription.length < 3) return json({ error: 'business_description' }, 400);
  if (fullName.length < 2) return json({ error: 'full_name' }, 400);
  if (location.length < 2) return json({ error: 'location' }, 400);
  if (!openingTime) return json({ error: 'opening_time' }, 400);
  if (!closingTime) return json({ error: 'closing_time' }, 400);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    console.error('web-signup-draft missing env');
    return json({ error: 'server' }, 500);
  }
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  // x-forwarded-for is client-controlled, so this is a courtesy limit on honest
  // traffic, not a security boundary. Nothing here is worth defending harder.
  const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim().slice(0, 60) || null;
  if (ip) {
    const since = new Date(Date.now() - 60 * 60_000).toISOString();
    const { count } = await db
      .from('web_signup_drafts')
      .select('id', { count: 'exact', head: true })
      .eq('created_ip', ip)
      .gte('created_at', since);
    if ((count ?? 0) >= IP_HOURLY_LIMIT) return json({ error: 'rate_limited' }, 429);
  }

  const code = newCode();
  const { error } = await db.from('web_signup_drafts').insert({
    code_hash: await sha256Hex(code),
    business_name: businessName,
    business_description: businessDescription,
    full_name: fullName,
    location,
    opening_time: openingTime,
    closing_time: closingTime,
    lang,
    created_ip: ip,
    expires_at: new Date(Date.now() + DRAFT_TTL_MINUTES * 60_000).toISOString(),
  });
  if (error) {
    console.error('web-signup-draft insert failed', error.message);
    return json({ error: 'server' }, 500);
  }

  // Only the code goes back. The wa.me link is built in the browser, where the
  // one public Risip number already lives, so it is not duplicated into here.
  return json({ code, expires_in_minutes: DRAFT_TTL_MINUTES });
});
