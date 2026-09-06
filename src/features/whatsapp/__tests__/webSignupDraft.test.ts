import { describe, expect, it } from 'vitest';
import {
  findSignupCode,
  draftIsClaimable,
  draftLang,
  draftToCreateAction,
  type WebSignupDraftRow,
} from '../../../../supabase/functions/_shared/webSignupDraft';
import { findInviteCode } from '../../../../supabase/functions/_shared/whatsappOnboarding';

const draft = (over: Partial<WebSignupDraftRow> = {}): WebSignupDraftRow => ({
  id: 'draft-1',
  business_name: 'Duka la Asha',
  business_description: 'nauza daftari, kalamu na kutoa photocopy',
  full_name: 'Asha Mkwawa',
  location: 'Mwenge, Dar es Salaam',
  opening_time: '08:00',
  closing_time: '18:00',
  lang: 'sw',
  claimed_at: null,
  expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
  ...over,
});

describe('reading a signup code out of a message', () => {
  it('reads the code the wa.me link pre-fills', () => {
    expect(findSignupCode('SAJILI ABCD2345')).toBe('ABCD2345');
  });

  it('reads it however it was retyped or pasted', () => {
    expect(findSignupCode('sajili abcd2345')).toBe('ABCD2345');
    expect(findSignupCode('ABCD2345')).toBe('ABCD2345');
    expect(findSignupCode('  abcd2345  ')).toBe('ABCD2345');
    expect(findSignupCode('ABCD-2345')).toBe('ABCD2345');
    expect(findSignupCode('kodi yangu ni ABCD2345')).toBe('ABCD2345');
  });

  // The negative half. A code is eight characters of a restricted alphabet, and
  // ordinary Swahili and English words must not pass for one.
  it('does not see a code where there is none', () => {
    expect(findSignupCode('mambo vipi')).toBeNull();
    expect(findSignupCode('nimeuza daftari 10 kwa 1500')).toBeNull();
    expect(findSignupCode('')).toBeNull();
    expect(findSignupCode(null)).toBeNull();
    // Wrong length.
    expect(findSignupCode('ABCD234')).toBeNull();
    expect(findSignupCode('ABCD23456')).toBeNull();
    // Letters the generator never mints, so a real word cannot collide.
    expect(findSignupCode('BOOKSHOP')).toBeNull();
    expect(findSignupCode('DAFTARI2')).toBeNull();
  });

  it('reads the same shape company invite codes use, so one lookup can miss and the other still match', () => {
    // Both doors mint from the same alphabet on purpose. What separates a
    // signup code from an invite code is which table holds its hash, never its
    // spelling — so this function must agree with findInviteCode on shape.
    expect(findSignupCode('ABCD2345')).toBe(findInviteCode('ABCD2345'));
    expect(findSignupCode('BOOKSHOP')).toBe(findInviteCode('BOOKSHOP'));
  });
});

describe('when a draft may be used', () => {
  it('accepts a fresh unclaimed draft', () => {
    expect(draftIsClaimable(draft())).toBe(true);
  });

  it('refuses one that is expired', () => {
    expect(draftIsClaimable(draft({ expires_at: new Date(Date.now() - 1000).toISOString() }))).toBe(false);
  });

  it('refuses one that is already claimed, so one code is one business', () => {
    expect(draftIsClaimable(draft({ claimed_at: new Date().toISOString() }))).toBe(false);
  });

  it('refuses on the exact expiry instant rather than rounding in the customer’s favour', () => {
    const at = new Date('2026-09-06T12:00:00.000Z');
    expect(draftIsClaimable(draft({ expires_at: at.toISOString() }), at)).toBe(false);
    expect(draftIsClaimable(draft({ expires_at: new Date(at.getTime() + 1).toISOString() }), at)).toBe(true);
  });
});

describe('turning a draft into the action the webhook executes', () => {
  it('carries every answer through unchanged', () => {
    expect(draftToCreateAction(draft())).toMatchObject({
      kind: 'create_business',
      businessName: 'Duka la Asha',
      fullName: 'Asha Mkwawa',
      description: 'nauza daftari, kalamu na kutoa photocopy',
      location: 'Mwenge, Dar es Salaam',
      openingTime: '08:00',
      closingTime: '18:00',
    });
  });

  it('never carries a phone number, because the sender’s number is the verified one', () => {
    const action = draftToCreateAction(draft()) as Record<string, unknown>;
    expect(Object.keys(action)).not.toContain('phone');
    expect(JSON.stringify(action)).not.toMatch(/\+?255\d/);
  });

  it('classifies the shop from what was typed, the same as the chat flow does', () => {
    const stationery = draftToCreateAction(draft());
    expect(stationery.category).not.toBeNull();
    // And a description it cannot place still produces a usable action: the
    // classification only chooses which examples the welcome shows.
    const vague = draftToCreateAction(draft({ business_description: 'xyz qwe', business_name: 'zzz' }));
    expect(vague.kind).toBe('create_business');
    expect(vague.description).toBe('xyz qwe');
  });

  it('reads the language the form was filled in, defaulting to Swahili', () => {
    expect(draftLang(draft({ lang: 'en' }))).toBe('en');
    expect(draftLang(draft({ lang: 'sw' }))).toBe('sw');
    expect(draftLang(draft({ lang: 'zz' }))).toBe('sw');
  });
});
