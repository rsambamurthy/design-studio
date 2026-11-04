/**
 * Outgoing email. Sends through Resend when RESEND_API_KEY and EMAIL_FROM are
 * set. Otherwise runs in test mode: the code is written to the server log and,
 * only if AUTH_TEST_MODE=1, also returned to the browser so testers can sign in.
 */
export interface SendResult {
  delivered: boolean;
  testMode: boolean;
}

export async function sendVerificationCode(email: string, code: string): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) {
    console.info(`[auth:test-mode] verification code for ${maskEmail(email)}: ${code}`);
    return { delivered: false, testMode: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [email],
      subject: `Your Design Studio code: ${code}`,
      text: `Your Design Studio verification code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for it, ignore this email.`,
      html: `<p>Your Design Studio verification code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn't ask for it, ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    console.error('[auth] email send failed', res.status, await res.text().catch(() => ''));
    throw new Error('Could not send the verification email. Please try again.');
  }
  return { delivered: true, testMode: false };
}

export function isTestMode(): boolean {
  return process.env.AUTH_TEST_MODE === '1';
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${(user ?? '').slice(0, 2)}***@${domain ?? ''}`;
}
