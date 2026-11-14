import { Routes } from '@angular/router';
import { adminAuthGuard, adminGuestGuard } from './admin/guards/admin-auth.guard';
import { setupDoneGuard, setupPendingGuard } from './core/setup.guard';

const page = (path: string, permission: string | string[] | null, loadComponent: () => Promise<any>, extra: Record<string, unknown> = {}) =>
  ({ path, canActivate: [adminAuthGuard], data: { ...(permission ? { permission } : {}), ...extra }, loadComponent });

export const routes: Routes = [
  /* ── Assistant de première configuration (accessible uniquement tant que l'application n'est pas configurée) ── */
  { path: 'setup', canActivate: [setupPendingGuard], loadComponent: () => import('./features/setup/setup.component').then(m => m.SetupComponent) },

  /* ── Site client ─────────────────────────────────────────────────── */
  {
    path: '',
    canActivate: [setupDoneGuard],
    loadComponent: () => import('./layout/layout.component').then(m => m.LayoutComponent),
    children: [
      { path: '', loadComponent: () => import('./features/search/search.component').then(m => m.SearchComponent) },
      { path: 'buses', loadComponent: () => import('./features/bus-list/bus-list.component').then(m => m.BusListComponent) },
      { path: 'seats', loadComponent: () => import('./features/seat-selection/seat-selection.component').then(m => m.SeatSelectionComponent) },
      { path: 'passengers', loadComponent: () => import('./features/passenger-details/passenger-details.component').then(m => m.PassengerDetailsComponent) },
      { path: 'payment', loadComponent: () => import('./features/payment/payment.component').then(m => m.PaymentComponent) },
      { path: 'confirmation', loadComponent: () => import('./features/confirmation/confirmation.component').then(m => m.ConfirmationComponent) },
      { path: 'profile', loadComponent: () => import('./features/profile/profile.component').then(m => m.ProfileComponent) },
      { path: 'find', loadComponent: () => import('./features/ticket/my-ticket.component').then(m => m.MyTicketComponent) },
      { path: 'booking/:reference', loadComponent: () => import('./features/ticket/my-ticket.component').then(m => m.MyTicketComponent) },
      { path: 'legal/:doc', loadComponent: () => import('./features/legal/legal.component').then(m => m.LegalComponent) },
    ],
  },
  { path: 'reset-password', canActivate: [setupDoneGuard], data: { scope: 'customer' }, loadComponent: () => import('./features/auth/reset-password.component').then(m => m.ResetPasswordComponent) },

  /* ── Back-office (préfixe /admin) — chaque page indique la permission qui l'ouvre ── */
  {
    path: 'admin',
    canActivate: [setupDoneGuard],
    children: [
      { path: 'login', canActivate: [adminGuestGuard], loadComponent: () => import('./admin/pages/login/admin-login.component').then(m => m.AdminLoginComponent) },
      { path: 'reset-password', data: { scope: 'staff' }, loadComponent: () => import('./features/auth/reset-password.component').then(m => m.ResetPasswordComponent) },
      {
        path: '',
        canActivate: [adminAuthGuard],
        loadComponent: () => import('./admin/layout/admin-layout.component').then(m => m.AdminLayoutComponent),
        children: [
          page('', null, () => import('./admin/pages/home/admin-home.component').then(m => m.AdminHomeComponent)),
          page('dashboard', 'canViewDashboard', () => import('./admin/pages/dashboard/dashboard.component').then(m => m.DashboardComponent)),
          page('walkin', 'canSellWalkin', () => import('./admin/pages/walkin/walkin.component').then(m => m.WalkinComponent)),
          page('check', 'canCheckTickets', () => import('./admin/pages/check/ticket-check.component').then(m => m.TicketCheckComponent)),
          page('bookings', 'canViewBookings', () => import('./admin/pages/bookings/bookings.component').then(m => m.BookingsComponent)),
          page('refunds', ['canRefund', 'canViewRevenue'], () => import('./admin/pages/refunds/refunds.component').then(m => m.RefundsComponent)),
          page('revenue', 'canViewRevenue', () => import('./admin/pages/revenue/revenue.component').then(m => m.RevenueComponent)),
          page('users', 'canViewUsers', () => import('./admin/pages/users/users.component').then(m => m.UsersComponent)),
          page('users/client/:id', 'canViewUsers', () => import('./admin/pages/client-detail/client-detail.component').then(m => m.ClientDetailComponent)),
          page('users/admin/:id', 'canViewUsers', () => import('./admin/pages/admin-detail/admin-detail.component').then(m => m.AdminDetailComponent)),
          page('seats', ['canViewSeats', 'canSellWalkin'], () => import('./admin/pages/seats/seats.component').then(m => m.SeatsComponent)),
          page('fleet', 'canViewFleet', () => import('./admin/pages/fleet/fleet.component').then(m => m.FleetComponent)),
          page('drivers', 'canViewDrivers', () => import('./admin/pages/drivers/drivers.component').then(m => m.DriversComponent)),
          page('itineraires', 'canViewRoutes', () => import('./admin/pages/routes/routes.component').then(m => m.RoutesComponent)),
          page('trips', 'canViewRoutes', () => import('./admin/pages/trips/trips.component').then(m => m.TripsComponent)),
          page('schedule', 'canViewRoutes', () => import('./admin/pages/schedule/schedule.component').then(m => m.ScheduleComponent)),
          page('driver-schedule', 'canViewOwnSchedule', () => import('./admin/pages/driver-schedule/driver-schedule.component').then(m => m.DriverScheduleComponent)),
          page('ads', 'canManageAds', () => import('./admin/pages/ads/ads.component').then(m => m.AdsComponent)),
          page('roles', 'canViewSettings', () => import('./admin/pages/roles/roles.component').then(m => m.RolesComponent)),
          page('audit', 'canViewAudit', () => import('./admin/pages/audit/audit.component').then(m => m.AuditComponent)),
          page('messages', 'canViewSettings', () => import('./admin/pages/messages/messages.component').then(m => m.MessagesComponent)),
          page('company', 'canViewSettings', () => import('./admin/pages/company/company-settings.component').then(m => m.CompanySettingsComponent)),
          page('settings', 'canViewSettings', () => import('./admin/pages/settings/settings.component').then(m => m.SettingsComponent)),
          page('profile', null, () => import('./admin/pages/profile/profile.component').then(m => m.ProfileComponent)),
        ],
      },
    ],
  },

  { path: '**', redirectTo: '' },
];
