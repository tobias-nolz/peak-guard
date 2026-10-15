import { describe, expect, it } from 'vitest';
import {
  detectAlignment,
  parseMeterCsv,
  parseNumber,
  parseWallClock,
  toIntervalStarts,
} from './meter-csv.js';

const Z = (iso: string) => Date.parse(iso);

describe('parseNumber', () => {
  it('handles comma and point decimals with thousands separators', () => {
    expect(parseNumber('0,125')).toBe(0.125);
    expect(parseNumber('1.234,5')).toBe(1234.5);
    expect(parseNumber('1,234.5')).toBe(1234.5);
    expect(parseNumber('')).toBeNull();
  });
});

describe('parseWallClock', () => {
  it('parses Austrian and ISO formats', () => {
    expect(parseWallClock('05.01.2027 18:15')).toEqual({ d: 5, mo: 1, y: 2027, h: 18, mi: 15 });
    expect(parseWallClock('2027-01-05T18:15:00')).toEqual({ y: 2027, mo: 1, d: 5, h: 18, mi: 15 });
    expect(parseWallClock('18:15')).toEqual({ h: 18, mi: 15 });
    expect(parseWallClock('5.1.2027')).toEqual({ d: 5, mo: 1, y: 2027 });
  });
});

describe('parseMeterCsv', () => {
  it('reads a single-timestamp export with decimal commas (kWh)', () => {
    const csv = [
      'Zählpunkt;AT0020000000000000000000000000000',
      '',
      'Messzeitpunkt;Gemessener Verbrauch (kWh);Status',
      '05.01.2027 18:15;0,500;',
      '05.01.2027 18:30;3,100;Ersatzwert',
      '05.01.2027 18:45;;',
    ].join('\r\n');
    const p = parseMeterCsv(csv);
    expect(p.alignment).toBeNull();
    expect(p.columns).toEqual({
      time: 'Messzeitpunkt',
      value: 'Gemessener Verbrauch (kWh)',
      unit: 'kWh',
      ignored: [],
    });
    expect(p.rows).toEqual([
      { ts: Z('2027-01-05T17:15:00Z'), wh: 500, status: null },
      { ts: Z('2027-01-05T17:30:00Z'), wh: 3100, status: 'Ersatzwert' },
    ]);
    expect(p.skipped).toBe(1);
  });

  it('uses the "von" column of from/to exports with separate date', () => {
    const csv =
      'Datum,Zeit von,Zeit bis,Verbrauch [kWh]\n01.07.2027,00:00,00:15,"0,25"\n01.07.2027,00:15,00:30,"0,30"\n';
    const p = parseMeterCsv(csv);
    expect(p.alignment).toBe('start');
    expect(p.rows.map((r) => r.ts)).toEqual([Z('2027-06-30T22:00:00Z'), Z('2027-06-30T22:15:00Z')]);
    expect(p.rows[1]!.wh).toBe(300);
  });

  it('does not mistake a status column for the value', () => {
    const p = parseMeterCsv('Messzeitpunkt;Ersatzwert;Verbrauch (kWh)\n05.01.2027 18:15;E;0,5\n');
    expect(p.columns.value).toBe('Verbrauch (kWh)');
    expect(p.rows[0]).toMatchObject({ wh: 500, status: 'E' });
  });

  it('converts kW (average power) values to energy', () => {
    const p = parseMeterCsv('Zeitstempel;Leistung kW\n2027-01-05 18:00;12\n');
    expect(p.rows[0]!.wh).toBe(3000);
  });

  it('places the repeated hour at the end of DST correctly', () => {
    const csv = [
      'Messzeitpunkt;Verbrauch kWh',
      '25.10.2026 02:45;1',
      '25.10.2026 02:00;1',
      '25.10.2026 02:15;1',
    ].join('\n');
    const p = parseMeterCsv(csv);
    // 02:45 CEST = 00:45Z, then 02:00 CET = 01:00Z
    expect(p.rows.map((r) => new Date(r.ts).toISOString())).toEqual([
      '2026-10-25T00:45:00.000Z',
      '2026-10-25T01:00:00.000Z',
      '2026-10-25T01:15:00.000Z',
    ]);
  });

  it('reads the Netz NÖ export of an energy-community member', () => {
    // header verbatim from smartmeter.netz-noe.at; values made up
    const csv = [
      'Messzeitpunkt;Verbrauch (kWh);Qualität;Restnetzbezug (kWh);Qualität EG;Eigendeckung (kWh);Ideeller Anteil (kWh);Eigendeckung erneuerb. Energie (kWh)',
      '01.01.2026 00:15;0,500000;L1;0,499990;L1;0,000010;0,000010;0,000010',
      '01.01.2026 00:30;0,650000;L1;0,650000;L1;0,000000;0,000000;0,000000',
      '01.01.2026 00:45;2,750000;L2;2,749875;L1;0,000125;0,000125;0,000125',
    ].join('\r\n');
    const p = parseMeterCsv(csv);
    expect(p.alignment).toBeNull(); // end-stamped; decided by detectAlignment
    expect(p.columns).toEqual({
      time: 'Messzeitpunkt',
      value: 'Verbrauch (kWh)',
      unit: 'kWh',
      ignored: [
        'Restnetzbezug (kWh)',
        'Eigendeckung (kWh)',
        'Ideeller Anteil (kWh)',
        'Eigendeckung erneuerb. Energie (kWh)',
      ],
    });
    expect(p.rows).toEqual([
      { ts: Z('2025-12-31T23:15:00Z'), wh: 500, status: 'L1' },
      { ts: Z('2025-12-31T23:30:00Z'), wh: 650, status: 'L1' },
      { ts: Z('2025-12-31T23:45:00Z'), wh: 2750, status: 'L2' },
    ]);
    expect(p.skipped).toBe(0);
    expect(p.warnings).toEqual([]);
  });

  it('prefers the metered column even when derived columns come first', () => {
    const p = parseMeterCsv(
      'Messzeitpunkt;Restnetzbezug (kWh);Verbrauch (kWh)\n01.01.2026 00:15;1;2\n',
    );
    expect(p.columns.value).toBe('Verbrauch (kWh)');
    expect(p.rows[0]!.wh).toBe(2000);
  });

  it('refuses a feed-in export', () => {
    expect(() =>
      parseMeterCsv('Messzeitpunkt;Einspeisung (kWh);Qualität\n01.06.2026 12:15;1,2;L1\n'),
    ).toThrow(/feed-in/);
  });

  it('rejects files without a recognizable header', () => {
    expect(() => parseMeterCsv('a;b\n1;2\n')).toThrow(/header/);
  });
});

describe('detectAlignment', () => {
  const own = new Map<number, number>();
  const base = Z('2027-01-05T00:00:00Z');
  for (let i = 0; i < 96; i++) own.set(base + i * 900_000, 100 + (i % 7) * 300);

  it('detects end-stamped rows', () => {
    const rows = [...own].map(([start, wh]) => ({
      ts: start + 900_000,
      wh: wh * 1.01,
      status: null,
    }));
    expect(detectAlignment(rows, own)).toBe('end');
    expect(toIntervalStarts(rows, 'end')[0]!.start).toBe(base);
  });

  it('detects start-stamped rows', () => {
    const rows = [...own].map(([start, wh]) => ({ ts: start, wh, status: null }));
    expect(detectAlignment(rows, own)).toBe('start');
  });

  it('defaults to end without overlap', () => {
    expect(detectAlignment([{ ts: 0, wh: 1, status: null }], own)).toBe('end');
  });
});
