import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminDriversService } from '../../services/admin-drivers.service';
import { AdminFleetService } from '../../services/admin-fleet.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminAuditService } from '../../services/admin-audit.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { StatCardComponent } from '../../components/admin-shared.component';
import { ExpiringDriversPipe, FindBusPipe } from '../../pipes/admin.pipes';
import { AdminDriver, DriverStatus, LicenseClass } from '../../models/admin.models';

type ModalMode = 'add' | 'edit' | 'status' | 'bus' | null;

const LICENSE_CLASSES: LicenseClass[] = ['B', 'C', 'D', 'E'];

@Component({
  selector: 'app-drivers',
  standalone: true,
  imports: [CommonModule, FormsModule, StatCardComponent, ExpiringDriversPipe, FindBusPipe],
  templateUrl: './drivers.component.html',
})
export class DriversComponent {
  readonly driverSvc = inject(AdminDriversService);
  readonly fleetSvc  = inject(AdminFleetService);
  readonly auth      = inject(AdminAuthService);
  readonly toast     = inject(AdminToastService);
  readonly audit = inject(AdminAuditService);

  readonly licenseClasses = LICENSE_CLASSES;
  /** Comptes internes pouvant être reliés à une fiche chauffeur (ceux qui ont le droit de voir leur propre planning). */
  accountChoices() { return this.auth.admins().filter(a => this.auth.getRoleLabel(a.role) && (a.role === 'chauffeur' || a.id === this.form.userId)); }

  // ── Filtres ───────────────────────────────────────────────────────────────
  filterStatus  = signal<'all' | DriverStatus>('all');
  filterBus     = signal<'all' | 'assigned' | 'unassigned'>('all');
  search        = signal('');

