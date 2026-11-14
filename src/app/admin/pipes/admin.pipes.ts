import { Pipe, PipeTransform, inject } from '@angular/core';
import { AppConfigService } from '../../core/config/app-config.service';
import { AdminDriver, AdminBus } from '../models/admin.models';

/** Montant dans la devise configurée par la société (le nom « ariary » est conservé pour les gabarits existants). */
@Pipe({ name: 'ariary', standalone: true, pure: false })
export class AriaryPipe implements PipeTransform {
  private cfg = inject(AppConfigService);
  transform(value: number | null | undefined): string {
    if (value == null || isNaN(Number(value))) return '—';
    return this.cfg.money(value);
  }
}

/** Date au format et dans le fuseau configurés par la société. `'time'` : heure seule ; `'long'` : date en toutes lettres ; `'datetime'` : date et heure. */
@Pipe({ name: 'adminDate', standalone: true, pure: false })
export class AdminDatePipe implements PipeTransform {
  private cfg = inject(AppConfigService);
  transform(value: string | null | undefined, format: 'short'|'long'|'time'|'datetime' = 'short'): string {
    if (!value || value === '—') return '—';
    if (isNaN(new Date(value).getTime())) return value;
    if (format === 'time') return this.cfg.date(value, { time: true }).split(' ').slice(1).join(' ') || '—';
    if (format === 'long') return this.cfg.date(value, { long: true });
    return this.cfg.date(value, { time: format === 'datetime' });
  }
}

@Pipe({ name: 'expiring', standalone: true, pure: false })
export class ExpiringDriversPipe implements PipeTransform {
  transform(drivers: AdminDriver[]): AdminDriver[] {
    return drivers.filter(d => {
      const days = (new Date(d.licenseExpiry).getTime() - Date.now()) / 86400000;
      return days <= 60;
    });
  }
}

@Pipe({ name: 'findBus', standalone: true, pure: false })
export class FindBusPipe implements PipeTransform {
  transform(buses: AdminBus[], busId: string): AdminBus | null {
    return buses.find(b => b.id === busId) ?? null;
  }
}

@Pipe({ name: 'permFilter', standalone: true, pure: true })
export class PermFilterPipe implements PipeTransform {
  transform(keys: string[], group: string): (keyof import('../models/admin.models').AdminPermissions)[] {
    const GROUPS: Record<string, string> = {
      canViewDashboard:'Tableau de bord',
      canViewBookings:'Réservations', canManageBookings:'Réservations',
      canViewRevenue:'Finances',
      canViewUsers:'Utilisateurs', canManageUsers:'Utilisateurs',
      canViewFleet:'Flotte', canManageFleet:'Flotte',
      canViewSeats:'Sièges',
      canViewSettings:'Paramètres', canManageSettings:'Paramètres',
      canViewRoutes:'Itinéraires', canManageRoutes:'Itinéraires',
      canViewDrivers:'Chauffeurs', canManageDrivers:'Chauffeurs',
    };
    return keys.filter(k => GROUPS[k] === group) as (keyof import('../models/admin.models').AdminPermissions)[];
  }
}
