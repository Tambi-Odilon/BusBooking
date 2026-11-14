import { Pipe, PipeTransform, inject } from '@angular/core';
import { AppConfigService } from '../config/app-config.service';

/** Montant dans la devise configurée par la société. `{{ 37000 | money }}` → « 37 000 Ar » ; `| money:'compact'` → « 37 k Ar ». */
@Pipe({ name: 'money', standalone: true, pure: false })
export class MoneyPipe implements PipeTransform {
  private cfg = inject(AppConfigService);
  transform(value: number | null | undefined, mode: 'full' | 'compact' | 'plain' = 'full'): string {
    if (value == null || isNaN(Number(value))) return '—';
    if (mode === 'plain') return this.cfg.money(value, false);
    if (mode === 'compact') {
      const l = this.cfg.locale();
      const n = Number(value) / Math.pow(10, l.currencyDecimals);
      const abs = Math.abs(n);
      const txt = abs >= 1e6 ? (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1).replace('.', ',') + ' M' : abs >= 1e4 ? Math.round(n / 1e3) + ' k' : this.cfg.money(value, false);
      return l.currencyPosition === 'before' ? `${l.currencySymbol} ${txt}` : `${txt} ${l.currencySymbol}`;
    }
    return this.cfg.money(value);
  }
}
/** Date au format configuré. `| appDate` · `| appDate:'time'` (date et heure) · `| appDate:'long'`. */
@Pipe({ name: 'appDate', standalone: true, pure: false })
export class AppDatePipe implements PipeTransform {
  private cfg = inject(AppConfigService);
  transform(value: string | Date | null | undefined, mode: 'date' | 'time' | 'long' = 'date'): string {
    if (!value) return '—';
    return this.cfg.date(value, { time: mode === 'time', long: mode === 'long' });
  }
}
