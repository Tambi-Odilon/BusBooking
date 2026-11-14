import { Component, inject, signal, computed, OnInit, OnDestroy } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive, Router, NavigationEnd } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { AdminAuthService } from '../services/admin-auth.service';
import { AdminDataService } from '../services/admin-data.service';
import { AdminEmailService } from '../services/admin-email.service';
import { AdminThemeService } from '../services/admin-theme.service';
import { AdminToastService, Toast } from '../services/admin-toast.service';
import { AdminPermissions } from '../models/admin.models';
import { AppConfigService } from '../../core/config/app-config.service';
import { ApiService } from '../../core/api/api.service';

interface NavItem { id: string; label: string; path: string; icon: string; group: string; permission: keyof AdminPermissions | (keyof AdminPermissions)[]; badge?: () => number|null; }

const ICONS: Record<string,string> = {
  grid:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`,
  ticket:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/></svg>`,
  trend:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`,
  users:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  layout:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>`,
  bus:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/></svg>`,
  route:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h18M12 3l7 9-7 9-7-9 7-9z"/></svg>`,
  settings:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
  logout:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
  menu:`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`,
  info:`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  check:`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  warn:`<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  cash:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg>`,
  scan:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 12h10"/></svg>`,
  refund:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`,
  driver:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg>`,
  calendar:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
  clock:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>`,
  megaphone:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/></svg>`,
  shield:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  list:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
  mail:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/></svg>`,
  building:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/></svg>`,
  seat:`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 19v2M18 19v2M5 11V6a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v5"/><path d="M3 13a2 2 0 0 1 4 0v2h10v-2a2 2 0 0 1 4 0v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
};

@Component({
  selector: 'app-admin-layout',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './admin-layout.component.html',
  styleUrl: './admin-layout.component.scss',
})
export class AdminLayoutComponent implements OnInit, OnDestroy {
  readonly auth    = inject(AdminAuthService);
  readonly emailSvc = inject(AdminEmailService);
  readonly theme   = inject(AdminThemeService);
  readonly data    = inject(AdminDataService);
  readonly toastSvc= inject(AdminToastService);
  private  router  = inject(Router);

  readonly cfg     = inject(AppConfigService);
  readonly api     = inject(ApiService);

  /** Sur téléphone, le menu est un tiroir fermé par défaut ; sur grand écran il est ouvert. */
  readonly isMobile = signal(typeof window !== 'undefined' && window.innerWidth < 900);
  readonly sidebarOpen = signal(!this.isMobile());
  readonly toasts = this.toastSvc.toasts;
  readonly currentDate = this.cfg.date(new Date(), { long: true });

  private liveTimer: ReturnType<typeof setInterval>|null = null;
  private onResize = () => { const m = window.innerWidth < 900; if (m !== this.isMobile()) { this.isMobile.set(m); this.sidebarOpen.set(!m); } };
  private clock(): string { return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: this.cfg.locale().timezone }).format(new Date()); }
  readonly liveTime = signal(this.clock());

  private stat = (k: 'pendingBookings' | 'needsAttention' | 'manualRefunds') => () => (this.data.stats() as any)[k] || null;
  readonly navItems: NavItem[] = [
    { id:'dashboard', group:'Activité', icon:'grid',   label:'Tableau de bord',     path:'/admin/dashboard', permission:'canViewDashboard' },
    { id:'walkin',    group:'Activité', icon:'cash',   label:'Vente au guichet',    path:'/admin/walkin',    permission:'canSellWalkin' },
    { id:'check',     group:'Activité', icon:'scan',   label:'Contrôle des billets',path:'/admin/check',     permission:'canCheckTickets' },
    { id:'seats',     group:'Activité', icon:'seat',   label:'Sièges en direct',    path:'/admin/seats',     permission:['canViewSeats','canSellWalkin'] },
    { id:'bookings',  group:'Activité', icon:'ticket', label:'Réservations',        path:'/admin/bookings',  permission:'canViewBookings', badge:this.stat('needsAttention') },
    { id:'driver-schedule', group:'Activité', icon:'clock', label:'Mon planning',    path:'/admin/driver-schedule', permission:'canViewOwnSchedule' },
    { id:'revenue',   group:'Finances', icon:'trend',  label:"Chiffre d'affaires",  path:'/admin/revenue',   permission:'canViewRevenue' },
    { id:'refunds',   group:'Finances', icon:'refund', label:'Remboursements',      path:'/admin/refunds',   permission:['canRefund','canViewRevenue'], badge:this.stat('manualRefunds') },
    { id:'trips',     group:'Transport', icon:'calendar', label:'Voyages',          path:'/admin/trips',       permission:'canViewRoutes' },
    { id:'schedule',  group:'Transport', icon:'layout', label:'Planning',           path:'/admin/schedule',    permission:'canViewRoutes' },
    { id:'itineraires', group:'Transport', icon:'route', label:'Itinéraires',       path:'/admin/itineraires', permission:'canViewRoutes' },
    { id:'fleet',     group:'Transport', icon:'bus',   label:'Flotte',              path:'/admin/fleet',     permission:'canViewFleet' },
    { id:'drivers',   group:'Transport', icon:'driver', label:'Chauffeurs',         path:'/admin/drivers',   permission:'canViewDrivers' },
    { id:'users',     group:'Administration', icon:'users', label:'Utilisateurs',   path:'/admin/users',     permission:'canViewUsers' },
    { id:'roles',     group:'Administration', icon:'shield', label:'Rôles et accès', path:'/admin/roles',    permission:'canViewSettings' },
    { id:'ads',       group:'Administration', icon:'megaphone', label:'Publicités', path:'/admin/ads',       permission:'canManageAds' },
    { id:'messages',  group:'Administration', icon:'mail', label:'E-mails et SMS',  path:'/admin/messages',  permission:'canViewSettings', badge:()=>this.emailSvc.failed()||null },
    { id:'audit',     group:'Administration', icon:'list', label:"Journal d'audit", path:'/admin/audit',     permission:'canViewAudit' },
    { id:'company',   group:'Administration', icon:'building', label:'Société et réglages', path:'/admin/company', permission:'canViewSettings' },
    { id:'settings',  group:'Administration', icon:'settings', label:'Système',     path:'/admin/settings',  permission:'canViewSettings' },
  ];

  readonly visibleNav = computed(() => {
    this.auth.permissions();   // recalculé quand les droits changent en cours de session
    const items = this.navItems.filter(item => (Array.isArray(item.permission) ? item.permission : [item.permission]).some(p => this.auth.can(p)));
    return items.map((item, i) => ({ ...item, firstOfGroup: i === 0 || items[i - 1].group !== item.group }));
  });

  ngOnInit(): void {
    this.liveTimer = setInterval(() => this.liveTime.set(this.clock()), 1000);
    window.addEventListener('resize', this.onResize);
    // sur téléphone, le tiroir se referme à chaque changement de page
    this.router.events.subscribe(e => { if (e instanceof NavigationEnd && this.isMobile()) this.sidebarOpen.set(false); });
  }
  ngOnDestroy(): void { if(this.liveTimer) clearInterval(this.liveTimer); window.removeEventListener('resize', this.onResize); }

  toggleSidebar() { this.sidebarOpen.update(v=>!v); }

  logout(): void { this.auth.logout(); this.router.navigate(['/admin/login']); }
  retry(): void { void this.cfg.load(); void this.data.load(); }

  getInitials(): string {
    const u=this.auth.currentAdmin();
    if(!u) return '?';
    return (u.firstName[0]??'')+(u.lastName[0]??'');
  }

  // Les icônes sont des SVG constants écrits dans ce fichier (aucune donnée utilisateur) : on peut les déclarer sûrs,
  // sinon Angular retire les balises <svg> et les icônes n'apparaissent pas.
  private readonly sanitizer = inject(DomSanitizer);
  private readonly safeIcons = new Map<string, SafeHtml>();
  icon(name: string): SafeHtml {
    let v = this.safeIcons.get(name);
    if (!v) { v = this.sanitizer.bypassSecurityTrustHtml(ICONS[name] ?? ''); this.safeIcons.set(name, v); }
    return v;
  }

  toastIcon(type: Toast['type']): SafeHtml {
    return this.icon(type==='success'?'check':type==='error'?'warn':'info');
  }

  goToProfile(): void { this.router.navigate(['/admin/profile']); }
}
