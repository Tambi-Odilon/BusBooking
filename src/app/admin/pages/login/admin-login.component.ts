import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminSession } from '../../services/admin-session.service';
import { adminHome } from '../../guards/admin-auth.guard';
import { AppConfigService } from '../../../core/config/app-config.service';

/** Connexion du personnel : mot de passe, puis code de double authentification si le compte l'a activée. */
@Component({
  selector: 'app-admin-login',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './admin-login.component.html',
  styleUrl: './admin-login.component.scss',
})
export class AdminLoginComponent {
  private auth    = inject(AdminAuthService);
  private session = inject(AdminSession);
  private router  = inject(Router);
  readonly cfg    = inject(AppConfigService);

  email    = '';
  password = '';
  code     = '';
  showPwd  = signal(false);
  /** 'login' : identifiants · 'forgot' : demande de lien · 'sent' : confirmation neutre */
  mode     = signal<'login' | 'forgot' | 'sent'>('login');

  readonly isLoading  = this.auth.isLoading;
  readonly loginError = this.auth.loginError;
  readonly challenge  = this.auth.twoFactorChallenge;

  readonly features = [
    'Sièges et ventes en temps réel',
    'Vente au guichet et contrôle des billets',
    'Voyages, flotte et chauffeurs',
    'Finances et remboursements',
    'Rôles et permissions par compte',
    'Journal d\'activité inaltérable',
  ];

  async submit(): Promise<void> {
    if (!this.email || !this.password) return;
    if (await this.auth.login(this.email, this.password)) this.enter();
  }
  async submitCode(): Promise<void> {
    if (this.code.replace(/\s/g, '').length < 6) return;
    if (await this.auth.verifyTwoFactor(this.code)) this.enter();
    else this.code = '';
  }
  cancelCode(): void { this.auth.cancelTwoFactor(); this.code = ''; this.password = ''; }
  private enter(): void {
    this.password = ''; this.code = '';
    // le rôle impose la double authentification : on mène directement à son activation
    if (this.auth.mustEnable2fa()) void this.router.navigate(['/admin/profile'], { queryParams: { tab: 'security' } });
    else void this.router.navigateByUrl(adminHome(this.session, this.router));
  }
  async sendReset(): Promise<void> {
    if (!this.email.includes('@')) return;
    await this.auth.forgotPassword(this.email);
    this.mode.set('sent');
  }
}
