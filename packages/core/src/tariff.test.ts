import { describe, expect, it } from 'vitest';
import {
  TARIFF_NOE_END_STAGE,
  TARIFF_NOE_2027_STEP1,
  annualCost,
  billedKw,
  marginalMonthlyPrice,
  monthlyCost,
  monthlySaving,
  tariffFor,
} from './tariff.js';

describe('capacity tariff', () => {
  it('bills at least the minimum power', () => {
    expect(billedKw(6.2, TARIFF_NOE_2027_STEP1)).toBe(10);
    expect(billedKw(12.5, TARIFF_NOE_2027_STEP1)).toBe(12.5);
  });

  it('applies tiers progressively (end stage)', () => {
    expect(annualCost(10, TARIFF_NOE_END_STAGE)).toBeCloseTo(338.2, 6);
    expect(annualCost(14, TARIFF_NOE_END_STAGE)).toBeCloseTo(338.2 + 4 * 67.64, 6);
    expect(monthlyCost(14, TARIFF_NOE_END_STAGE)).toBeCloseTo((338.2 + 4 * 67.64) / 12, 6);
  });

  it('saves nothing when shaving below the minimum billed power', () => {
    expect(monthlySaving(9.5, 6, TARIFF_NOE_END_STAGE)).toBe(0);
    expect(monthlySaving(13, 9, TARIFF_NOE_END_STAGE)).toBeCloseTo((3 * 67.64) / 12, 6);
    expect(marginalMonthlyPrice(8, TARIFF_NOE_END_STAGE)).toBe(0);
    expect(marginalMonthlyPrice(12, TARIFF_NOE_END_STAGE)).toBeCloseTo(67.64 / 12, 6);
  });

  it('selects the tariff valid on a date', () => {
    const later = { ...TARIFF_NOE_END_STAGE, validFrom: '2029-01-01' };
    const list = [later, TARIFF_NOE_2027_STEP1];
    expect(tariffFor('2027-06-01', list).id).toBe(TARIFF_NOE_2027_STEP1.id);
    expect(tariffFor('2029-01-01', list).id).toBe(later.id);
    expect(tariffFor('2026-11-01', list).id).toBe(TARIFF_NOE_2027_STEP1.id);
  });
});
