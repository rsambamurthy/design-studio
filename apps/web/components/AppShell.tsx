'use client';

import { useEffect, useState, type ReactNode } from 'react';

export type NavKey = 'designs' | 'studio' | 'site' | 'versions' | 'share' | 'cost';

interface Props {
  email: string;
  chip?: string;
  active: NavKey;
  /** Present when inside a design, so the design-level nav links work. */
  designId?: string;
  onNav?: (key: NavKey) => void;
  /** Hide the navigation entirely (focus on the plan). */
  focus?: boolean;
  children: ReactNode;
}

const SOON = ['Elevations & 3D', 'Schedules', 'Catalogue', 'Rule Checks'];

export default function AppShell({ email, chip, active, designId, onNav, focus, children }: Props) {
  // The navigation folds to a slim icon rail; inside a design it starts folded so the plan has room.
  const [slim, setSlim] = useState(!!designId);
  useEffect(() => {
    try {
      const v = localStorage.getItem('ds.nav');
      if (v) setSlim(v === 'slim');
    } catch {
      /* no stored choice */
    }
  }, []);
  const toggleNav = () =>
    setSlim((v) => {
      try {
        localStorage.setItem('ds.nav', v ? 'wide' : 'slim');
      } catch {
        /* not remembered */
      }
      return !v;
    });
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.href = '/login';
  }
  const initials = email.slice(0, 2).toUpperCase();
  const item = (key: NavKey, label: string, icon: string, enabled = true) => {
    const cls = key === active ? 'sa-sb-single active' : 'sa-mg';
    if (!enabled) return null;
    if (key === 'designs') return <a key={key} className={cls} href="/" title={label}><span className="sa-mg-ic">{icon}</span><span className="sa-mg-label">{label}</span></a>;
    return (
      <button key={key} type="button" className={`${cls} nav-btn`} onClick={() => onNav?.(key)} title={label}>
        <span className="sa-mg-ic">{icon}</span>
        <span className="sa-mg-label">{label}</span>
      </button>
    );
  };

  return (
    <div className="sa-shell">
      <header className="sa-header">
        <button type="button" className="sa-nav-toggle hide-sm" onClick={toggleNav} aria-label={slim ? 'Show the menu' : 'Fold the menu'} title={slim ? 'Show the menu' : 'Fold the menu'} aria-expanded={!slim}>
          ☰
        </button>
        <a className="sa-logo" href="/">Integrata</a>
        {chip && <div className="sa-assoc-chip">🏢 {chip}</div>}
        <div className="sa-header-spacer" />
        <div className="sa-user">
          <div className="sa-avatar">{initials}</div>
          <div className="hide-sm">
            <div className="sa-user-name">{email}</div>
            <div className="sa-user-role">Owner</div>
          </div>
          <button type="button" className="sa-logout" onClick={logout} title="Sign out">Sign out</button>
        </div>
      </header>
      <div className="sa-body">
        <aside className={`sa-sidebar ${slim ? 'slim' : ''} ${focus ? 'gone' : ''}`}>
          <div className="sa-sb-head">{slim ? '' : 'Navigation'}</div>
          {item('designs', 'My Designs', '⌂')}
          {designId && item('studio', 'Design Studio', 'D')}
          {designId && item('site', 'Plot & Setbacks', 'P')}
          {designId && item('versions', 'Versions', 'V')}
          {designId && item('share', 'Share', 'S')}
          {designId && item('cost', 'BOQ & Cost', 'B')}
          {SOON.map((label) => (
            <div key={label} className="sa-mg disabled" title={`${label} (coming soon)`}>
              <span className="sa-mg-ic">{label[0]}</span>
              <span className="sa-mg-label">{label}</span>
              <span className="sa-mg-chev">soon</span>
            </div>
          ))}
        </aside>
        <main className={`sa-main ${focus ? 'focus' : ''}`}>{children}</main>
      </div>
    </div>
  );
}
