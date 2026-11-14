import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AdminDataService } from '../../services/admin-data.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminEmailService } from '../../services/admin-email.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { AriaryPipe } from '../../pipes/admin.pipes';
import { AdminBooking, AdminClientUser } from '../../models/admin.models';
import { ApiService } from '../../../core/api/api.service';

@Component({
  selector: 'app-client-detail',
  standalone: true,
  imports: [CommonModule, FormsModule, DatePipe, AriaryPipe, RouterLink],
  templateUrl: './client-detail.component.html',
})
export class ClientDetailComponent implements OnInit {
  private route  = inject(ActivatedRoute);
  private router = inject(Router);
  readonly data  = inject(AdminDataService);
  readonly auth  = inject(AdminAuthService);
  readonly email = inject(AdminEmailService);
  readonly toast = inject(AdminToastService);
  private api    = inject(ApiService);
  readonly loading = signal(true);

  userId = '';
  activeTab = signal<'info' | 'bookings' | 'emails'>('info');
  editMode  = signal(false);

  editForm = {
    firstName: '', lastName: '', email: '', phone: '', notes: '',
    status: 'active' as AdminClientUser['status'],
  };
  statusReason = '';

  // La fiche est chargée depuis le serveur (la liste des clients est paginée : elle ne contient pas forcément ce client).
  readonly user = signal<AdminClientUser | null>(null);
  readonly bookings = signal<AdminBooking[]>([]);
  readonly userEmails = computed(() => { const u = this.user(); return u ? this.email.forRecipient(u.email, u.phone) : []; });

  readonly stats = computed(() => {
    const bk = this.bookings();
    return {
      total:     bk.length,
      confirmed: bk.filter(b => b.status === 'confirmed').length,
      cancelled: bk.filter(b => b.status === 'cancelled').length,
      pending:   bk.filter(b => b.status === 'pending').length,
      spent:     bk.filter(b => b.status === 'confirmed').reduce((s, b) => s + b.totalAmount, 0),
    };
  });

  ngOnInit(): void {
    this.userId = this.route.snapshot.paramMap.get('id') ?? '';
    void this.reload(true);
  }
  private async reload(first = false): Promise<void> {
    const r = await this.data.client(this.userId);
    this.loading.set(false);
    if (!r) { if (first) { this.toast.error('Client introuvable'); this.router.navigate(['/admin/users']); } return; }
    this.user.set(r.client);
    this.bookings.set(r.bookings.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
    if (first) this.initForm(r.client);
  }

  initForm(u: AdminClientUser): void {
    this.editForm = {
      firstName: u.firstName, lastName: u.lastName,
      email: u.email, phone: u.phone, notes: u.notes ?? '',
      status: u.status,
    };
  }

  toggleEdit(): void {
    const u = this.user();
    if (u) this.initForm(u);
    this.editMode.update(v => !v);
    this.statusReason = '';
  }

  saveInfo(): void {
    const u = this.user()!;
    const f = this.editForm;
    if (!f.firstName || !f.lastName || !f.email || !f.phone) {
      this.toast.error('Champs obligatoires manquants'); return;
    }

    const statusChanged = f.status !== u.status;
    this.data.updateUser(u.id, {
      firstName: f.firstName.trim(),
      lastName:  f.lastName.trim().toUpperCase(),
      email:     f.email.trim(),
      phone:     f.phone.trim(),
      notes:     f.notes.trim() || undefined,
      status:    f.status,
    });

    this.user.set({ ...u, firstName: f.firstName.trim(), lastName: f.lastName.trim().toUpperCase(), email: f.email.trim(), phone: f.phone.trim(), notes: f.notes.trim() || undefined, status: f.status });
    this.toast.success(statusChanged ? 'Statut mis à jour' : 'Informations mises à jour');
    setTimeout(() => void this.reload(), 600);
    this.editMode.set(false);
  }

  async sendResetEmail(): Promise<void> {
    const u = this.user()!;
    if (!u.email) { this.toast.error('Ce client n\'a pas d\'adresse e-mail'); return; }
    try {
      await this.api.post('/auth/forgot-password', { email: u.email, scope: 'customer', lang: 'fr' }, { scope: 'none' });
      this.toast.success(`Lien de réinitialisation envoyé à ${u.email}`);
    } catch { this.toast.error('Envoi impossible pour le moment'); }
  }

  goBack(): void { this.router.navigate(['/admin/users']); }

  csColor(s: string): string { return s==='active'?'var(--a-green)':s==='suspended'?'var(--a-amber)':'var(--a-red)'; }
  csBg(s: string):    string { return s==='active'?'rgba(16,185,129,.1)':s==='suspended'?'rgba(245,158,11,.1)':'rgba(239,68,68,.1)'; }
  csLabel(s: string): string { return s==='active'?'Actif':s==='suspended'?'Suspendu':'Banni'; }
  initials(u: AdminClientUser): string { return (u.firstName[0]??'') + (u.lastName[0]??''); }

  bkColor(s: string): string {
    return s==='confirmed'?'var(--a-green)':s==='cancelled'?'var(--a-red)':'var(--a-amber)';
  }
  bkBg(s: string): string {
    return s==='confirmed'?'rgba(16,185,129,.1)':s==='cancelled'?'rgba(239,68,68,.1)':'rgba(245,158,11,.1)';
  }
  bkLabel(s: string): string {
    return s==='confirmed'?'Confirmée':s==='cancelled'?'Annulée':'En attente';
  }
  emailStatusLabel(st: string): string { return ({ sent: 'Envoyé', pending: 'En attente', failed: 'Échec', simulated: 'Simulé (aucun fournisseur configuré)' } as Record<string, string>)[st] ?? st; }
  emailTypeColor(st: string): string { return ({ sent: 'var(--a-green)', pending: 'var(--a-amber)', failed: 'var(--a-red)', simulated: 'var(--a-cyan)' } as Record<string, string>)[st] ?? 'var(--a-tx3)'; }
}
