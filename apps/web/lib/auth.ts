/**
 * Sign-in: email verification code once, then a 6-digit PIN for everyday use.
 *
 * - Codes: 6 digits, 10-minute expiry, 5 attempts, at most 5 sent per email per hour.
 *   Stored only as an HMAC.
 * - PINs: 6 digits, stored as scrypt hashes. 5 wrong PINs lock the account for
 *   15 minutes; "Forgot PIN" goes back through the email code.
 * - Sessions: random 32-byte token in an httpOnly cookie, stored as a SHA-256 hash, 30 days.
 */
import { createHash, createHmac, randomInt, scrypt as scryptCb, timingSafeEqual, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { getDb, newId, type Db } from './db';
import { isTestMode, sendVerificationCode } from './email';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'ds_session';
const SESSION_DAYS = 30;
const CODE_TTL_MIN = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MIN = 15;
const SETUP_TTL_MIN = 15;

export class AuthError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface User {
  id: string;
  email: string;
}

function secret(): string {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === 'production' && process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith('memory://')) {
    throw new AuthError('Server sign-in is not configured (AUTH_SECRET missing).', 500);
  }
  return 'dev-only-secret-do-not-use-in-production-0000';
}

const hmac = (v: string) => createHmac('sha256', secret()).update(v).digest('base64url');
const sha256 = (v: string) => createHash('sha256').update(v).digest('base64url');

export function normaliseEmail(input: unknown): string {
  const email = String(input ?? '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AuthError('Enter a valid email address.');
  return email;
}

// ---------- Step 1: start ----------

export type StartResult = { next: 'pin' } | { next: 'code'; testCode?: string; testMode: boolean };

export async function startSignIn(emailInput: unknown, forgotPin = false): Promise<StartResult> {
  const email = normaliseEmail(emailInput);
  const db = await getDb();
  const user = await findUser(db, email);
  if (user?.pin_hash && !forgotPin) return { next: 'pin' };

  const { rows: recent } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM email_codes WHERE email = $1 AND created_at > now() - interval '1 hour'`,
    [email],
  );
  if ((recent[0]?.n ?? 0) >= CODES_PER_HOUR) throw new AuthError('Too many codes requested. Try again in an hour.', 429);

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.query(
    `INSERT INTO email_codes (id, email, code_hash, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval)`,
    [newId(), email, hmac(`${email}:${code}`), String(CODE_TTL_MIN)],
  );
  const sent = await sendVerificationCode(email, code);
  return { next: 'code', testMode: sent.testMode, ...(sent.testMode && isTestMode() ? { testCode: code } : {}) };
}

// ---------- Step 2: verify code ----------

export async function verifyCode(emailInput: unknown, codeInput: unknown): Promise<{ setupToken: string; hasPin: boolean }> {
  const email = normaliseEmail(emailInput);
  const code = String(codeInput ?? '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) throw new AuthError('The code is 6 digits.');
  const db = await getDb();
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: string; code_hash: string; attempts: number; expired: boolean }>(
      `SELECT id, code_hash, attempts, expires_at < now() AS expired FROM email_codes
       WHERE email = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    const row = rows[0];
    if (!row || row.expired) throw new AuthError('That code has expired. Request a new one.');
    if (row.attempts >= CODE_MAX_ATTEMPTS) throw new AuthError('Too many wrong attempts. Request a new code.', 429);
    if (!safeEqual(row.code_hash, hmac(`${email}:${code}`))) {
      await q.query(`UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
      const left = CODE_MAX_ATTEMPTS - row.attempts - 1;
      throw new AuthError(left > 0 ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Too many wrong attempts. Request a new code.');
    }
    await q.query(`UPDATE email_codes SET used_at = now() WHERE id = $1`, [row.id]);
    const user = await findUser(q, email);
    const exp = Date.now() + SETUP_TTL_MIN * 60_000;
    const payload = `${email}|${exp}`;
    return { setupToken: `${Buffer.from(payload).toString('base64url')}.${hmac(`setup:${payload}`)}`, hasPin: !!user?.pin_hash };
  });
}

// ---------- Step 3: set PIN (new user or forgot PIN) ----------

export async function setPin(setupToken: unknown, pinInput: unknown): Promise<{ user: User; token: string }> {
  const email = readSetupToken(String(setupToken ?? ''));
  const pin = validatePin(pinInput);
  const pinHash = await hashPin(pin);
  const db = await getDb();
  const user = await db.tx(async (q) => {
    const existing = await findUser(q, email);
    if (existing) {
      await q.query(`UPDATE users SET pin_hash = $1, failed_pins = 0, locked_until = NULL WHERE id = $2`, [pinHash, existing.id]);
      await q.query(`DELETE FROM sessions WHERE user_id = $1`, [existing.id]);
      return { id: existing.id, email };
    }
    const id = newId();
    await q.query(`INSERT INTO users (id, email, pin_hash) VALUES ($1, $2, $3)`, [id, email, pinHash]);
    return { id, email };
  });
  return { user, token: await createSession(db, user.id) };
}

// ---------- Everyday sign-in ----------

export async function signInWithPin(emailInput: unknown, pinInput: unknown): Promise<{ user: User; token: string }> {
  const email = normaliseEmail(emailInput);
  const pin = String(pinInput ?? '');
  const db = await getDb();
  const user = await findUser(db, email);
  if (!user?.pin_hash) throw new AuthError('No PIN set for this email yet. Use "Forgot PIN" to set one.');
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60_000);
    throw new AuthError(`Too many wrong PINs. Try again in ${mins} min, or use "Forgot PIN".`, 429);
  }
  if (!(await checkPin(pin, user.pin_hash))) {
    const fails = user.failed_pins + 1;
    if (fails >= PIN_MAX_FAILS) {
      await db.query(`UPDATE users SET failed_pins = 0, locked_until = now() + ($2 || ' minutes')::interval WHERE id = $1`, [user.id, String(PIN_LOCK_MIN)]);
      throw new AuthError(`Too many wrong PINs. Locked for ${PIN_LOCK_MIN} minutes, or use "Forgot PIN".`, 429);
    }
    await db.query(`UPDATE users SET failed_pins = $2 WHERE id = $1`, [user.id, fails]);
    const left = PIN_MAX_FAILS - fails;
    throw new AuthError(`Wrong PIN. ${left} ${left === 1 ? 'try' : 'tries'} left.`, 401);
  }
  await db.query(`UPDATE users SET failed_pins = 0, locked_until = NULL WHERE id = $1`, [user.id]);
  return { user: { id: user.id, email }, token: await createSession(db, user.id) };
}

// ---------- Sessions ----------

async function createSession(db: Db, userId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await db.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 || ' days')::interval)`, [sha256(token), userId, String(SESSION_DAYS)]);
  return token;
}

export async function setSessionCookie(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  });
}

