// ── Rôles ────────────────────────────────────────────────────────────────────
export type AdminRole = 'admin' | 'comptable' | 'superviseur' | 'employe' | string;

export interface AdminPermissions {
  canViewDashboard:  boolean;
  canViewBookings:   boolean;
  canManageBookings: boolean;
  canViewRevenue:    boolean;
  canViewUsers:      boolean;
  canManageUsers:    boolean;
  canViewFleet:      boolean;
  canManageFleet:    boolean;
  canViewSeats:      boolean;
  canViewSettings:   boolean;
  canManageSettings: boolean;
  canViewRoutes:     boolean;
  canManageRoutes:   boolean;
  canViewDrivers:    boolean;
  canManageDrivers:  boolean;
  canViewOwnSchedule: boolean;  // chauffeur : voir ses propres voyages
  canSellWalkin:     boolean;  // vendre au guichet
  canRefund:         boolean;  // traiter les remboursements
  canManageAds:      boolean;  // gérer les publicités
  canViewAudit:      boolean;  // consulter le journal d'audit
  canCheckTickets:   boolean;  // contrôler les billets à l'embarquement
}

export const PERM_KEYS: (keyof AdminPermissions)[] = [
  'canViewDashboard','canViewBookings','canManageBookings','canViewRevenue',
  'canViewUsers','canManageUsers','canViewFleet','canManageFleet','canViewSeats',
  'canViewSettings','canManageSettings','canViewRoutes','canManageRoutes',
  'canViewDrivers','canManageDrivers','canViewOwnSchedule',
  'canSellWalkin','canRefund','canManageAds','canViewAudit','canCheckTickets',
];

export const PERM_META: Record<keyof AdminPermissions, { label: string; group: string; manageKey?: keyof AdminPermissions; viewKey?: keyof AdminPermissions }> = {
  canViewDashboard:  { label:'Voir le tableau de bord', group:'Tableau de bord' },
  canViewBookings:   { label:'Voir les réservations',   group:'Réservations', manageKey:'canManageBookings' },
  canManageBookings: { label:'Gérer les réservations',  group:'Réservations', viewKey:'canViewBookings' },
  canViewRevenue:    { label:'Voir les finances',        group:'Finances' },
  canViewUsers:      { label:'Voir les utilisateurs',    group:'Utilisateurs', manageKey:'canManageUsers' },
  canManageUsers:    { label:'Gérer les utilisateurs',   group:'Utilisateurs', viewKey:'canViewUsers' },
  canViewFleet:      { label:'Voir la flotte',           group:'Flotte', manageKey:'canManageFleet' },
  canManageFleet:    { label:'Gérer la flotte',          group:'Flotte', viewKey:'canViewFleet' },
  canViewSeats:      { label:'Voir les sièges',          group:'Sièges' },
  canViewSettings:   { label:'Voir les paramètres',      group:'Paramètres', manageKey:'canManageSettings' },
  canManageSettings: { label:'Gérer les paramètres',     group:'Paramètres', viewKey:'canViewSettings' },
  canViewRoutes:     { label:'Voir les itinéraires',     group:'Itinéraires', manageKey:'canManageRoutes' },
  canManageRoutes:   { label:'Gérer les itinéraires',    group:'Itinéraires', viewKey:'canViewRoutes' },
  canViewDrivers:    { label:'Voir les chauffeurs',      group:'Chauffeurs', manageKey:'canManageDrivers' },
  canManageDrivers:  { label:'Gérer les chauffeurs',     group:'Chauffeurs', viewKey:'canViewDrivers' },
  canViewOwnSchedule:{ label:'Voir son propre planning',   group:'Chauffeurs' },
  canSellWalkin:     { label:'Vendre au guichet',          group:'Réservations' },
  canCheckTickets:   { label:'Contrôler les billets',      group:'Réservations' },
  canRefund:         { label:'Traiter les remboursements', group:'Finances' },
  canManageAds:      { label:'Gérer les publicités',       group:'Paramètres' },
  canViewAudit:      { label:"Consulter le journal d'audit", group:'Paramètres' },
};

