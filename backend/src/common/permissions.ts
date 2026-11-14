/** Permissions du back-office. Les 16 premières reprennent celles du frontend d'origine. */
export const PERMISSIONS = [
  'canViewDashboard', 'canViewBookings', 'canManageBookings', 'canViewRevenue',
  'canViewUsers', 'canManageUsers', 'canViewFleet', 'canManageFleet', 'canViewSeats',
  'canViewSettings', 'canManageSettings', 'canViewRoutes', 'canManageRoutes',
  'canViewDrivers', 'canManageDrivers', 'canViewOwnSchedule',
  'canSellWalkin', 'canRefund', 'canManageAds', 'canViewAudit', 'canCheckTickets',
] as const;
export type Permission = typeof PERMISSIONS[number];
export type PermissionSet = Record<Permission, boolean>;

const set = (...on: Permission[]): PermissionSet =>
  Object.fromEntries(PERMISSIONS.map(p => [p, on.includes(p)])) as PermissionSet;

export const BUILTIN_ROLES: Array<{ slug: string; name: string; description: string; color: string; permissions: PermissionSet }> = [
  { slug: 'admin', name: 'Administrateur', description: 'Accès complet', color: '#ef4444', permissions: set(...PERMISSIONS) },
  { slug: 'comptable', name: 'Comptable', description: 'Finances et réservations en lecture, remboursements', color: '#10b981',
    permissions: set('canViewDashboard', 'canViewBookings', 'canViewRevenue', 'canRefund') },
  { slug: 'superviseur', name: 'Superviseur', description: 'Supervision de l\'exploitation', color: '#3b82f6',
    permissions: set('canViewDashboard', 'canViewBookings', 'canManageBookings', 'canViewRevenue', 'canViewUsers', 'canViewFleet',
      'canViewSeats', 'canViewRoutes', 'canViewDrivers', 'canViewOwnSchedule', 'canSellWalkin', 'canCheckTickets') },
  { slug: 'employe', name: 'Employé / Guichet', description: 'Vente au guichet et contrôle des billets', color: '#64748b',
    permissions: set('canViewSeats', 'canSellWalkin', 'canCheckTickets') },
  { slug: 'chauffeur', name: 'Chauffeur', description: 'Consultation de son planning, contrôle des billets', color: '#059669',
    permissions: set('canViewOwnSchedule', 'canCheckTickets') },
];
export function normalizePermissions(input: any): PermissionSet {
  return Object.fromEntries(PERMISSIONS.map(p => [p, input?.[p] === true])) as PermissionSet;
}
