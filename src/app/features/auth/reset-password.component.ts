import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { I18nService } from '../../core/services/i18n.service';
import { AppConfigService } from '../../core/config/app-config.service';
import { ApiService, errorMessage } from '../../core/api/api.service';

/** Choix d'un nouveau mot de passe à partir du lien reçu par e-mail (clients et personnel ; sert aussi à activer un compte interne). */
@Component({
  selector: 'app-reset-password',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
  <div class="min-h-screen bg-slate-50 flex items-center justify-center p-4">
    <div class="w-full max-w-md bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-8">
      <p class="text-sm font-semibold text-blue-700">{{ cfg.name() }}</p>
      <h1 class="text-2xl font-bold font-display text-slate-900 mt-1">{{ t().x.resetTitle }}</h1>
      @if (done()) {
        <p role="status" class="mt-6 text-sm text-green-800 bg-green-50 border border-green-200 rounded-xl px-4 py-3">{{ t().x.resetDone }}</p>
        <a [routerLink]="staff ? '/admin/login' : '/'" class="mt-4 block text-center h-12 leading-[3rem] rounded-xl bg-blue-600 text-white font-semibold">{{ staff ? 'Connexion' : t().x.home }}</a>
      } @else if (!token) {
        <p role="alert" class="mt-6 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{{ t().x.resetInvalid }}</p>
      } @else {
        <form (ngSubmit)="submit()" class="mt-6 space-y-4">
          <div>
            <label for="pwd" class="block text-sm font-medium text-slate-700 mb-1.5">{{ t().x.resetNew }}</label>
            <input id="pwd" name="pwd" [type]="show() ? 'text' : 'password'" [(ngModel)]="password" autocomplete="new-password" minlength="10"
                   class="w-full h-12 px-4 rounded-xl border border-slate-200 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            <p class="text-xs text-slate-500 mt-1.5">{{ t().x.passwordRule }}</p>
          </div>
          <div>
            <label for="pwd2" class="block text-sm font-medium text-slate-700 mb-1.5">{{ t().profile.confirmPassword }}</label>
            <input id="pwd2" name="pwd2" [type]="show() ? 'text' : 'password'" [(ngModel)]="confirm" autocomplete="new-password"
                   class="w-full h-12 px-4 rounded-xl border border-slate-200 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <label class="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" [checked]="show()" (change)="show.set(!show())" class="w-4 h-4" /> Afficher</label>
          @if (error()) { <p role="alert" class="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">{{ error() }}</p> }
          <button type="submit" [disabled]="busy()" class="w-full h-12 rounded-xl bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold">{{ t().x.resetBtn }}</button>
        </form>
      }
    </div>
  </div>`,
})
export class ResetPasswordComponent {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  readonly cfg = inject(AppConfigService);
  readonly t = inject(I18nService).t;
  readonly token = this.route.snapshot.queryParamMap.get('token') || '';
  readonly staff = this.route.snapshot.data['scope'] === 'staff';
  password = ''; confirm = '';
  readonly show = signal(false);
  readonly busy = signal(false);
  readonly done = signal(false);
  readonly error = signal<string | null>(null);

  async submit(): Promise<void> {
    if (this.password !== this.confirm) { this.error.set(this.t().x.passwordMismatch); return; }
    this.busy.set(true); this.error.set(null);
    try { await this.api.post('/auth/reset-password', { token: this.token, password: this.password }, { scope: 'none' }); this.done.set(true); }
    catch (e) { this.error.set(errorMessage(e, this.t().x.resetInvalid)); }
    finally { this.busy.set(false); }
  }
}
