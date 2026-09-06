import { getLang, type LangCode } from '@/lib/lang';

const RISIP_PUBLIC_WHATSAPP_NUMBER = '255750513538';

/** Digits only: wa.me rejects a leading plus sign. */
export function risipWhatsAppNumber(): string {
  return RISIP_PUBLIC_WHATSAPP_NUMBER;
}

export function buildRisipWhatsAppUrl(
  intent: 'support' | 'register' | 'login' = 'support',
  lang: LangCode = getLang(),
): string | null {
  const number = risipWhatsAppNumber();
  if (!number) return null;

  const messages = {
    sw: {
      support: 'Habari Risip, nataka kuanza kutumia Risip kwa biashara yangu. Tafadhali nisaidie kuanza.',
      register: 'Habari Risip, nataka kusajili biashara yangu.',
      login: 'ingia',
    },
    en: {
      support: 'Hello Risip, I would like to start using Risip for my business. Please help me get started.',
      register: 'Hello Risip, I would like to register my business.',
      login: 'login',
    },
  } as const;

  return `https://wa.me/${number}?text=${encodeURIComponent(messages[lang][intent])}`;
}

/**
 * The link that finishes a web signup.
 *
 * The code comes from web-signup-draft; the number comes from here, so the one
 * public Risip number stays defined in exactly one place rather than being
 * duplicated into an edge function's environment.
 */
export function buildSignupConfirmUrl(code: string): string {
  const number = risipWhatsAppNumber();
  return `https://wa.me/${number}?text=${encodeURIComponent(`SAJILI ${code}`)}`;
}
