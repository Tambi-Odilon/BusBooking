import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, Router } from '@angular/router';
import { I18nService } from '../core/services/i18n.service';
import { AuthService } from '../core/services/auth.service';
import { Lang } from '../core/i18n/index';
import { AppConfigService } from '../core/config/app-config.service';
import { ApiService } from '../core/api/api.service';
import { AuthModalComponent } from '../features/auth/auth-modal.component';
import { AdBannerComponent } from '../features/ad-banner/ad-banner.component';
import { AdNotificationComponent } from '../features/ad-banner/ad-notification.component';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [RouterOutlet, RouterLink, AuthModalComponent, AdBannerComponent, AdNotificationComponent],
  templateUrl: './layout.component.html',
  styleUrl: './layout.component.scss',
})
export class LayoutComponent {
  readonly i18n         = inject(I18nService);
  readonly authService  = inject(AuthService);
  private  router       = inject(Router);
  readonly cfg          = inject(AppConfigService);
  readonly api          = inject(ApiService);
  readonly dropOpen     = signal(false);
  readonly showAuth     = signal(false);
  readonly userMenuOpen = signal(false);

  setLang(code: Lang): void {
    this.i18n.setLang(code);
    this.dropOpen.set(false);
  }

  toggleDrop(): void     { this.dropOpen.update(v => !v); this.userMenuOpen.set(false); }
  closeDrop(): void      { this.dropOpen.set(false); }
  openAuth(): void       { this.showAuth.set(true);  this.userMenuOpen.set(false); }
  closeAuth(): void      { this.showAuth.set(false); }
  toggleUserMenu(): void { this.userMenuOpen.update(v => !v); this.dropOpen.set(false); }
  closeUserMenu(): void  { this.userMenuOpen.set(false); }

  goToProfile(): void  { this.router.navigate(['/profile']); this.userMenuOpen.set(false); }
  goToBookings(): void { this.router.navigate(['/profile'], { queryParams: { tab: 'bookings' } }); this.userMenuOpen.set(false); }

  logout(): void {
    this.authService.logout();
    this.userMenuOpen.set(false);
  }

  get currentMeta() {
    const langs = this.i18n.langs();
    return langs.find(l => l.code === this.i18n.lang()) ?? langs[0];
  }

  getInitials(): string {
    const u = this.authService.currentUser();
    if (!u) return '';
    return (u.firstName[0] ?? '') + (u.lastName[0] ?? '');
  }
}
