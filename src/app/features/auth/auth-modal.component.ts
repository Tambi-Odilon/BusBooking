import { Component, inject, output, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../../core/services/auth.service';
import { I18nService } from '../../core/services/i18n.service';
import { SignupData } from '../../core/models/user.models';

type AuthTab = 'login' | 'signup';

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

  // Événement émis vers le parent pour fermer la modal
  readonly closed = output<void>();

  readonly authService$ = this.authService;
  readonly tab          = signal<AuthTab>('login');
  readonly showPassword = signal(false);
  readonly isLoading    = this.authService.isLoading;
  readonly authError    = this.authService.authError;

  readonly errorMessage = computed(() =>
    this.authService.getErrorMessage(this.authError())
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
  signupAge       = 0;

  setTab(tab: AuthTab): void {
    this.tab.set(tab);
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
      age:       this.signupAge,
    };
    const ok = await this.authService.signup(data);
    if (ok) this.close();
  }
}
