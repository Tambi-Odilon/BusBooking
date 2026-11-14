import { addDays, dow, fmtDuration, localParts, localToUtc, templateRunsOn, todayIn } from '../../src/common/time';

describe('Dates, fuseaux horaires et récurrence', () => {
  it('convertit une heure locale de Madagascar (UTC+3) en instant UTC', () => {
    expect(localToUtc('2026-12-01', '08:00', 'Indian/Antananarivo').toISOString()).toBe('2026-12-01T05:00:00.000Z');
  });
  it('un départ juste après minuit local tombe la veille en UTC', () => {
    expect(localToUtc('2026-12-01', '01:30', 'Indian/Antananarivo').toISOString()).toBe('2026-11-30T22:30:00.000Z');
  });
  it('voyage de nuit : départ 21:00, arrivée 05:30 le lendemain (date de service = date de départ)', () => {
    const dep = localToUtc('2026-12-01', '21:00', 'Indian/Antananarivo');
    const arr = new Date(dep.getTime() + 510 * 60000);
    expect(localParts(dep, 'Indian/Antananarivo')).toEqual({ date: '2026-12-01', time: '21:00' });
    expect(localParts(arr, 'Indian/Antananarivo')).toEqual({ date: '2026-12-02', time: '05:30' });
    expect(arr.getTime()).toBeGreaterThan(dep.getTime());
  });
  it('changement d\'heure : la durée réelle reste exacte quand on recule d\'une heure (Paris, 25/10/2026)', () => {
    const dep = localToUtc('2026-10-24', '23:00', 'Europe/Paris');           // UTC+2
    const arr = new Date(dep.getTime() + 6 * 3600000);                       // 6 h de route
    expect(dep.toISOString()).toBe('2026-10-24T21:00:00.000Z');
    expect(localParts(arr, 'Europe/Paris')).toEqual({ date: '2026-10-25', time: '04:00' });   // et non 05:00
  });
  it('changement d\'heure : une heure locale inexistante est décalée, jamais refusée (Paris, 29/03/2026 02:30)', () => {
    const d = localToUtc('2026-03-29', '02:30', 'Europe/Paris');
    expect(isNaN(d.getTime())).toBe(false);
    expect(localParts(d, 'Europe/Paris').date).toBe('2026-03-29');
  });
  it('refuse une date impossible', () => {
    expect(() => localToUtc('2026-02-30', '08:00', 'Indian/Antananarivo')).toThrow();
  });
  it('todayIn dépend du fuseau : 22:00 UTC est déjà le lendemain à Antananarivo', () => {
    const now = new Date('2026-12-01T22:00:00Z');
    expect(todayIn('Indian/Antananarivo', now)).toBe('2026-12-02');
    expect(todayIn('UTC', now)).toBe('2026-12-01');
  });
  it('addDays et dow passent les fins de mois et d\'année', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(dow('2026-11-08')).toBe(0);   // dimanche
    expect(dow('2026-11-14')).toBe(6);   // samedi
  });
  it('fmtDuration', () => {
    expect(fmtDuration(180)).toBe('3h');
    expect(fmtDuration(390)).toBe('6h30');
    expect(fmtDuration(65)).toBe('1h05');
  });

  const base = { days: [] as number[], startDate: '2026-11-01', endDate: null, specificDate: null };
  it('récurrence quotidienne, bornée par les dates de début et de fin', () => {
    const t = { ...base, recurrence: 'daily', endDate: '2026-11-10' };
    expect(templateRunsOn(t, '2026-10-31')).toBe(false);
    expect(templateRunsOn(t, '2026-11-01')).toBe(true);
    expect(templateRunsOn(t, '2026-11-10')).toBe(true);
    expect(templateRunsOn(t, '2026-11-11')).toBe(false);
  });
  it('jours ouvrés et week-end', () => {
    expect(templateRunsOn({ ...base, recurrence: 'weekdays' }, '2026-11-09')).toBe(true);    // lundi
    expect(templateRunsOn({ ...base, recurrence: 'weekdays' }, '2026-11-14')).toBe(false);   // samedi
    expect(templateRunsOn({ ...base, recurrence: 'weekends' }, '2026-11-14')).toBe(true);
    expect(templateRunsOn({ ...base, recurrence: 'weekends' }, '2026-11-15')).toBe(true);    // dimanche
    expect(templateRunsOn({ ...base, recurrence: 'weekends' }, '2026-11-16')).toBe(false);
  });
  it('hebdomadaire et personnalisé : seulement les jours choisis', () => {
    const t = { ...base, recurrence: 'weekly', days: [1, 3, 5] };
    expect(templateRunsOn(t, '2026-11-09')).toBe(true);    // lundi
    expect(templateRunsOn(t, '2026-11-10')).toBe(false);   // mardi
    expect(templateRunsOn({ ...t, recurrence: 'custom', days: [0] }, '2026-11-15')).toBe(true);
  });
  it('ponctuel : uniquement à la date précise, même avant la date de début', () => {
    const t = { ...base, recurrence: 'once', specificDate: '2026-10-20' };
    expect(templateRunsOn(t, '2026-10-20')).toBe(true);
    expect(templateRunsOn(t, '2026-10-21')).toBe(false);
  });
  it('récurrence inconnue : jamais', () => {
    expect(templateRunsOn({ ...base, recurrence: 'monthly' }, '2026-11-09')).toBe(false);
  });
});
