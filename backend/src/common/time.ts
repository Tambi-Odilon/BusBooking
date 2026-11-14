import { DateTime } from 'luxon';

/** Convertit une date locale (AAAA-MM-JJ) et une heure locale (HH:mm) du fuseau de la société en instant UTC. */
export function localToUtc(date: string, time: string, zone: string): Date {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone });
  if (!dt.isValid) throw new Error(`Date/heure invalide : ${date} ${time} (${zone})`);
  return dt.toUTC().toJSDate();   // luxon décale automatiquement une heure inexistante (changement d'heure)
}
export const todayIn = (zone: string, now = new Date()) => DateTime.fromJSDate(now, { zone }).toISODate()!;
export const addDays = (date: string, n: number) => DateTime.fromISO(date, { zone: 'utc' }).plus({ days: n }).toISODate()!;
/** Jour de la semaine 0 = dimanche … 6 = samedi, pour une date civile. */
export const dow = (date: string) => DateTime.fromISO(date, { zone: 'utc' }).weekday % 7;
export const localParts = (d: Date, zone: string) => {
  const dt = DateTime.fromJSDate(d, { zone });
  return { date: dt.toISODate()!, time: dt.toFormat('HH:mm') };
};
export function fmtDuration(min: number): string { const h = Math.floor(min / 60), m = min % 60; return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`; }

/** Un modèle de voyage récurrent est-il actif à cette date ? (reprend la logique du frontend d'origine) */
export function templateRunsOn(t: { recurrence: string; days: number[]; startDate: string; endDate?: string | null; specificDate?: string | null }, date: string): boolean {
  if (t.recurrence === 'once') return t.specificDate === date;
  if (t.startDate > date) return false;
  if (t.endDate && t.endDate < date) return false;
  const d = dow(date);
  switch (t.recurrence) {
    case 'daily': return true;
    case 'weekdays': return d >= 1 && d <= 5;
    case 'weekends': return d === 0 || d === 6;
    case 'weekly': case 'custom': return (t.days || []).includes(d);
    default: return false;
  }
}
