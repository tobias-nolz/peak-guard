/**
 * Capacity charge (Leistungspreis) maths.
 *
 * The billed power of a month is the highest 15-min average import, but at least
 * `minBilledKw`. Prices are per kW and year and can be tiered (e.g. a higher price for
 * the part above 10 kW). The monthly charge is the annual price / 12.
 */

export interface TariffTier {
  /** Upper bound of this tier in kW; null = unbounded. */
  upToKw: number | null;
  eurPerKwYear: number;
}

export interface CapacityTariff {
  id: string;
  label: string;
  /** Local date (YYYY-MM-DD) from which this tariff applies. */
  validFrom: string;
  minBilledKw: number;
  tiers: TariffTier[];
}

/**
 * Placeholder values until Netz NÖ publishes the 2027 price sheet (expected Dec 2026).
 * Assumption: the price above 10 kW is twice the base price, as in the end stage.
 */
export const TARIFF_NOE_2027_STEP1: CapacityTariff = {
  id: 'noe-2027-step1',
  label: 'Netz NÖ 2027 (first step, placeholder)',
  validFrom: '2027-01-01',
  minBilledKw: 10,
  tiers: [
    { upToKw: 10, eurPerKwYear: 19 },
    { upToKw: null, eurPerKwYear: 38 },
  ],
};

export const TARIFF_NOE_END_STAGE: CapacityTariff = {
  id: 'noe-end-stage',
  label: 'Netz NÖ end stage (placeholder)',
  validFrom: '2027-01-01',
  minBilledKw: 10,
  tiers: [
    { upToKw: 10, eurPerKwYear: 33.82 },
    { upToKw: null, eurPerKwYear: 67.64 },
  ],
};

export const DEFAULT_TARIFFS: CapacityTariff[] = [TARIFF_NOE_2027_STEP1];

/** The tariff valid on local date `date` (YYYY-MM-DD), or the earliest one as fallback. */
export function tariffFor(date: string, tariffs: readonly CapacityTariff[]): CapacityTariff {
  if (tariffs.length === 0) throw new Error('no tariffs configured');
  const sorted = [...tariffs].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  let found = sorted[0]!;
  for (const t of sorted) if (t.validFrom <= date) found = t;
  return found;
}

export function billedKw(peakKw: number, tariff: CapacityTariff): number {
  return Math.max(peakKw, tariff.minBilledKw);
}

/** Annual cost (€) for a billed power, applying tiers progressively. */
export function annualCost(kw: number, tariff: CapacityTariff): number {
  let cost = 0;
  let lower = 0;
  for (const tier of tariff.tiers) {
    const upper = tier.upToKw ?? Infinity;
    if (kw > lower) cost += (Math.min(kw, upper) - lower) * tier.eurPerKwYear;
    lower = upper;
    if (kw <= upper) break;
  }
  return cost;
}

/** Capacity charge for one month (€) given the month's peak 15-min average import (kW). */
export function monthlyCost(peakKw: number, tariff: CapacityTariff): number {
  return annualCost(billedKw(peakKw, tariff), tariff) / 12;
}

/** Monthly saving (€) from lowering the month's peak from `fromKw` to `toKw`. */
export function monthlySaving(fromKw: number, toKw: number, tariff: CapacityTariff): number {
  return monthlyCost(fromKw, tariff) - monthlyCost(toKw, tariff);
}

/** Marginal monthly price (€/kW) at power `kw` — what one more kW of peak costs. */
export function marginalMonthlyPrice(kw: number, tariff: CapacityTariff): number {
  if (kw < tariff.minBilledKw) return 0;
  for (const tier of tariff.tiers) {
    if (tier.upToKw == null || kw < tier.upToKw) return tier.eurPerKwYear / 12;
  }
  return 0;
}
