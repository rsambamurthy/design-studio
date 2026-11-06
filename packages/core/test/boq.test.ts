import { describe, expect, it } from 'vitest';
import { applyOperation, costPlan, fitBudget, formatInr, measure, parseOperation, startDesign, type BuildingModel } from '../src';

const op = (n: string, a: unknown) => parseOperation(n, a);
const apply = (m: BuildingModel, n: string, a: unknown) => applyOperation(m, op(n, a)).model;
const plan = () => startDesign('3bhk', [op('set_plot', { eastWest: "40'", northSouth: "60'" }), op('set_setback', { side: 'all', distance: "5'" })], 'T').model;

describe('BOQ and cost', () => {
  it('measures the plan and prices it', () => {
    const m = plan();
    const q = measure(m);
    const b = costPlan(m);
    console.log(q, b.lines.map((l) => `${l.label}: ${l.qty} ${l.unit} × ${l.rate} = ${formatInr(l.amount)}`).join('\n'), formatInr(b.total), b.perSqft);
    expect(q.builtUpSqft).toBeGreaterThan(1200);
    expect(q.toilets).toBeGreaterThanOrEqual(2);
    expect(q.mainDoors).toBeGreaterThanOrEqual(1);
    expect(q.windowM2).toBeGreaterThan(3);
    // A typical Chennai RCC house: roughly ₹2,000–3,500 per sq ft all in.
    expect(b.perSqft).toBeGreaterThan(2000);
    expect(b.perSqft).toBeLessThan(3500);
  });

  it('changes with grades, custom rates and the plan', () => {
    let m = plan();
    const base = costPlan(m).total;
    m = apply(m, 'set_costing', { grades: { floor: 'premium' } });
    expect(costPlan(m).total).toBeGreaterThan(base);
    m = apply(m, 'set_costing', { rates: { structure: 1500 } });
    expect(costPlan(m).lines.find((l) => l.id === 'structure')!.custom).toBe(true);
    m = apply(m, 'set_costing', { rates: { structure: null } });
    expect(costPlan(m).lines.find((l) => l.id === 'structure')!.custom).toBe(false);
    expect(() => apply(m, 'set_costing', { grades: { nope: 'basic' } })).toThrow(/no cost item/);
  });

  it('fits a budget by stepping finishes down, biggest saving first', () => {
    const m = plan();
    const total = costPlan(m).total;
    const p = fitBudget(m, Math.round(total * 0.93));
    console.log(p.steps.map((s) => `${s.label}: ${s.from} → ${s.to} saves ${formatInr(s.saves)}`).join('\n'), formatInr(p.after));
    expect(p.met).toBe(true);
    expect(p.after).toBeLessThanOrEqual(p.budget);
    expect(p.steps.every((s) => !['structure', 'wall-230', 'plumbing'].includes(s.id))).toBe(true);
    const tight = fitBudget(m, Math.round(total * 0.5));
    expect(tight.met).toBe(false);
    expect(tight.sqftToCut).toBeGreaterThan(0);
  });
});