export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const db = await getDb();
  const { rows } = await db.query<User>(
    `SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) throw new AuthError('Please sign in.', 401);
  return user;
}

export async function signOut() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await (await getDb()).query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]);
  jar.delete(SESSION_COOKIE);
}

// ---------- Helpers ----------

interface UserRow {
  id: string;
  pin_hash: string | null;
  failed_pins: number;
  locked_until: string | null;
}

async function findUser(db: Db, email: string): Promise<UserRow | undefined> {
  const { rows } = await db.query<UserRow>(`SELECT id, pin_hash, failed_pins, locked_until FROM users WHERE email = $1`, [email]);
  return rows[0];
}

function validatePin(input: unknown): string {
  const pin = String(input ?? '');
  if (!/^\d{6}$/.test(pin)) throw new AuthError('PIN must be exactly 6 digits.');
  const ascending = '0123456789012345';
  const descending = '9876543210987654';
  if (/^(\d)\1{5}$/.test(pin) || ascending.includes(pin) || descending.includes(pin)) {
    throw new AuthError('That PIN is too easy to guess. Avoid repeated or sequential digits.');
  }
  return pin;
}

async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(pin, salt, 32);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

async function checkPin(pin: string, stored: string): Promise<boolean> {
  const [, saltB64, hashB64] = stored.split('$');
  if (!saltB64 || !hashB64) return false;
  const hash = await scrypt(pin, Buffer.from(saltB64, 'base64url'), 32);
  return safeEqual(hash.toString('base64url'), hashB64);
}

function readSetupToken(token: string): string {
  const [body, sig] = token.split('.');
  if (!body || !sig) throw new AuthError('Your verification expired. Start again.', 401);
  const payload = Buffer.from(body, 'base64url').toString();
  if (!safeEqual(sig, hmac(`setup:${payload}`))) throw new AuthError('Your verification expired. Start again.', 401);
  const [email, exp] = payload.split('|');
  if (!email || !exp || Number(exp) < Date.now()) throw new AuthError('Your verification expired. Start again.', 401);
  return email;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Turn thrown errors into a JSON response body + status. */
export function authErrorResponse(err: unknown): { body: { error: string }; status: number } {
  if (err instanceof AuthError) return { body: { error: err.message }, status: err.status };
  console.error('[auth] unexpected error', err);
  return { body: { error: 'Something went wrong. Please try again.' }, status: 500 };
}
