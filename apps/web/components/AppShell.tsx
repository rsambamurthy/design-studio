'use client';

import type { ReactNode } from 'react';

export type NavKey = 'designs' | 'studio' | 'versions' | 'share';

interface Props {
  email: string;
  chip?: string;
  active: NavKey;
  /** Present when inside a design, so the design-level nav links work. */
  designId?: string;
  onNav?: (key: NavKey) => void;
  children: ReactNode;
}

const SOON = ['Plot & Setbacks', 'Elevations & 3D', 'Schedules', 'BOQ & Cost', 'Catalogue', 'Rule Checks'];

export default function AppShell({ email, chip, active, designId, onNav, children }: Props) {
  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.href = '/login';
  }
  const initials = email.slice(0, 2).toUpperCase();
  const item = (key: NavKey, label: string, icon: string, enabled = true) => {
    const cls = key === active ? 'sa-sb-single active' : 'sa-mg';
    if (!enabled) return null;
    if (key === 'designs') return <a key={key} className={cls} href="/"><span className="sa-mg-ic">{icon}</span>{label}</a>;
    return (
      <button key={key} type="button" className={`${cls} nav-btn`} onClick={() => onNav?.(key)}>
        <span className="sa-mg-ic">{icon}</span>
        {label}
      </button>
    );
  };

  return (
    <div className="sa-shell">
      <header className="sa-header">
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
        <aside className="sa-sidebar">
          <div className="sa-sb-head">Navigation</div>
          {item('designs', 'My Designs', '⌂')}
          {designId && item('studio', 'Design Studio', 'D')}
          {designId && item('versions', 'Versions', 'V')}
          {designId && item('share', 'Share', 'S')}
          {SOON.map((label) => (
            <div key={label} className="sa-mg disabled" title="Coming in a later slice">
              <span className="sa-mg-ic">{label[0]}</span>
              {label}
              <span className="sa-mg-chev">soon</span>
            </div>
          ))}
        </aside>
        <main className="sa-main">{children}</main>
      </div>
    </div>
  );
}
