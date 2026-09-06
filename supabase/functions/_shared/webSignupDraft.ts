// Turning a web signup draft into the same action the chat flow produces.
//
// Pure on purpose: the database read lives in the webhook, so everything that
// decides WHAT gets created can be unit-tested without a network.
//
// The rule this file exists to keep: a draft carries the six answers and
// nothing else. It never carries a phone number into the account. The number
// that sends the code is the number the business is created for, so a form
// filled in with somebody else's number cannot reach them, and a typo in the
// form cannot lock the real owner out of their own signup.

import {
  classifyBusinessDescription,
  type BusinessCategory,
  type BusinessSubCategory,
} from './whatsappBusinessClassifier.ts';
import type { Lang, OnboardingAction } from './whatsappOnboarding.ts';

export type WebSignupDraftRow = {
  id: string;
  business_name: string;
  business_description: string;
  full_name: string;
  location: string;
  opening_time: string;
  closing_time: string;
  lang: string;
  claimed_at: string | null;
  expires_at: string;
};

/** Same alphabet the codes are minted from: no O, I, L, 0 or 1. */
const CODE_CHARS = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

/**
 * Pulls a signup code out of the message.
 *
 * The wa.me link pre-fills "SAJILI ABCD2345", but people forward, retype and
 * paste, so a bare code and a code inside a short sentence both count. The
 * shape is checked here; whether the code is real is decided by the hash
 * lookup, never by this function.
 */
export function findSignupCode(text: string | null | undefined): string | null {
  const said = String(text ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
  if (!said) return null;

  const verb = /^(?:SAJILI|SIGNUP|SIGN UP|REGISTER)\s+([A-Z0-9-]{8,12})$/.exec(said);
  if (verb) {
    const squashed = verb[1].replace(/[^A-Z0-9]/g, '');
    return CODE_CHARS.test(squashed) ? squashed : null;
  }

  const bare = said.replace(/[^A-Z0-9]/g, '');
  if (CODE_CHARS.test(bare)) return bare;

  for (const token of said.split(/[^A-Z0-9]+/)) {
    if (CODE_CHARS.test(token)) return token;
  }
  return null;
}

/** A draft is usable once, and only while it is fresh. */
export function draftIsClaimable(row: WebSignupDraftRow, now = new Date()): boolean {
  if (row.claimed_at) return false;
  return new Date(row.expires_at).getTime() > now.getTime();
}

export function draftLang(row: WebSignupDraftRow): Lang {
  return row.lang === 'en' ? 'en' : 'sw';
}

/**
 * The action the webhook already knows how to execute.
 *
 * The classifier runs here rather than on the web form: it decides which
 * examples the welcome message shows and what the assistant is told about the
 * shop, and both of those belong to the WhatsApp side.
 */
export function draftToCreateAction(row: WebSignupDraftRow): Extract<OnboardingAction, { kind: 'create_business' }> {
  const guess = classifyBusinessDescription(`${row.business_name} ${row.business_description}`);
  return {
    kind: 'create_business',
    businessName: row.business_name,
    fullName: row.full_name,
    category: (guess?.category ?? null) as BusinessCategory | null,
    subCategory: (guess?.sub_category ?? null) as BusinessSubCategory | null,
    confidence: guess?.confidence ?? null,
    detectedKeywords: guess?.detected_keywords ?? [],
    description: row.business_description,
    location: row.location,
    openingTime: row.opening_time,
    closingTime: row.closing_time,
  };
}

/** Said when a code is recognised but is expired, already used, or unknown. */
export function badCodeReply(lang: Lang): string {
  return lang === 'sw'
    ? 'Kodi hii ya usajili haifanyi kazi tena. Rudi kwenye risip.co ujaze fomu upya, au tuendelee hapa hapa.'
    : 'That signup code is no longer valid. Fill the form again on risip.co, or we can carry on right here.';
}
