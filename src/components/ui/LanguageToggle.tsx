import { Languages } from 'lucide-react';
import { getLang, setLang, LANG_OPTIONS, type LangCode } from '@/lib/lang';

/**
 * Switches between Swahili and English.
 *
 * The dictionaries are picked up at module init, so the choice is saved and the
 * page is reloaded rather than re-rendered — the same thing Settings does.
 *
 * `tone` follows the surface it sits on: "dark" for the cover stock in the
 * header and footer, "light" for anything on white.
 */
export default function LanguageToggle({ tone = 'dark' }: { tone?: 'dark' | 'light' }) {
  const current = getLang();

  function choose(code: LangCode) {
    if (code === current) return;
    setLang(code);
    window.location.reload();
  }

  const dark = tone === 'dark';
  return (
    <div
      role="group"
      aria-label={current === 'sw' ? 'Chagua lugha' : 'Choose a language'}
      className={`inline-flex items-center gap-1 rounded-sm border px-1 py-1 ${dark ? 'border-white/15' : 'border-ink/15'}`}
    >
      <Languages aria-hidden="true" className={`ml-1 h-4 w-4 ${dark ? 'text-white/50' : 'text-ink-muted'}`} />
      {LANG_OPTIONS.map((option) => {
        const active = option.code === current;
        return (
          <button
            key={option.code}
            type="button"
            onClick={() => choose(option.code)}
            aria-pressed={active}
            title={option.label}
            className={`rounded-sm px-2 py-1 text-xs font-semibold uppercase transition ${
              active
                ? 'bg-role-admin text-white'
                : dark ? 'text-white/60 hover:text-white' : 'text-ink-muted hover:text-ink'
            }`}
          >
            {option.code}
          </button>
        );
      })}
    </div>
  );
}
