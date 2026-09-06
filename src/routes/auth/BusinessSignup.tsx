import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import AuthShell from '@/components/layout/AuthShell';
import Button from '@/components/ui/Button';
import WhatsAppIcon from '@/components/ui/WhatsappIcon';
import { buildSignupConfirmUrl } from '@/features/whatsapp/publicWhatsApp';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { getLang } from '@/lib/lang';

/**
 * Business signup, asked on the web instead of over six WhatsApp round trips.
 *
 * The questions, their order and their examples are copied from the WhatsApp
 * flow (supabase/functions/_shared/whatsappOnboarding.ts) so the two doors ask
 * the same things. Two steps that flow needs are missing here on purpose:
 * language, because the site already knows it, and the "new business / join one
 * / already have an account" menu, because being on /signup answers it.
 *
 * Nothing is created here. The answers are stored as a draft and the person
 * finishes on WhatsApp, which is the only place a phone number can be proved to
 * be theirs. See migration 0170.
 */

const COPY = {
  sw: {
    of: 'Hatua {n} ya 6',
    back: 'Nyuma',
    next: 'Endelea',
    finish: 'Maliza',
    steps: [
      {
        q: 'Biashara yako inaitwaje?',
        hint: 'Hili ndilo jina litakaloonekana kwenye ripoti zako.',
        placeholder: 'Mfano: Duka la Asha',
        error: 'Naomba jina kamili la biashara, mfano "Duka la Asha".',
      },
      {
        q: 'Biashara yako inauza nini au inatoa huduma gani?',
        hint: 'Andika kwa maneno yako mwenyewe, mfano "nauza daftari, kalamu na kutoa photocopy".',
        placeholder: 'Nauza...',
        error: 'Nitajie bidhaa au huduma kuu mbili au tatu.',
      },
      {
        q: 'Wewe unaitwa nani?',
        hint: 'Utakuwa owner wa biashara hii: unaona kila kitu na unaweza kualika wafanyakazi.',
        placeholder: 'Mfano: Asha Mkwawa',
        error: 'Naomba jina lako, mfano "Asha Mkwawa".',
      },
      {
        q: 'Biashara yako inapatikana wapi?',
        hint: 'Andika eneo, mfano "Mwenge, Dar es Salaam".',
        placeholder: 'Mfano: Mwenge, Dar es Salaam',
        error: 'Naomba eneo la biashara.',
      },
      {
        q: 'Unafungua biashara saa ngapi?',
        hint: 'Chagua muda unaofungua kila siku.',
        placeholder: '',
        error: 'Chagua muda wa kufungua.',
      },
      {
        q: 'Unafunga biashara saa ngapi?',
        hint: 'Chagua muda unaofunga kila siku.',
        placeholder: '',
        error: 'Chagua muda wa kufunga.',
      },
    ],
    doneTitle: 'Karibu umemaliza',
    doneBody: 'Tumehifadhi majibu yako. Bonyeza chini kufungua WhatsApp na kuthibitisha namba yako. Hatutakuuliza maswali haya tena.',
    doneWhy: 'Tunamalizia WhatsApp kwa sababu ndiyo njia pekee ya kuhakikisha namba ni yako kweli. Akaunti itafunguliwa kwa namba itakayotuma ujumbe huu.',
    open: 'Fungua WhatsApp kuthibitisha',
    codeLabel: 'Kodi yako',
    expires: 'Kodi hii inaisha baada ya saa 1.',
    summary: { business: 'Biashara', owner: 'Owner', place: 'Eneo' },
    haveAccount: 'Una akaunti tayari?',
    login: 'Ingia',
    failed: 'Imeshindikana kuhifadhi sasa. Jaribu tena.',
    rateLimited: 'Umejaribu mara nyingi. Subiri kidogo kisha ujaribu tena.',
  },
  en: {
    of: 'Step {n} of 6',
    back: 'Back',
    next: 'Continue',
    finish: 'Finish',
    steps: [
      {
        q: 'What is your business called?',
        hint: 'This is the name that appears on your reports.',
        placeholder: 'For example: Asha’s Shop',
        error: 'Please send the full business name, for example "Asha’s Shop".',
      },
      {
        q: 'What does your business sell or what service does it provide?',
        hint: 'In your own words, for example "I sell books and stationery and offer photocopying".',
        placeholder: 'I sell...',
        error: 'Name two or three main products or services.',
      },
      {
        q: 'What is your name?',
        hint: 'You will be the owner of this business: you see everything and can invite staff.',
        placeholder: 'For example: Asha Mkwawa',
        error: 'Please send your name, for example "Asha Mkwawa".',
      },
      {
        q: 'Where is your business located?',
        hint: 'Write the area, for example "Mwenge, Dar es Salaam".',
        placeholder: 'For example: Mwenge, Dar es Salaam',
        error: 'Please give the business location.',
      },
      {
        q: 'What time do you open?',
        hint: 'Choose the time you open each day.',
        placeholder: '',
        error: 'Choose your opening time.',
      },
      {
        q: 'What time do you close?',
        hint: 'Choose the time you close each day.',
        placeholder: '',
        error: 'Choose your closing time.',
      },
    ],
    doneTitle: 'Almost done',
    doneBody: 'Your answers are saved. Open WhatsApp to confirm your number. We will not ask these questions again.',
    doneWhy: 'It finishes on WhatsApp because that is the only way to prove the number is yours. The account is created for whichever number sends this message.',
    open: 'Open WhatsApp to confirm',
    codeLabel: 'Your code',
    expires: 'This code expires in 1 hour.',
    summary: { business: 'Business', owner: 'Owner', place: 'Location' },
    haveAccount: 'Already have an account?',
    login: 'Sign in',
    failed: 'We could not save that just now. Please try again.',
    rateLimited: 'That is a lot of tries. Wait a moment and try again.',
  },
} as const;

