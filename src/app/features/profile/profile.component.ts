import { MoneyPipe, AppDatePipe } from '../../core/pipes/format.pipes';
import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { UserService } from '../../core/services/user.service';
import { I18nService } from '../../core/services/i18n.service';
import { UserProfile, SavedBooking } from '../../core/models/user.models';

type ProfileTab = 'profile' | 'bookings';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [MoneyPipe, AppDatePipe, FormsModule],
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss',
})
export class ProfileComponent implements OnInit {
  private authService  = inject(AuthService);
  private userService  = inject(UserService);
  readonly router      = inject(Router);
  private route        = inject(ActivatedRoute);
  readonly i18n        = inject(I18nService);

  readonly currentUser    = this.authService.currentUser;
  readonly myBookings     = this.userService.myBookings;
  readonly upcomingCount  = computed(() => this.userService.upcomingBookings().length);
  readonly pastCount      = computed(() => this.userService.pastBookings().length);

  readonly tab            = signal<ProfileTab>('profile');
  readonly bookingFilter  = signal<'all' | 'upcoming' | 'past'>('all');
  readonly isSaving       = signal(false);
  readonly saveSuccess    = signal(false);
  readonly expandedBooking = signal<string | null>(null);
  readonly confirmCancel  = signal<string | null>(null);
  readonly profileError   = signal<string | null>(null);
  readonly cancelError    = signal<string | null>(null);
  readonly loadingBookings = this.userService.loading;
  readonly hasMore        = this.userService.hasMore;

  // ── Formulaire profil ────────────────────────────────────────────────────
  firstName = ''; lastName = ''; email = ''; phone = ''; gender = '';
  currentPassword = ''; newPassword = ''; confirmPassword = '';
  passwordError   = '';
  passwordSuccess = false;
  showCurrentPwd  = false; showNewPwd = false;

  ngOnInit(): void {
    if (!this.authService.isLoggedIn()) {
      this.router.navigate(['/']); return;
    }
    this.loadProfileForm();
    void this.userService.loadBookings();

    // Lire le tab depuis query params
    this.route.queryParams.subscribe(params => {
      if (params['tab'] === 'bookings') this.tab.set('bookings');
    });
  }

  private loadProfileForm(): void {
    const u = this.currentUser()!;
    this.firstName = u.firstName;
    this.lastName  = u.lastName;
    this.email     = u.email;
    this.phone     = u.phone || '';
    this.gender    = u.gender || '';
  }

  // ── Onglets ───────────────────────────────────────────────────────────────
  setTab(t: ProfileTab): void { this.tab.set(t); }

  // ── Sauvegarde profil ─────────────────────────────────────────────────────
  async saveProfile(): Promise<void> {
    if (!this.firstName.trim() || !this.lastName.trim()) return;
    this.isSaving.set(true); this.profileError.set(null);
    const ok = await this.authService.updateProfile({ firstName: this.firstName.trim(), lastName: this.lastName.trim(), phone: this.phone.trim(), gender: this.gender });
    this.isSaving.set(false);
    if (!ok) { this.profileError.set(this.authService.getErrorMessage(this.authService.authError(), this.i18n.lang())); return; }
    this.saveSuccess.set(true);
    setTimeout(() => this.saveSuccess.set(false), 3000);
  }

  // ── Changement de mot de passe ────────────────────────────────────────────
  async changePassword(): Promise<void> {
    this.passwordError   = '';
    this.passwordSuccess = false;
    const t = this.i18n.t().profile;
    if (!this.currentPassword) { this.passwordError = t.currentPassword + ' requis'; return; }
    if (this.newPassword.length < 10) { this.passwordError = this.i18n.t().x.passwordRule; return; }
    if (this.newPassword !== this.confirmPassword) { this.passwordError = this.i18n.t().x.passwordMismatch; return; }

    this.isSaving.set(true);
    const ok = await this.authService.changePassword(this.currentPassword, this.newPassword);
    this.isSaving.set(false);

    if (!ok) {
      this.passwordError = this.authService.authError() === 'weak_password' ? this.i18n.t().x.passwordRule : this.i18n.t().x.passwordWrong;
      return;
    }
    this.currentPassword = ''; this.newPassword = ''; this.confirmPassword = '';
    this.passwordSuccess = true;
    setTimeout(() => this.passwordSuccess = false, 3000);
  }

  // ── Réservations ──────────────────────────────────────────────────────────
  get filteredBookings(): SavedBooking[] {
    const f = this.bookingFilter();
    if (f === 'upcoming') return this.userService.upcomingBookings();
    if (f === 'past')     return this.userService.pastBookings();
    return [...this.myBookings()].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  bookingFilters() {
    const t = this.i18n.t().profile;
    return [
      { v: 'all',      l: t.filterAll,      c: this.myBookings().length },
      { v: 'upcoming', l: t.filterUpcoming,  c: this.upcomingCount() },
      { v: 'past',     l: t.filterPast,      c: this.pastCount() },
    ];
  }

  setBookingFilter(v: string): void {
    this.bookingFilter.set(v as 'all' | 'upcoming' | 'past');
  }

  toggleBooking(id: string): void {
    this.expandedBooking.update(cur => cur === id ? null : id);
  }

  askCancel(id: string): void   { this.confirmCancel.set(id); }
  dismissCancel(): void         { this.confirmCancel.set(null); }
  async confirmCancelBooking(): Promise<void> {
    const id = this.confirmCancel();
    if (!id) return;
    this.cancelError.set(await this.userService.cancelBooking(id));
    this.confirmCancel.set(null);
  }
  loadMore(): void { void this.userService.loadMore(); }
  openTicket(b: SavedBooking): void { this.router.navigate(['/booking', b.reference], { queryParams: b.accessToken ? { t: b.accessToken } : {} }); }

  // ── Helpers UI ────────────────────────────────────────────────────────────
  getInitials(): string {
    const u = this.currentUser();
    return u ? (u.firstName[0] ?? '') + (u.lastName[0] ?? '') : '';
  }

  getStatusBadge(status: SavedBooking['status']): string {
    if (status === 'confirmed') return 'bg-green-100 text-green-700 border-green-200';
    if (status === 'cancelled' || status === 'expired') return 'bg-red-100 text-red-700 border-red-200';
    if (status === 'pending') return 'bg-amber-100 text-amber-800 border-amber-200';
    return 'bg-slate-100 text-slate-600 border-slate-200';
  }

  getStatusLabel(status: SavedBooking['status']): string {
    const t = this.i18n.t().profile;
    if (status === 'confirmed') return t.statusConfirmed;
    if (status === 'cancelled') return t.statusCancelled;
    if (status === 'pending') return this.i18n.t().x.stPending;
    if (status === 'expired') return this.i18n.t().x.stExpired;
    return t.statusCompleted;
  }

  formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString('fr-MG', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  formatDateTime(iso: string): string {
    return new Date(iso).toLocaleDateString('fr-MG', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  logout(): void {
    this.authService.logout();
    this.userService.clearBookings();
    this.router.navigate(['/']);
  }

}
