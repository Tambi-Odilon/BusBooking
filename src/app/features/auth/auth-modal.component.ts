import { Component, inject, output, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/services/auth.service';
import { I18nService } from '../../core/services/i18n.service';
import { SignupData } from '../../core/models/user.models';
import { AppConfigService } from '../../core/config/app-config.service';

type AuthTab = 'login' | 'signup' | 'forgot';

@Component({
  selector: 'app-auth-modal',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './auth-modal.component.html',
  styleUrl: './auth-modal.component.scss',
})
export class AuthModalComponent {
  private authService = inject(AuthService);
  readonly i18n       = inject(I18nService);
  readonly cfg        = inject(AppConfigService);
  /** Étape « code de double authentification » après un mot de passe correct. */
  readonly challenge  = this.authService.twoFactorChallenge;
  readonly forgotSent = signal(false);
  twoFactorCode = '';
  forgotEmail   = '';

  // Événement émis vers le parent pour fermer la modal
  readonly closed = output<void>();

  readonly authService$ = this.authService;
  readonly tab          = signal<AuthTab>('login');
  readonly showPassword = signal(false);
  readonly isLoading    = this.authService.isLoading;
  readonly authError    = this.authService.authError;

  readonly errorMessage = computed(() =>
    this.authService.getErrorMessage(this.authError(), this.i18n.lang())
  );

  // ── Login form ────────────────────────────────────────────────────────────
  loginEmail    = '';
  loginPassword = '';

  // ── Signup form ───────────────────────────────────────────────────────────
  signupEmail     = '';
  signupPassword  = '';
  signupFirstName = '';
  signupLastName  = '';
  signupPhone     = '';
  signupGender    = '';

  setTab(tab: AuthTab): void {
    this.tab.set(tab);
    this.forgotSent.set(false);
    if (tab === 'forgot') this.forgotEmail = this.loginEmail;
    this.authService.clearError();
  }

  togglePassword(): void { this.showPassword.update(v => !v); }

  close(): void {
    this.authService.clearError();
    this.closed.emit();
  }

  isLoginValid(): boolean {
    return !!this.loginEmail.trim() && !!this.loginPassword;
  }

  isSignupValid(): boolean {
    return (
      !!this.signupEmail.trim() &&
      !!this.signupPassword &&
      !!this.signupFirstName.trim() &&
      !!this.signupLastName.trim()
    );
  }

  async submitLogin(): Promise<void> {
    if (!this.isLoginValid() || this.isLoading()) return;
    const ok = await this.authService.login({
      email:    this.loginEmail,
      password: this.loginPassword,
    });
    if (ok) this.close();
  }

  async submitSignup(): Promise<void> {
    if (!this.isSignupValid() || this.isLoading()) return;
    const data: SignupData = {
      email:     this.signupEmail,
      password:  this.signupPassword,
      firstName: this.signupFirstName,
      lastName:  this.signupLastName,
      phone:     this.signupPhone,
      gender:    this.signupGender,
    };
    const ok = await this.authService.signup(data);
    if (ok) this.close();
  }

  async submitTwoFactor(): Promise<void> {
    if (this.twoFactorCode.trim().length < 6 || this.isLoading()) return;
    if (await this.authService.verifyTwoFactor(this.twoFactorCode)) this.close();
  }

  async submitForgot(): Promise<void> {
    if (!this.forgotEmail.trim() || this.isLoading()) return;
    await this.authService.forgotPassword(this.forgotEmail, this.i18n.lang());
    this.forgotSent.set(true);
  }
}