type Answers = {
  business_name: string;
  business_description: string;
  full_name: string;
  location: string;
  opening_time: string;
  closing_time: string;
};

const FIELDS: (keyof Answers)[] = [
  'business_name', 'business_description', 'full_name', 'location', 'opening_time', 'closing_time',
];

/** The same minimums the WhatsApp state machine enforces, so neither door is looser. */
function stepIsAnswered(index: number, value: string): boolean {
  const said = value.replace(/\s+/g, ' ').trim();
  if (index === 1) return said.length >= 3;
  if (index >= 4) return /^([01]?\d|2[0-3]):([0-5]\d)$/.test(said);
  return said.length >= 2;
}

export default function BusinessSignup() {
  const auth = useAuth();
  const lang = getLang();
  const c = COPY[lang];

  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Answers>({
    business_name: '', business_description: '', full_name: '',
    location: '', opening_time: '08:00', closing_time: '18:00',
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ code: string; waUrl: string } | null>(null);

  if (auth.status === 'signed-in' && auth.profile) return <Navigate to="/dashboard" replace />;

  const field = FIELDS[step];
  const value = answers[field];
  const isTime = step >= 4;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke<{ code: string }>(
        'web-signup-draft',
        { body: { ...answers, lang } },
      );
      if (fnError || !data?.code) throw fnError ?? new Error('no code');
      setDone({ code: data.code, waUrl: buildSignupConfirmUrl(data.code) });
    } catch (caught) {
      const message = String((caught as { message?: string })?.message ?? '');
      setError(message.includes('429') ? c.rateLimited : c.failed);
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!stepIsAnswered(step, value)) {
      setError(c.steps[step].error);
      return;
    }
    setError(null);
    if (step < FIELDS.length - 1) {
      setStep(step + 1);
      return;
    }
    void save();
  }

  if (done) {
    return (
      <AuthShell>
        <div className="px-2 py-6 text-center sm:px-6">
          <WhatsAppIcon className="mx-auto h-12 w-12 text-[#25D366]" />
          <h1 className="mt-4 font-display text-2xl font-semibold text-white text-balance">{c.doneTitle}</h1>
          <p className="mt-3 text-sm leading-relaxed text-white/60">{c.doneBody}</p>

          <dl className="mt-6 space-y-2 border border-white/10 bg-white/5 p-4 text-left text-sm">
            {([[c.summary.business, answers.business_name], [c.summary.owner, answers.full_name], [c.summary.place, answers.location]] as const).map(([label, text]) => (
              <div key={label} className="flex gap-2">
                <dt className="shrink-0 text-white/40">{label}:</dt>
                <dd className="min-w-0 break-words text-white">{text}</dd>
              </div>
            ))}
          </dl>

          <a
            href={done.waUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-5 flex h-12 items-center justify-center gap-2 rounded-sm bg-[#25D366] px-4 text-sm font-semibold text-white transition hover:bg-[#25D366]/90"
          >
            <WhatsAppIcon className="h-5 w-5" /> {c.open}
          </a>

          <p className="mt-4 text-xs text-white/40">
            {c.codeLabel}: <span className="font-mono text-sm tracking-widest text-white/80">{done.code}</span> · {c.expires}
          </p>
          <p className="mt-4 text-xs leading-relaxed text-white/35">{c.doneWhy}</p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="px-2 py-6 sm:px-6">
        <div className="flex gap-1.5" aria-hidden="true">
          {FIELDS.map((name, index) => (
            <span key={name} className={`h-1 flex-1 ${index <= step ? 'bg-role-admin' : 'bg-white/12'}`} />
          ))}
        </div>

        <form onSubmit={submit} className="mt-8">
          <p className="text-xs font-semibold uppercase tracking-[0.1em] text-role-admin">
            {c.of.replace('{n}', String(step + 1))}
          </p>
          <h1 className="mt-3 font-display text-2xl font-semibold text-white text-balance">{c.steps[step].q}</h1>
          <p className="mt-2 text-sm leading-relaxed text-white/55">{c.steps[step].hint}</p>

          <div className="mt-7">
            {step === 1 ? (
              <textarea
                key={field}
                autoFocus
                rows={3}
                value={value}
                onChange={(event) => setAnswers({ ...answers, [field]: event.target.value })}
                placeholder={c.steps[step].placeholder}
                className="w-full resize-none rounded-sm border border-white/15 bg-book-soft px-4 py-3 text-[15px] leading-relaxed text-white placeholder:text-white/30 focus:border-role-admin focus:outline-none focus:ring-2 focus:ring-role-admin/40"
              />
            ) : (
              <input
                key={field}
                autoFocus
                type={isTime ? 'time' : 'text'}
                value={value}
                onChange={(event) => setAnswers({ ...answers, [field]: event.target.value })}
                placeholder={c.steps[step].placeholder}
                className="h-12 w-full rounded-sm border border-white/15 bg-book-soft px-4 text-[15px] text-white placeholder:text-white/30 focus:border-role-admin focus:outline-none focus:ring-2 focus:ring-role-admin/40 [color-scheme:dark]"
              />
            )}
          </div>

          {error && <p role="alert" className="mt-3 text-sm text-[#F2A9B4]">{error}</p>}

          <div className="mt-7 flex gap-3">
            {step > 0 && (
              <button
                type="button"
                onClick={() => { setError(null); setStep(step - 1); }}
                className="flex h-12 items-center justify-center gap-2 rounded-sm border border-white/20 px-5 text-sm font-semibold text-white/80 transition hover:bg-white/10"
              >
                <ArrowLeft className="h-4 w-4" /> {c.back}
              </button>
            )}
            <Button type="submit" tint="admin" fullWidth disabled={saving} className="h-12 justify-center gap-2 !rounded-sm">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {step === FIELDS.length - 1 ? c.finish : c.next}
            </Button>
          </div>
        </form>

        <p className="mt-7 text-center text-sm text-white/50">
          {c.haveAccount}{' '}
          <Link to="/login" className="font-semibold text-role-admin hover:underline">{c.login}</Link>
        </p>
      </div>
    </AuthShell>
  );
}