export const PERM_GROUPS: string[] = [
  'Tableau de bord','Réservations','Finances','Utilisateurs',
  'Flotte','Sièges','Itinéraires','Chauffeurs','Paramètres',
];

const ALL_PERMS = PERM_KEYS;
const permSet = (...on: (keyof AdminPermissions)[]): AdminPermissions =>
  Object.fromEntries(ALL_PERMS.map(k => [k, on.includes(k)])) as unknown as AdminPermissions;
/** Valeurs par défaut des rôles intégrés (identiques à celles du serveur, qui fait foi). */
export const BUILTIN_ROLE_PERMISSIONS: Record<string, AdminPermissions> = {
  admin:       permSet(...ALL_PERMS),
  comptable:   permSet('canViewDashboard','canViewBookings','canViewRevenue','canRefund'),
  superviseur: permSet('canViewDashboard','canViewBookings','canManageBookings','canViewRevenue','canViewUsers','canViewFleet','canViewSeats','canViewRoutes','canViewDrivers','canViewOwnSchedule','canSellWalkin','canCheckTickets'),
  employe:     permSet('canViewSeats','canSellWalkin','canCheckTickets'),
  chauffeur:   permSet('canViewOwnSchedule','canCheckTickets'),
};
export const ROLE_PERMISSIONS = BUILTIN_ROLE_PERMISSIONS as Record<string, AdminPermissions>;

// ── Rôle personnalisé ─────────────────────────────────────────────────────────
export interface CustomRole {
  id:          string;    // slug: 'admin' | 'comptable' | ... | 'custom-xxx'
  uuid?:       string;    // identifiant serveur
  userCount?:  number;
  name:        string;
  description: string;
  permissions: AdminPermissions;
  color:       string;    // CSS hex color
  isBuiltin:   boolean;
  createdAt:   string;
  updatedAt:   string;
}

// ── Compte admin ─────────────────────────────────────────────────────────────
export interface AdminUser {
  id:          string;
  email:       string;
  firstName:   string;
  lastName:    string;
  role:        string;        // widened to string for custom roles
  busId?:      string;        // pour le rôle chauffeur : son véhicule assigné
  // ── Informations personnelles ──────────────────────────────────────────
  phone?:      string;        // Numéro de téléphone
  mobile?:     string;        // Mobile / WhatsApp
  address?:    string;        // Adresse postale
  city?:       string;        // Ville
  postalCode?: string;        // Code postal
  country?:    string;        // Pays (défaut: Madagascar)
  // ── Informations professionnelles ──────────────────────────────────────
  department?: string;        // Service / Département
  jobTitle?:   string;        // Intitulé du poste
  bio?:        string;        // Courte biographie
  avatarColor?: string;       // Couleur d'avatar personnalisée (hex)
  // ── Système ────────────────────────────────────────────────────────────
  publicId?:   string;        // Identifiant public immuable ex: USR-A3F7K2 (usage juridique)
  status?:     'active' | 'suspended';
  totpEnabled?: boolean;      // double authentification activée
  lastLogin:   string;
  isOnline:    boolean;
  createdAt:   string;
}

// ── Réservation ──────────────────────────────────────────────────────────────
export interface AdminBooking {
  id:             string;
  reference:      string;
  createdAt:      string;
  userId:         string;
  userName:       string;
  userEmail?:     string;
  from:           string;
  to:             string;
  date:           string;
  departure?:     string;
  arrival?:       string;
  busId?:         string;
  busName?:       string;
  busType?:       string;
  seats:          string[];
  passengerCount: number;
  totalAmount:    number;
  status:         'confirmed' | 'pending' | 'cancelled' | 'completed';
  paymentMethod:  string;
  paymentStatus:  'paid' | 'pending' | 'refunded';
  tripId?:        string;
  channel?:       string;     // 'web' | 'counter'
  phone?:         string;
  needsAttention?: boolean;
  soldByName?:    string;
}

// ── Client ───────────────────────────────────────────────────────────────────
export interface AdminClientUser {
  id:           string;
  email:        string;
  firstName:    string;
  lastName:     string;
  phone:        string;
  gender:       string;
  createdAt:    string;
  lastActive:   string;
  isOnline:     boolean;
  totalSpent:   number;
  bookingCount: number;
  status:       'active' | 'suspended' | 'banned';
  notes?:       string;
}

