import { useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { usePlayer } from '../state/player';
import { Icon, type IconName } from './Icon';
import { MiniPlayer } from './Player';
import { Wordmark } from './Wordmark';

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/listen', label: 'Listen', icon: 'listen' },
  { to: '/sources', label: 'Sources', icon: 'sources' },
  { to: '/voice', label: 'Voice', icon: 'voice' },
  { to: '/schedule', label: 'Schedule', icon: 'schedule' },
  { to: '/account', label: 'Account', icon: 'account' },
];

const TITLES: Record<string, string> = {
  listen: 'Listen',
  sources: 'Sources',
  voice: 'Voice & tone',
  schedule: 'Schedule',
  account: 'Account',
};

export function AppShell() {
  const { pathname } = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const player = usePlayer();
  const first = useRef(true);
  const hasMini = !!player.edition && pathname !== '/listen';

  useEffect(() => {
    const section = pathname.split('/')[1] ?? '';
    document.title = `${TITLES[section] ?? 'Newscast'} · Newscast`;
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className={`shell${hasMini ? ' has-mini' : ''}`}>
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <nav className="nav" aria-label="Main">
        <div className="nav-brand">
          <Wordmark />
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.to}>
              <NavLink to={n.to} className={({ isActive }) => `nav-item${isActive ? ' is-active' : ''}`}>
                <Icon name={n.icon} size={24} />
                <span>{n.label}</span>
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <main id="main" ref={mainRef} tabIndex={-1} className="main">
        <Outlet />
      </main>
      <MiniPlayer />
    </div>
  );
}
