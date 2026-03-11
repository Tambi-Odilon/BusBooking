import { Component, inject, OnInit, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { Router, ActivatedRoute } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { UserService } from '../../core/services/user.service';
import { I18nService } from '../../core/services/i18n.service';
import { UserProfile, SavedBooking } from '../../core/models/user.models';

type ProfileTab = 'profile' | 'bookings';

@Component({
  selector: 'app-profile',
  standalone: true,
  imports: [FormsModule, DecimalPipe],
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

  // ── Formulaire profil ────────────────────────────────────────────────────
  firstName = ''; lastName = ''; email = ''; phone = ''; gender = ''; age = 0;
  currentPassword = ''; newPassword = ''; confirmPassword = '';
  passwordError   = '';
  passwordSuccess = false;
  showCurrentPwd  = false; showNewPwd = false;

  ngOnInit(): void {
    if (!this.authService.isLoggedIn()) {
      this.router.navigate(['/']); return;
    }
    this.loadProfileForm();
    this.userService.loadBookings(this.currentUser()!.id);

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
    this.age       = u.age || 0;
  }

  // ── Onglets ───────────────────────────────────────────────────────────────
  setTab(t: ProfileTab): void { this.tab.set(t); }

  // ── Sauvegarde profil ─────────────────────────────────────────────────────
  async saveProfile(): Promise<void> {
    if (!this.firstName.trim() || !this.lastName.trim()) return;
    this.isSaving.set(true);
    await this.delay(600);
    this.authService.updateProfile({
      firstName: this.firstName.trim(),
      lastName:  this.lastName.trim(),
      phone:     this.phone.trim(),
      gender:    this.gender,
      age:       this.age,
    });
    this.isSaving.set(false);
    this.saveSuccess.set(true);
    setTimeout(() => this.saveSuccess.set(false), 3000);
  }

  // ── Changement de mot de passe ────────────────────────────────────────────
  async changePassword(): Promise<void> {
    this.passwordError   = '';
    this.passwordSuccess = false;
    if (!this.currentPassword) { this.passwordError = 'Entrez votre mot de passe actuel'; return; }
    if (this.newPassword.length < 6) { this.passwordError = 'Le nouveau mot de passe doit contenir au moins 6 caractères'; return; }
    if (this.newPassword !== this.confirmPassword) { this.passwordError = 'Les mots de passe ne correspondent pas'; return; }

    this.isSaving.set(true);
    await this.delay(500);
    const ok = await this.authService.changePassword(this.currentPassword, this.newPassword);
    this.isSaving.set(false);

    if (!ok) {
      this.passwordError = 'Mot de passe actuel incorrect';
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

  toggleBooking(id: string): void {
    this.expandedBooking.update(cur => cur === id ? null : id);
  }

  askCancel(id: string): void   { this.confirmCancel.set(id); }
  dismissCancel(): void         { this.confirmCancel.set(null); }
  confirmCancelBooking(): void  {
    const id = this.confirmCancel();
    if (id) { this.userService.cancelBooking(id); this.confirmCancel.set(null); }
  }

  // ── Helpers UI ────────────────────────────────────────────────────────────
  getInitials(): string {
    const u = this.currentUser();
    return u ? (u.firstName[0] ?? '') + (u.lastName[0] ?? '') : '';
  }

  getStatusBadge(status: SavedBooking['status']): string {
    if (status === 'confirmed') return 'bg-green-100 text-green-700 border-green-200';
    if (status === 'cancelled') return 'bg-red-100 text-red-700 border-red-200';
    return 'bg-slate-100 text-slate-600 border-slate-200';
  }

  getStatusLabel(status: SavedBooking['status']): string {
    if (status === 'confirmed') return '✅ Confirmée';
    if (status === 'cancelled') return '❌ Annulée';
    return '✔ Terminée';
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

  private delay(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
}
