import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import AuthShell from '@/components/layout/AuthShell';
import WhatsAppFloatingButton from '@/components/whatsapp/WhatsAppFloatingButton';
import Button from '@/components/ui/Button';
import WhatsAppIcon from '@/components/ui/WhatsappIcon';
import { buildRisipWhatsAppUrl } from '@/features/whatsapp/publicWhatsApp';
import { useAuth } from '@/lib/auth';
import { getLang } from '@/lib/lang';

type Mode = 'login' | 'register';
type Phase = 'form' | 'sending' | 'sent';

const COPY = {
  sw: {
    loginTitle: 'Ingia kupitia WhatsApp',
    registerTitle: 'Anza kutumia Risip',
    loginLead: 'Weka namba yako. Risip itakutumia link salama ya kuingia kupitia WhatsApp.',
    registerLead: 'Weka namba yako. Risip itaanzisha usajili wako moja kwa moja kwenye WhatsApp.',
    phone: 'Namba ya WhatsApp',
    submitLogin: 'Nitume link ya kuingia',
    submitRegister: 'Anza usajili WhatsApp',
    sentTitle: 'Angalia WhatsApp yako',
    sentBody: 'Tumepokea ombi lako. Kama namba hii imeunganishwa, utapata link ya dakika 5. Kama ni mpya, Risip itakuongoza kusajili biashara.',
    openWhatsApp: 'Fungua WhatsApp',
    newHere: 'Huna akaunti?',
    haveAccount: 'Una akaunti tayari?',
    register: 'Jisajili',
    login: 'Ingia',
    privacy: 'Hatutaonyesha kama namba ina akaunti. Link ya kuingia inatumika mara moja na inaisha baada ya dakika 5.',
    invalid: 'Weka namba sahihi ya WhatsApp.',
    error: 'Hatukuweza kutuma ujumbe sasa. Fungua WhatsApp moja kwa moja au jaribu tena.',
  },
  en: {
    loginTitle: 'Sign in with WhatsApp',
    registerTitle: 'Start using Risip',
    loginLead: 'Enter your number. Risip will send a secure sign-in link on WhatsApp.',
    registerLead: 'Enter your number. Risip will start your registration directly on WhatsApp.',
    phone: 'WhatsApp number',
    submitLogin: 'Send my sign-in link',
    submitRegister: 'Start on WhatsApp',
    sentTitle: 'Check your WhatsApp',
    sentBody: 'We received your request. If the number is linked, you will get a five-minute link. If it is new, Risip will guide you through business registration.',
    openWhatsApp: 'Open WhatsApp',
    newHere: 'New to Risip?',
    haveAccount: 'Already have an account?',
    register: 'Register',
    login: 'Sign in',
    privacy: 'We never reveal whether a number has an account. Sign-in links work once and expire after five minutes.',
    invalid: 'Enter a valid WhatsApp number.',
    error: 'We could not send the message right now. Open WhatsApp directly or try again.',
  },
} as const;

/**
 * The country code is printed on the field, not typed, so this keeps only the
 * national part. People write their number every way there is — 0712…,
 * +255712…, 255 712… — and all three mean the same nine digits.
 */
function nationalDigits(value: string) {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('255')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits.slice(0, 9);
}

