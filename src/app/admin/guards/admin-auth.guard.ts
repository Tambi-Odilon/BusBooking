import { inject } from '@angular/core';
import { Router, CanActivateFn, UrlTree } from '@angular/router';
import { AdminSession } from '../services/admin-session.service';
import { AdminPermissions } from '../models/admin.models';

/** Première page accessible selon les permissions du compte. */
const HOME: Array<[keyof AdminPermissions, string]> = [
  ['canViewDashboard', '/admin/dashboard'], ['canSellWalkin', '/admin/walkin'], ['canViewSeats', '/admin/seats'], ['canViewBookings', '/admin/bookings'],
  ['canViewOwnSchedule', '/admin/driver-schedule'], ['canCheckTickets', '/admin/check'], ['canViewRevenue', '/admin/revenue'],
];
export function adminHome(session: AdminSession, router: Router): UrlTree {
  return router.createUrlTree([HOME.find(([p]) => session.can(p))?.[1] ?? '/admin/profile']);
}

/**
 * Ces gardes ne font que guider la navigation : la sécurité est assurée par le serveur, qui vérifie
 * la permission à chaque requête. `data.permission` accepte une permission ou une liste (l'une suffit).
 */
export const adminAuthGuard: CanActivateFn = (route) => {
  const session = inject(AdminSession), router = inject(Router);
  if (!session.user()) return router.createUrlTree(['/admin/login']);
  const required = route.data?.['permission'] as keyof AdminPermissions | (keyof AdminPermissions)[] | undefined;
  if (!required) return true;
  const list = Array.isArray(required) ? required : [required];
  return list.some(p => session.can(p)) ? true : adminHome(session, router);
};

export const adminGuestGuard: CanActivateFn = () => {
  const session = inject(AdminSession), router = inject(Router);
  return session.user() ? adminHome(session, router) : true;
};
