'use client';

import { useState, type FormEvent } from 'react';

type Step = 'email' | 'pin' | 'code' | 'set-pin';

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/auth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

export default function LoginPage() {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [pin, setPinValue] = useState('');
  const [pin2, setPin2] = useState('');
  const [code, setCode] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [testCode, setTestCode] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const start = (forgotPin: boolean) =>
    run(async () => {
      const r = await post<{ next: 'pin' | 'code'; testCode?: string }>('start', { email, forgotPin });
      setResetting(forgotPin);
      setTestCode(r.testCode ?? null);
      setCode('');
      setPinValue('');
      setStep(r.next);
    });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (step === 'email') return void start(false);
    if (step === 'pin')
      return void run(async () => {
        await post('pin', { email, pin });
        window.location.href = '/';
      });
    if (step === 'code')
      return void run(async () => {
        const r = await post<{ setupToken: string }>('verify', { email, code });
        setSetupToken(r.setupToken);
        setPinValue('');
        setPin2('');
        setStep('set-pin');
      });
    if (step === 'set-pin')
      return void run(async () => {
        if (pin !== pin2) throw new Error("The two PINs don't match.");
        await post('set-pin', { setupToken, pin });
        window.location.href = '/';
      });
  };

  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-brand">
          <div className="login-mark">DS</div>
          <div className="login-name">Design Studio</div>
          <div className="login-tag">by Integrata · design your home by conversation</div>
        </div>

        <div className="login-body">
          {step === 'email' && (
            <>
              <label htmlFor="email">Email</label>
              <input id="email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" autoFocus required />
              <button className="btn-primary login-btn" disabled={busy || !email}>{busy ? 'Please wait…' : 'Continue'}</button>
            </>
          )}

          {step === 'pin' && (
            <>
              <p className="login-hint">Signing in as <b>{email}</b> · <button type="button" className="linkish" onClick={() => setStep('email')}>change</button></p>
              <label htmlFor="pin">6-digit PIN</label>
              <input id="pin" className="pin-input" type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={(e) => setPinValue(digits(e.target.value))} autoFocus />
              <button className="btn-primary login-btn" disabled={busy || pin.length !== 6}>{busy ? 'Signing in…' : 'Sign in'}</button>
              <button type="button" className="linkish login-alt" onClick={() => void start(true)} disabled={busy}>Forgot PIN? Email me a code</button>
            </>
          )}

          {step === 'code' && (
            <>
              <p className="login-hint">We sent a 6-digit code to <b>{email}</b>. It expires in 10 minutes.</p>
              {testCode && <p className="login-test">Test mode (no email service yet): your code is <b>{testCode}</b></p>}
              <label htmlFor="code">Verification code</label>
              <input id="code" className="pin-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(digits(e.target.value))} autoFocus />
              <button className="btn-primary login-btn" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Verify'}</button>
              <button type="button" className="linkish login-alt" onClick={() => void start(resetting)} disabled={busy}>Send a new code</button>
            </>
          )}

          {step === 'set-pin' && (
            <>
              <p className="login-hint">{resetting ? 'Choose a new 6-digit PIN.' : 'Email verified. Now choose a 6-digit PIN for signing in from now on.'}</p>
              <label htmlFor="newpin">New PIN</label>
              <input id="newpin" className="pin-input" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPinValue(digits(e.target.value))} autoFocus />
              <label htmlFor="newpin2">Repeat PIN</label>
              <input id="newpin2" className="pin-input" type="password" inputMode="numeric" autoComplete="new-password" value={pin2} onChange={(e) => setPin2(digits(e.target.value))} />
              <button className="btn-primary login-btn" disabled={busy || pin.length !== 6 || pin2.length !== 6}>{busy ? 'Saving…' : 'Set PIN and continue'}</button>
            </>
          )}

          {error && <p className="login-error" role="alert">{error}</p>}
        </div>
        <div className="login-foot">Powered by Integrata · Secure &amp; Private</div>
      </form>
    </div>
  );
}