export default function WhatsAppAuth({ mode }: { mode: Mode }) {
  const auth = useAuth();
  const lang = getLang();
  const c = COPY[lang];
  const [phone, setPhone] = useState('');
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState<string | null>(null);
  const directUrl = buildRisipWhatsAppUrl(mode, lang);

  if (auth.status === 'signed-in' && auth.profile) {
    return <Navigate to="/dashboard" replace />;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (phone.length !== 9) {
      setError(c.invalid);
      return;
    }

    setPhase('sending');
    try {
      const response = await fetch('/api/auth/whatsapp/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ whatsapp_number: `+255${phone}`, purpose: mode, language: lang }),
      });
      if (!response.ok) throw new Error('request failed');
      setPhase('sent');
    } catch {
      setError(c.error);
      setPhase('form');
    }
  }

  return (
    <AuthShell>
      <div className="px-2 py-6 sm:px-6">
        {phase === 'sent' ? (
          <div className="text-center">
            <CheckCircle2 className="mx-auto h-11 w-11 text-[#25D366]" />
            <h1 className="mt-4 font-display text-2xl font-semibold text-white">{c.sentTitle}</h1>
            <p className="mt-3 text-sm leading-relaxed text-white/60">{c.sentBody}</p>
            {directUrl && (
              <a href={directUrl} target="_blank" rel="noopener noreferrer" className="mt-6 flex h-12 items-center justify-center gap-2 rounded-sm bg-[#25D366] px-4 text-sm font-semibold text-white transition hover:bg-[#25D366]/90">
                <WhatsAppIcon className="h-5 w-5" /> {c.openWhatsApp}
              </a>
            )}
            <button type="button" onClick={() => setPhase('form')} className="mt-5 text-sm font-semibold text-role-admin hover:underline">
              {lang === 'sw' ? 'Tumia namba nyingine' : 'Use another number'}
            </button>
          </div>
        ) : (
          <>
            {/* Two routes, one component: the segments are links, so the URL
                still says which page you are on. */}
            <div className="flex rounded-sm border border-white/10 bg-white/5 p-1">
              {([['login', '/login', c.login], ['register', '/signup', c.register]] as const).map(([key, to, label]) => (
                <Link
                  key={key}
                  to={to}
                  aria-current={mode === key ? 'page' : undefined}
                  className={`flex-1 rounded-sm py-2.5 text-center text-sm font-semibold transition ${mode === key ? 'bg-role-admin text-white' : 'text-white/60 hover:text-white'}`}
                >
                  {label}
                </Link>
              ))}
            </div>

            <div className="mt-8 text-center">
              <WhatsAppIcon className="mx-auto h-11 w-11 text-[#25D366]" />
              <h1 className="mt-4 font-display text-2xl font-semibold text-white text-balance">{mode === 'login' ? c.loginTitle : c.registerTitle}</h1>
              <p className="mt-2 text-sm leading-relaxed text-white/60">{mode === 'login' ? c.loginLead : c.registerLead}</p>
            </div>

            <form onSubmit={submit} className="mt-7 flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <label htmlFor="wa-phone" className="text-sm font-medium text-white/85">{c.phone}</label>
                <div className="flex gap-2">
                  <span aria-hidden="true" className="flex h-12 w-[4.25rem] shrink-0 items-center justify-center rounded-sm border border-white/15 bg-white/10 text-[15px] font-semibold text-white/75">+255</span>
                  <input
                    id="wa-phone"
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel-national"
                    value={phone}
                    onChange={(event) => setPhone(nationalDigits(event.target.value))}
                    placeholder="7xx xxx xxx"
                    aria-describedby="wa-phone-privacy"
                    className="h-12 w-full min-w-0 rounded-sm border border-white/15 bg-book-soft px-4 text-[15px] text-white placeholder:text-white/30 focus:border-role-admin focus:outline-none focus:ring-2 focus:ring-role-admin/40"
                  />
                </div>
              </div>
              {error && <p role="alert" className="text-sm text-[#F2A9B4]">{error}</p>}
              <Button type="submit" tint="admin" fullWidth disabled={phase === 'sending'} className="h-12 justify-center gap-2 !rounded-sm">
                {phase === 'sending' ? <Loader2 className="h-4 w-4 animate-spin" /> : <WhatsAppIcon className="h-5 w-5" />}
                {mode === 'login' ? c.submitLogin : c.submitRegister}
              </Button>
            </form>

            <div id="wa-phone-privacy" className="mt-5 flex items-start justify-center gap-2 text-xs leading-relaxed text-white/40">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-role-admin" />
              <span>{c.privacy}</span>
            </div>

            <p className="mt-6 text-center text-sm text-white/50">
              {mode === 'login' ? c.newHere : c.haveAccount}{' '}
              <Link to={mode === 'login' ? '/signup' : '/login'} className="font-semibold text-role-admin hover:underline">
                {mode === 'login' ? c.register : c.login}
              </Link>
            </p>
          </>
        )}
      </div>
      <WhatsAppFloatingButton />
    </AuthShell>
  );
}