  readonly filtered = computed(() => {
    const st = this.filterStatus();
    const bs = this.filterBus();
    const q  = this.search().toLowerCase();
    return this.driverSvc.drivers().filter(d => {
      if (st !== 'all' && d.status !== st) return false;
      if (bs === 'assigned'   && !d.assignedBusId) return false;
      if (bs === 'unassigned' && d.assignedBusId)  return false;
      if (q && !`${d.firstName} ${d.lastName} ${d.phone} ${d.licenseNumber}`.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  // ── Sélection ─────────────────────────────────────────────────────────────
  selected = signal<AdminDriver | null>(null);
  select(d: AdminDriver): void {
    this.selected.set(this.selected()?.id === d.id ? null : d);
    this.modal.set(null);
  }

  // ── Modal ─────────────────────────────────────────────────────────────────
  modal       = signal<ModalMode>(null);
  modalDriver = signal<AdminDriver | null>(null);

  form = {
    firstName: '', lastName: '', phone: '', email: '',
    licenseNumber: '', licenseClass: 'D' as LicenseClass,
    licenseExpiry: '', birthDate: '', address: '', notes: '',
    assignedBusId: '' as string | undefined, userId: '',
  };

  statusForm = {
    status: 'active' as DriverStatus,
    leaveUntil: '', leaveReason: '', notes: '',
  };

  selectedBusId: string | null = null;

  openAdd(): void {
    this.form = {
      firstName:'', lastName:'', phone:'', email:'',
      licenseNumber:'', licenseClass:'D',
      licenseExpiry:'', birthDate:'', address:'', notes:'',
      assignedBusId: undefined, userId: '',
    };
    this.modalDriver.set(null);
    this.modal.set('add');
  }

  openEdit(d: AdminDriver, e: Event): void {
    e.stopPropagation();
    this.form = {
      firstName: d.firstName, lastName: d.lastName, phone: d.phone,
      email: d.email ?? '', licenseNumber: d.licenseNumber,
      licenseClass: d.licenseClass, licenseExpiry: d.licenseExpiry,
      birthDate: d.birthDate, address: d.address ?? '', notes: d.notes ?? '',
      assignedBusId: d.assignedBusId, userId: d.userId ?? '',
    };
    this.modalDriver.set(d);
    this.modal.set('edit');
  }

  openStatus(d: AdminDriver, e: Event): void {
    e.stopPropagation();
    this.statusForm = {
      status: d.status, leaveUntil: d.leaveUntil ?? '',
      leaveReason: d.leaveReason ?? '', notes: d.notes ?? '',
    };
    this.modalDriver.set(d);
    this.modal.set('status');
  }

  openBus(d: AdminDriver, e: Event): void {
    e.stopPropagation();
    this.selectedBusId = d.assignedBusId ?? null;
    this.modalDriver.set(d);
    this.modal.set('bus');
  }

  closeModal(): void { this.modal.set(null); this.modalDriver.set(null); }

  // ── Soumissions ───────────────────────────────────────────────────────────
  submitForm(): void {
    const f = this.form;
    if (!f.firstName.trim() || !f.lastName.trim()) { this.toast.error('Prénom et nom obligatoires'); return; }
    if (!f.phone.trim())          { this.toast.error('Téléphone obligatoire'); return; }
    if (!f.licenseNumber.trim())  { this.toast.error('Numéro de permis obligatoire'); return; }
    if (!f.licenseExpiry)         { this.toast.error('Date d\'expiration du permis obligatoire'); return; }
    if (!f.birthDate)             { this.toast.error('Date de naissance obligatoire'); return; }

    if (this.modal() === 'add') {
      const d = this.driverSvc.add({
        firstName: f.firstName.trim(), lastName: f.lastName.trim().toUpperCase(),
        phone: f.phone, email: f.email || undefined,
        licenseNumber: f.licenseNumber.toUpperCase(), licenseClass: f.licenseClass,
        licenseExpiry: f.licenseExpiry, birthDate: f.birthDate,
        address: f.address || undefined, notes: f.notes || undefined, userId: f.userId || undefined,
        status: 'active',
        assignedBusId: f.assignedBusId || undefined,
        hiredAt: new Date().toISOString().split('T')[0],
      });
      this.toast.success(`${this.driverSvc.fullName(d)} ajouté`);
      this.audit.log(this.auth.currentAdmin()!.id,'fleet','Chauffeur ajouté',{severity:'success',targetId:d.id,targetName:this.driverSvc.fullName(d),details:'Permis : '+d.licenseNumber});
    } else {
      const d = this.modalDriver()!;
      this.driverSvc.update(d.id, {
        firstName: f.firstName.trim(), lastName: f.lastName.trim().toUpperCase(),
        phone: f.phone, email: f.email || undefined,
        licenseNumber: f.licenseNumber.toUpperCase(), licenseClass: f.licenseClass,
        licenseExpiry: f.licenseExpiry, birthDate: f.birthDate,
        address: f.address || undefined, notes: f.notes || undefined, userId: f.userId,
      });
      this.toast.success('Chauffeur mis à jour');
      this.audit.log(this.auth.currentAdmin()!.id,'fleet','Chauffeur modifié',{severity:'info',targetId:d.id,targetName:this.driverSvc.fullName(d)});
      this.selected.update(s => s?.id === d.id ? { ...s, ...f } : s);
    }
    this.closeModal();
  }

  submitStatus(): void {
    const d = this.modalDriver()!;
    const f = this.statusForm;
    if (f.status === 'leave' && !f.leaveReason.trim()) { this.toast.error('Raison du congé obligatoire'); return; }
    this.driverSvc.setStatus(d.id, f.status, {
      leaveUntil: f.leaveUntil || undefined,
      leaveReason: f.leaveReason || undefined,
      notes: f.notes || undefined,
    });
    const labels: Record<DriverStatus, string> = {
      active:'En service', leave:'En congé', suspended:'Suspendu', resigned:'Démissionnaire',
    };
    this.toast.success(`${this.driverSvc.fullName(d)} → ${labels[f.status]}`);
    this.audit.log(this.auth.currentAdmin()!.id,'fleet','Statut chauffeur modifié',{severity:'warning',targetId:d.id,targetName:this.driverSvc.fullName(d),details:'Statut : '+f.status});
    this.selected.update(s => s?.id === d.id ? { ...s, status: f.status } : s);
    this.closeModal();
  }

  submitBus(): void {
    const d = this.modalDriver()!;
    this.driverSvc.assignBus(d.id, this.selectedBusId);
    const bus = this.selectedBusId ? this.fleetSvc.buses().find(b => b.id === this.selectedBusId) : null;
    this.toast.success(bus ? `${this.driverSvc.fullName(d)} assigné à ${bus.name}` : `${this.driverSvc.fullName(d)} désassigné`);
    this.audit.log(this.auth.currentAdmin()!.id,'fleet',bus?'Chauffeur assigné à véhicule':'Chauffeur désassigné',{severity:'info',targetId:d.id,targetName:this.driverSvc.fullName(d),details:bus?bus.name:'Aucun véhicule'});
    this.selected.update(s => s?.id === d.id ? { ...s, assignedBusId: this.selectedBusId ?? undefined } : s);
    this.closeModal();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  age(birthDate: string): number {
    return Math.floor((Date.now() - new Date(birthDate).getTime()) / (365.25 * 86400000));
  }

  seniority(hiredAt: string): string {
    const months = Math.floor((Date.now() - new Date(hiredAt).getTime()) / (30.44 * 86400000));
    if (months < 12) return `${months} mois`;
    const y = Math.floor(months / 12); const m = months % 12;
    return m ? `${y}a ${m}m` : `${y} an${y > 1 ? 's' : ''}`;
  }

  licenseExpiryColor(d: AdminDriver): string {
    if (this.driverSvc.isLicenseExpired(d))      return 'var(--a-red)';
    if (this.driverSvc.isLicenseExpiringSoon(d)) return 'var(--a-amber)';
    return 'var(--a-green)';
  }

  statusBg(s: DriverStatus): string {
    return s==='active' ? 'rgba(16,185,129,.1)' : s==='leave' ? 'rgba(6,182,212,.1)' :
           s==='suspended' ? 'rgba(245,158,11,.1)' : 'rgba(239,68,68,.1)';
  }
  statusColor(s: DriverStatus): string {
    return s==='active' ? 'var(--a-green)' : s==='leave' ? 'var(--a-cyan)' :
           s==='suspended' ? 'var(--a-amber)' : 'var(--a-red)';
  }
  statusLabel(s: DriverStatus): string {
    return s==='active' ? 'En service' : s==='leave' ? 'En congé' :
           s==='suspended' ? 'Suspendu' : 'Démissionnaire';
  }

  busName(busId?: string): string {
    return busId ? (this.fleetSvc.buses().find(b => b.id === busId)?.name ?? '—') : '—';
  }

  busRef(busId?: string): string {
    return busId ? (this.fleetSvc.buses().find(b => b.id === busId)?.ref ?? '') : '';
  }

  busIcon(busId?: string): string {
    const b = busId ? this.fleetSvc.buses().find(x => x.id === busId) : null;
    if (!b) return '';
    return b.vehicleLayout === 'bus' ? '🚌' : b.vehicleLayout === 'minibus16' ? '🚐' : '⭐';
  }

  isAvailableForBus(busId: string, currentDriverId: string): boolean {
    const other = this.driverSvc.driverOfBus(busId);
    return !other || other.id === currentDriverId;
  }

  ratingStars(rating: number): string {
    const full = Math.floor(rating);
    const half = rating - full >= 0.5;
    return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(5 - full - (half ? 1 : 0));
  }

  readonly minDate = new Date().toISOString().split('T')[0];

  clearFilters(): void {
    this.filterStatus.set('all'); this.filterBus.set('all'); this.search.set('');
    this.selected.set(null);
  }
  hasFilters(): boolean {
    return this.filterStatus() !== 'all' || this.filterBus() !== 'all' || this.search() !== '';
  }
}
