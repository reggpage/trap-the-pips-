import { Link } from 'react-router-dom';
import LanguageToggle from '@/components/ui/LanguageToggle';
import RisipLogo from '@/components/ui/RisipLogo';

// Shared frame for WhatsApp passwordless login and registration.
export default function AuthShell({
  children,
  footer,
}: {
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-book">
      {/* Same cover stock as the landing hero, so signing in feels like the
          same book rather than a different site. */}
      <div aria-hidden="true" className="pointer-events-none absolute -top-64 left-1/2 h-[38rem] w-[38rem] -translate-x-1/2 rounded-full bg-role-admin/15 blur-3xl" />
      <header className="fixed top-0 left-0 right-0 z-40 border-b border-white/10 bg-book/95 backdrop-blur-sm">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center text-role-admin" aria-label="Risip">
            <RisipLogo className="h-10 w-auto" />
          </Link>
          <div className="flex items-center gap-3"><LanguageToggle />{footer}</div>
        </div>
      </header>

      <main className="relative mx-auto flex min-h-screen max-w-md items-center px-4 pt-24 pb-10">
        <div className="w-full">{children}</div>
      </main>
    </div>
  );
}
