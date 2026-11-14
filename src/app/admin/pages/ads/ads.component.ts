import { Component, inject, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { AdminAdsService } from '../../services/admin-ads.service';
import { AdminAuthService } from '../../services/admin-auth.service';
import { AdminAuditService } from '../../services/admin-audit.service';
import { AdminToastService } from '../../services/admin-toast.service';
import { AdminAd, AdPosition, AdStatus, AdDisplayType, AdNotifPosition } from '../../models/admin.models';
import { StatCardComponent } from '../../components/admin-shared.component';

type ModalMode = 'add' | 'edit' | 'delete' | 'preview' | null;

const PRESET_COLORS = [
  { bg:'#1e40af', text:'#ffffff', label:'Bleu' },
  { bg:'#7c3aed', text:'#ffffff', label:'Violet' },
  { bg:'#059669', text:'#ffffff', label:'Vert' },
  { bg:'#dc2626', text:'#ffffff', label:'Rouge' },
  { bg:'#d97706', text:'#ffffff', label:'Ambre' },
  { bg:'#0891b2', text:'#ffffff', label:'Cyan' },
  { bg:'#1e293b', text:'#ffffff', label:'Sombre' },
  { bg:'#f0fdf4', text:'#14532d', label:'Vert clair' },
  { bg:'#eff6ff', text:'#1e3a8a', label:'Bleu clair' },
  { bg:'#fef3c7', text:'#92400e', label:'Jaune clair' },
];

const PAGE_OPTIONS = [
  { value: '/',            label: 'Accueil / Recherche' },
  { value: '/buses',       label: 'Liste des bus' },
  { value: '/seats',       label: 'Sélection sièges' },
  { value: '/passengers',  label: 'Passagers' },
  { value: '/payment',     label: 'Paiement' },
  { value: '/confirmation', label: 'Confirmation' },
];

const POSITION_LABELS: Record<AdPosition, string> = {
  banner_top:       '📢 Bandeau haut de page',
  banner_bottom:    '📋 Bandeau bas de page',
  sidebar:          '◀ Colonne latérale',
  between_results:  '🔲 Entre les résultats',
  notification:     '🔔 Notification (coin bas-droite)',
};

function emptyForm() {
  const d = new Date(); d.setDate(d.getDate() + 30);
  return {
    title: '', description: '', imageUrl: '', imagePosition: 'left' as 'left'|'right'|'top'|'background', imageSize: 'medium' as 'small'|'medium'|'large', linkUrl: '', linkLabel: 'En savoir plus',
    bgColor: '#1e40af', textColor: '#ffffff',
    position: 'banner_top' as AdPosition,
    displayType: 'banner' as AdDisplayType,
    notifDuration: 5,
    carouselInterval: 5,
    notifPosition: 'bottom-right' as AdNotifPosition,
    pages: [] as string[],
    status: 'active' as AdStatus,
    startDate: new Date().toISOString().split('T')[0],
    endDate:   d.toISOString().split('T')[0],
    priority: 5,
  };
}

@Component({
  selector: 'app-ads',
  standalone: true,
  imports: [CommonModule, FormsModule, StatCardComponent],
  templateUrl: './ads.component.html',
})
export class AdsComponent {
  readonly adsSvc = inject(AdminAdsService);
  readonly auth   = inject(AdminAuthService);
  readonly toast  = inject(AdminToastService);
  readonly audit = inject(AdminAuditService);

  modal      = signal<ModalMode>(null);
  modalAd    = signal<AdminAd | null>(null);
  filterStatus = signal<'all' | AdStatus>('all');
  form = emptyForm();

  readonly presetColors  = PRESET_COLORS;
  readonly pageOptions   = PAGE_OPTIONS;
  readonly positionLabels = POSITION_LABELS;
  readonly positionKeys  = Object.keys(POSITION_LABELS) as AdPosition[];

  readonly filtered = computed(() => {
    const st = this.filterStatus();
    return this.adsSvc.ads().filter(a => st === 'all' || a.status === st);
  });

  openAdd(): void { this.form = emptyForm(); this.modalAd.set(null); this.modal.set('add'); }

  openEdit(ad: AdminAd): void {
    this.form = {
      title: ad.title, description: ad.description,
      imageUrl: ad.imageUrl ?? '', imagePosition: (ad.imagePosition ?? 'left') as 'left'|'right'|'top'|'background', imageSize: (ad.imageSize ?? 'medium') as 'small'|'medium'|'large', linkUrl: ad.linkUrl ?? '', linkLabel: ad.linkLabel ?? 'En savoir plus',
      bgColor: ad.bgColor, textColor: ad.textColor,
      position: ad.position, pages: [...ad.pages],
      displayType: ad.displayType ?? 'banner',
      notifDuration: ad.notifDuration ?? 5,
      carouselInterval: ad.carouselInterval ?? 5,
      notifPosition: ad.notifPosition ?? 'bottom-right' as AdNotifPosition,
      status: ad.status, startDate: ad.startDate, endDate: ad.endDate, priority: ad.priority,
    };
    this.modalAd.set(ad); this.modal.set('edit');
  }

  openPreview(ad: AdminAd): void { this.modalAd.set(ad); this.modal.set('preview'); }
  openDelete(ad: AdminAd): void  { this.modalAd.set(ad); this.modal.set('delete'); }
  closeModal(): void { this.modal.set(null); this.modalAd.set(null); }

  submit(): void {
    if (!this.form.title.trim()) { this.toast.error('Le titre est obligatoire'); return; }
    if (!this.form.startDate || !this.form.endDate) { this.toast.error('Les dates sont obligatoires'); return; }
    if (this.form.startDate > this.form.endDate) { this.toast.error('La date de fin doit être après la date de début'); return; }

    if (this.modal() === 'add') {
      this.adsSvc.add(this.form);
      this.toast.success('Publicité créée');
      this.audit.log(this.auth.currentAdmin()!.id,'ads','Publicité créée',{severity:'success',targetName:this.form.title,details:'Position : '+this.form.position+' · Type : '+this.form.displayType});
    } else {
      this.adsSvc.update(this.modalAd()!.id, this.form);
      this.toast.success('Publicité mise à jour');
      this.audit.log(this.auth.currentAdmin()!.id,'ads','Publicité modifiée',{severity:'info',targetId:this.modalAd()!.id,targetName:this.form.title});
    }
    this.closeModal();
  }

  confirmDelete(): void {
    this.adsSvc.delete(this.modalAd()!.id);
    this.toast.warn('Publicité supprimée');
    this.audit.log(this.auth.currentAdmin()!.id,'ads','Publicité supprimée',{severity:'danger',targetId:this.modalAd()!.id,targetName:this.modalAd()!.title});
    this.closeModal();
  }

  toggleStatus(ad: AdminAd): void {
    this.adsSvc.toggleStatus(ad.id);
    this.toast.show(ad.status === 'active' ? 'Publicité mise en pause' : 'Publicité activée');
  }

  togglePage(page: string): void {
    const idx = this.form.pages.indexOf(page);
    if (idx >= 0) this.form.pages.splice(idx, 1);
    else this.form.pages.push(page);
  }

  pickColor(bg: string, text: string): void {
    this.form.bgColor = bg; this.form.textColor = text;
  }

  isExpired(ad: AdminAd): boolean {
    return ad.endDate < new Date().toISOString().split('T')[0];
  }

  daysLeft(ad: AdminAd): number {
    const diff = new Date(ad.endDate).getTime() - Date.now();
    return Math.max(0, Math.ceil(diff / 86400000));
  }

  ctr(ad: AdminAd): string {
    if (!ad.views) return '0%';
    return (ad.clicks / ad.views * 100).toFixed(1) + '%';
  }

  statusColor(st: AdStatus): string {
    return { active:'var(--a-green)', paused:'var(--a-amber)', expired:'var(--a-red)', scheduled:'var(--a-cyan)' }[st];
  }

  statusLabel(st: AdStatus): string {
    return { active:'Actif', paused:'Pausé', expired:'Expiré', scheduled:'Planifié' }[st];
  }

  setNotifPosition(pos: string): void {
    this.form.notifPosition = pos as AdNotifPosition;
  }

  onImageFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file  = input?.files?.[0];
    if (!file) return;
    // Validation type + taille (max 2 Mo)
    if (!file.type.match(/^image\//)) { alert('Fichier non valide — image ou GIF uniquement'); return; }
    if (file.size > 2 * 1024 * 1024)  { alert('Fichier trop volumineux — maximum 2 Mo'); return; }
    const reader = new FileReader();
    reader.onload = (e) => { this.form.imageUrl = e.target?.result as string; };
    reader.readAsDataURL(file);
  }

  clearImage(): void { this.form.imageUrl = ''; }
}