// ── Bus ──────────────────────────────────────────────────────────────────────
export type VehicleLayout = string;   // 'bus' | 'minibus16' | 'minibus10' ou un plan personnalisé

export interface AdminBus {
  id:            string;
  ref:           string;
  name:          string;
  type:          string;
  vehicleLayout: VehicleLayout;
  capacity:      number;
  status:        'active' | 'maintenance' | 'retired';
  plateNumber:   string;
  driver:        string;
  totalTrips:    number;
  totalRevenue:  number;
  avgOccupancy:  number;
  lastTrip:      string;
  nextTrip:      string;
  yearBuilt?:    number;
  maintenanceNote?: string;
  layoutId?:     string;
  amenities?:    string[];
}

// ── Revenu ────────────────────────────────────────────────────────────────────
export interface RevenuePoint {
  date:     string;
  amount:   number;
  bookings: number;
}

export interface RouteRevenue {
  from:     string;
  to:       string;
  revenue:  number;
  bookings: number;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export interface DashboardStats {
  todayRevenue:    number;
  monthRevenue:    number;
  totalRevenue:    number;
  todayBookings:   number;
  monthBookings:   number;
  totalBookings:   number;
  activeUsers:     number;
  totalUsers:      number;
  totalSeats:      number;
  availableSeats:  number;
  pendingSeats:    number;
  occupancyRate:   number;
  revenueGrowth:   number;
  bookingsGrowth:  number;
  cancelRate:      number;
}

export interface OnlineActivity {
  userId:    string;
  userName:  string;
  action:    string;
  page:      string;
  timestamp: string;
  ip?:       string;
}

// ── Itinéraire ───────────────────────────────────────────────────────────────
export type RouteStatus = 'active' | 'suspended' | 'deleted';

// Prix par type de véhicule — si absent, fallback sur basePrice
export interface RoutePriceByLayout { bus?: number; minibus16?: number; minibus10?: number; [layout: string]: number | undefined }

// Durée par type de véhicule (minutes) — si absent, fallback sur durationMin
export interface RouteDurationByLayout { bus?: number; minibus16?: number; minibus10?: number; [layout: string]: number | undefined }

// ── Publicité ─────────────────────────────────────────────────────────────────
export type AdPosition    = 'banner_top' | 'banner_bottom' | 'sidebar' | 'between_results' | 'notification';
export type AdStatus      = 'active' | 'paused' | 'expired' | 'scheduled';
export type AdDisplayType    = 'banner' | 'notification';
export type AdNotifPosition = 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';

export interface AdminAd {
  id:          string;
  title:       string;
  description: string;
  imageUrl?:      string;          // URL externe OU base64 data:image/...
  imagePosition?: 'left' | 'right' | 'top' | 'background'; // Position de l'image
  imageSize?:     'small' | 'medium' | 'large';             // Taille de l'image
  linkUrl?:    string;
  linkLabel?:  string;
  bgColor:     string;
  textColor:   string;
  position:    AdPosition;
  pages:       string[];    // '' = toutes les pages, ou liste ['/', '/buses', ...]
  status:      AdStatus;
  startDate:   string;      // ISO date YYYY-MM-DD
  endDate:     string;
  priority:        number;        // 1-10, plus haut = affiché en premier
  displayType:      AdDisplayType;   // 'banner' = bandeau, 'notification' = toast
  notifDuration:    number;          // Durée d'affichage en secondes (notification)
  notifPosition?:   AdNotifPosition;  // Position de la notification
  carouselInterval: number;        // Secondes entre slides (0 = pas d'auto-avancement)
  clicks:      number;
  views:       number;
  createdAt:   string;
  updatedAt:   string;
}

export interface AdminRoute {
  id:              string;
  from:            string;
  to:              string;
  distanceKm:      number;
  durationMin:     number;
  basePrice:         number;              // Prix de référence
  priceByLayout?:    RoutePriceByLayout;   // Prix spécifiques par type de véhicule
  durationByLayout?: RouteDurationByLayout; // Durée spécifique par type de véhicule
  status:          RouteStatus;
  assignedBusIds:  string[];
  totalTrips:      number;
  totalRevenue:    number;
  createdAt:       string;
  updatedAt:       string;
  notes?:          string;
  suspendReason?:  string;
  suspendedUntil?: string;
}

// ── Chauffeur ─────────────────────────────────────────────────────────────────
export type DriverStatus = 'active' | 'leave' | 'suspended' | 'resigned';
export type LicenseClass = 'B' | 'C' | 'D' | 'E';

export interface AdminDriver {
  id:             string;
  firstName:      string;
  lastName:       string;
  phone:          string;
  email?:         string;
  licenseNumber:  string;
  licenseClass:   LicenseClass;
  licenseExpiry:  string;
  status:         DriverStatus;
  userId?:        string;      // compte de connexion relié (pour que le chauffeur voie son planning)
  assignedBusId?: string;
  totalTrips:     number;
  totalKm:        number;
  avgRating:      number;
  hiredAt:        string;
  birthDate:      string;
  address?:       string;
  notes?:         string;
  leaveUntil?:    string;
  leaveReason?:   string;
}

// ── Historique de rôle ────────────────────────────────────────────────────────
export interface RoleChange {
  id:         string;
  adminId:    string;
  fromRole:   string;
  toRole:     string;
  changedBy:  string;
  changedAt:  string;
  reason?:    string;
}

// ── Token de réinitialisation MDP ─────────────────────────────────────────────
export interface ResetToken {
  adminId:    string;
  token:      string;
  expiresAt:  string;
  createdBy:  string;
  used:       boolean;
}

// ── Voyages programmés ────────────────────────────────────────────────────────
export type TripRecurrence = 'once' | 'daily' | 'weekly' | 'weekdays' | 'weekends' | 'custom';
export type TripStatus     = 'scheduled' | 'cancelled' | 'completed' | 'in_progress';

export interface AdminTrip {
  id:           string;
  routeId:      string;        // référence à AdminRoute
  busId:        string;        // véhicule assigné
  from:         string;
  to:           string;
  departure:    string;        // HH:mm
  arrival:      string;        // HH:mm (calculé)
  recurrence:   TripRecurrence;
  days:         number[];      // 0=dim…6=sam (pour weekly/custom)
  startDate:    string;        // YYYY-MM-DD
  endDate?:     string;        // fin de récurrence
  specificDate?: string;       // pour 'once'
  status:       TripStatus;
  cancelReason?: string;
  notes?:       string;
  rank?:        number;         // Rang de départ sur l'itinéraire (1=premier, 2=deuxième…)
  price:        number;
  driverId?:    string;
  conflictWith?: string | null;  // identifiant du voyage programmé en conflit (calculé par le serveur)
  createdAt:    string;
  updatedAt:    string;
}

// ── Journal d'audit ───────────────────────────────────────────────────────────
export type AuditCategory =
  | 'auth'        // Connexion, déconnexion
  | 'profile'     // Modification du profil
  | 'security'    // Changement mot de passe
  | 'users'       // Gestion utilisateurs
  | 'roles'       // Changement de rôle
  | 'trips'       // Gestion voyages
  | 'fleet'       // Gestion flotte
  | 'routes'      // Gestion itinéraires
  | 'bookings'    // Réservations
  | 'ads'         // Publicités
  | 'settings'    // Paramètres
  | 'schedule';   // Emploi du temps

export interface AuditDiff {
  field:  string;   // nom du champ modifié
  label:  string;   // libellé lisible
  before: string;   // valeur avant
  after:  string;   // valeur après
}

export interface AdminAuditEntry {
  id:          string;
  adminId:     string;    // auteur de l'action
  adminPublicId?: string; // publicId de l'auteur (traçabilité juridique)
  category:    AuditCategory;
  action:      string;    // libellé court ex: "Voyage créé"
  details?:    string;    // description complète
  diff?:       AuditDiff[]; // champs modifiés avec valeurs avant/après
  targetId?:   string;    // id de la ressource concernée
  targetName?: string;    // nom lisible de la ressource
  severity:    'info' | 'warning' | 'success' | 'danger';
  ipHint?:     string;    // adresse IP enregistrée par le serveur
  adminName?:  string;
  createdAt:   string;
}
