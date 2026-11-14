import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Db } from '../../common/db';
import { env } from '../../common/env';
import { logger } from '../../common/logger';
import { EventBus } from '../../common/events';
import { todayIn } from '../../common/time';
import { SettingsService } from '../settings/settings.service';
import { SeatsService } from '../booking/seats.service';
import { BookingsService } from '../booking/bookings.service';
import { PaymentsService } from '../payments/payments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { TripsService } from '../transport/trips.service';

interface Job { name: string; everySec: number; lock: number; run: () => Promise<any>; logAlways?: boolean }

/**
 * Tâches planifiées. Chaque tâche prend un verrou consultatif PostgreSQL : avec plusieurs instances,
 * une seule l'exécute à la fois. Toutes sont idempotentes : rejouer une tâche ne casse rien.
 */
@Injectable()
export class Scheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  readonly jobs: Job[];
  constructor(private db: Db, private settings: SettingsService, private seats: SeatsService, private bookings: BookingsService,
    private payments: PaymentsService, private notifications: NotificationsService, private trips: TripsService, private bus: EventBus) {
    this.jobs = [
      { name: 'expire-holds', everySec: 15, lock: 9101, run: () => this.seats.sweepExpiredHolds() },
      { name: 'expire-bookings', everySec: 60, lock: 9102, run: () => this.bookings.expirePending() },
      { name: 'reconcile-payments', everySec: 10, lock: 9103, run: () => this.payments.reconcile() },
      { name: 'process-refunds', everySec: 60, lock: 9104, run: () => this.payments.processRefunds() },
      { name: 'send-notifications', everySec: 5, lock: 9105, run: () => this.notifications.processOutbox() },
      { name: 'close-trips', everySec: 60, lock: 9106, run: () => this.bookings.closeTrips() },
      { name: 'trip-reminders', everySec: 600, lock: 9107, run: () => this.reminders() },
      { name: 'generate-trips', everySec: 6 * 3600, lock: 9108, run: () => this.generateTrips(), logAlways: true },
      { name: 'housekeeping', everySec: 6 * 3600, lock: 9109, run: () => this.housekeeping(), logAlways: true },
    ];
  }
  onApplicationBootstrap() {
    if (env().role === 'api' || process.env.JOBS_DISABLED === 'true') return;
    for (const j of this.jobs) {
      const t = setInterval(() => this.runJob(j.name).catch(() => {}), j.everySec * 1000);
      t.unref?.(); this.timers.push(t);
    }
    setTimeout(() => { this.runJob('generate-trips').catch(() => {}); }, 3000).unref?.();
    logger.info({ jobs: this.jobs.map(j => j.name) }, 'tâches planifiées démarrées');
  }
  onModuleDestroy() { for (const t of this.timers) clearInterval(t); }

  async runJob(name: string): Promise<any> {
    const j = this.jobs.find(x => x.name === name);
    if (!j) throw new Error('tâche inconnue : ' + name);
    if (!(await this.settings.setupCompleted())) return;   // rien à faire tant que l'application n'est pas configurée
    const started = Date.now();
    try {
      const result = await this.db.withAdvisoryLock(j.lock, j.run);
      if (j.logAlways && result !== undefined)
        await this.db.q('INSERT INTO jobs_log (job, ok, info, started_at, duration_ms) VALUES ($1,true,$2,$3,$4)', [name, JSON.stringify(result ?? null).slice(0, 2000), new Date(started), Date.now() - started]);
      return result;
    } catch (e: any) {
      logger.error({ job: name, err: e?.message }, 'tâche planifiée en échec');
      await this.db.q('INSERT INTO jobs_log (job, ok, info, started_at, duration_ms) VALUES ($1,false,$2,$3,$4)', [name, String(e?.message || e).slice(0, 2000), new Date(started), Date.now() - started]).catch(() => {});
      throw e;
    }
  }

  private async generateTrips() {
    const zone = (await this.settings.get('locale')).timezone, today = todayIn(zone);
    // fin de suspension d'itinéraire et retour de congé des chauffeurs à la date prévue
    const routes = await this.db.q(`UPDATE routes SET status = 'active', suspend_reason = NULL, suspended_until = NULL, updated_at = now() WHERE status = 'suspended' AND suspended_until IS NOT NULL AND suspended_until < $1 RETURNING id`, [today]);
    const drivers = await this.db.q(`UPDATE drivers SET status = 'active', leave_until = NULL, leave_reason = NULL, updated_at = now() WHERE status = 'leave' AND leave_until IS NOT NULL AND leave_until < $1 RETURNING id`, [today]);
    const report = await this.trips.generate();
    return { created: report.created, conflicts: report.conflicts.length, routesReactivated: routes.length, driversBack: drivers.length };
  }
  private async reminders() {
    const b = await this.settings.get('booking');
    if (b.reminderHoursBefore <= 0) return 0;
    const trips = await this.db.q<{ id: string }>(
      `UPDATE trips SET reminder_sent_at = now() WHERE status = 'scheduled' AND reminder_sent_at IS NULL AND departure_at > now() AND departure_at <= now() + ($1 || ' minutes')::interval RETURNING id`,
      [String(Math.round(b.reminderHoursBefore * 60))]);
    let n = 0;
    for (const t of trips) {
      const bookings = await this.db.q<any>(`SELECT * FROM bookings WHERE trip_id = $1 AND status = 'confirmed'`, [t.id]);
      for (const bk of bookings) { await this.bookings.notifyBooking(this.db, bk, 'trip_reminder'); n++; }
    }
    return n;
  }
  /** Purge des données techniques et anonymisation des anciennes réservations (durée de conservation paramétrable). */
  private async housekeeping() {
    const legal = await this.settings.get('legal');
    const del = async (sql: string, params: any[] = []) => this.db.exec(sql, params);
    const out = {
      sessions: await del(`DELETE FROM sessions WHERE expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'`),
      authTokens: await del(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days'`),
      loginAttempts: await del(`DELETE FROM login_attempts WHERE created_at < now() - interval '30 days'`),
      idempotency: await del(`DELETE FROM idempotency_keys WHERE expires_at < now()`),
      simulations: await del(`DELETE FROM payment_simulations WHERE created_at < now() - interval '30 days'`),
      outbox: await del(`DELETE FROM notifications_outbox WHERE created_at < now() - interval '180 days'`),
      jobsLog: await del(`DELETE FROM jobs_log WHERE started_at < now() - interval '90 days'`),
      anonymized: await del(
        `UPDATE bookings SET contact_name = 'Donnée supprimée', contact_phone = '', contact_email = NULL
          WHERE status IN ('completed','cancelled','expired','no_show') AND contact_phone <> '' AND updated_at < now() - ($1 || ' months')::interval`, [String(legal.dataRetentionMonths)]),
    };
    await del(`UPDATE booking_passengers p SET first_name = 'Passager', last_name = 'supprimé', phone = '' FROM bookings b
                WHERE b.id = p.booking_id AND b.contact_phone = '' AND b.contact_name = 'Donnée supprimée' AND p.last_name <> 'supprimé'`);
    return out;
  }
}
