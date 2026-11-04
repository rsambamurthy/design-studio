/**
 * Deterministic length parsing and formatting. Units were one of the two most
 * common error sources in the reference project, so this is plain code, never
 * left to the LLM's judgement.
 */
import { ModelError, type Mm } from './model';

export const MM_PER_INCH = 25.4;
export const MM_PER_FOOT = 304.8;

export interface ParsedLength {
  mm: Mm;
  /** True when the input had no explicit unit and feet were assumed. */
  assumedUnit: boolean;
  /** Human-readable note about any assumption made. */
  note?: string;
}

const NUM = String.raw`(\d+(?:\.\d+)?|\d*\.\d+)`;
const FRACTION = String.raw`(?:\s*(?:-|\s)\s*(\d+)\/(\d+))?`;

/**
 * Parse a length written the way Indian users write it:
 * 8", 8 in, 8 inches, 1'6", 1' 6", 1 ft 6 in, 1.5 ft, 5'-0", 10 1/2",
 * 450mm, 45 cm, 0.45 m, and bare numbers (assumed feet, flagged).
 */
export function parseLength(input: string): ParsedLength {
  const raw = input.trim().toLowerCase().replace(/[’′]/g, "'").replace(/[”″]/g, '"').replace(/''/g, '"');
  if (!raw) throw new ModelError('Empty length');

  let m: RegExpMatchArray | null;

  // Metric
  if ((m = raw.match(new RegExp(`^${NUM}\\s*(mm|millimet(?:er|re)s?)$`)))) return exact(Number(m[1]));
  if ((m = raw.match(new RegExp(`^${NUM}\\s*(cm|centimet(?:er|re)s?)$`)))) return exact(Number(m[1]) * 10);
  if ((m = raw.match(new RegExp(`^${NUM}\\s*(m|met(?:er|re)s?)$`)))) return exact(Number(m[1]) * 1000);

  // Feet and inches: 1'6", 1' 6", 5'-0", 1 ft 6 in, 1 feet 6 inches, 1'6 1/2"
  m = raw.match(
    new RegExp(
      `^${NUM}\\s*(?:'|ft|foot|feet)\\s*-?\\s*(?:${NUM}${FRACTION}\\s*(?:"|in|inch|inches)?)?$`,
    ),
  );
  if (m) {
    const feet = Number(m[1]);
    const inches = (m[2] ? Number(m[2]) : 0) + fraction(m[3], m[4]);
    return exact(feet * MM_PER_FOOT + inches * MM_PER_INCH);
  }

  // Inches only: 8", 8 in, 8 inches, 10 1/2"
  m = raw.match(new RegExp(`^${NUM}${FRACTION}\\s*(?:"|in|inch|inches)$`));
  if (m) return exact((Number(m[1]) + fraction(m[2], m[3])) * MM_PER_INCH);

  // Bare number: assume feet, but say so.
  m = raw.match(new RegExp(`^${NUM}$`));
  if (m) {
    return {
      mm: Math.round(Number(m[1]) * MM_PER_FOOT),
      assumedUnit: true,
      note: `"${input.trim()}" had no unit; assumed feet`,
    };
  }

  throw new ModelError(`Could not read "${input}" as a length. Use forms like 8", 1'6", 450 mm.`);
}

function fraction(n?: string, d?: string): number {
  if (!n || !d) return 0;
  const den = Number(d);
  if (den === 0) throw new ModelError('Fraction with zero denominator');
  return Number(n) / den;
}

function exact(mm: number): ParsedLength {
  return { mm: Math.round(mm), assumedUnit: false };
}

/**
 * Format millimetres as feet-inches to the nearest 1/4", e.g. 2'4", 10'0", 5¾".
 * Negative values keep the sign.
 */
export function formatFtIn(mm: Mm): string {
  const sign = mm < 0 ? '-' : '';
  const quarters = Math.round(Math.abs(mm) / MM_PER_INCH / 0.25);
  const totalInches = quarters / 4;
  let feet = Math.floor(totalInches / 12);
  let inches = totalInches - feet * 12;
  if (inches >= 12) {
    feet += 1;
    inches -= 12;
  }
  const whole = Math.floor(inches);
  const frac = inches - whole;
  const fracStr = frac === 0.25 ? '¼' : frac === 0.5 ? '½' : frac === 0.75 ? '¾' : '';
  if (feet === 0) return `${sign}${whole === 0 && fracStr ? '' : whole}${fracStr}"`;
  return `${sign}${feet}'${whole}${fracStr}"`;
}

export function formatLength(mm: Mm, units: 'ft-in' | 'mm'): string {
  return units === 'mm' ? `${Math.round(mm)} mm` : formatFtIn(mm);
}
