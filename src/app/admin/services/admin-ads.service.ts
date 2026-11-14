import { Injectable, computed, signal } from '@angular/core';
import { AdminAd, AdminPermissions } from '../models/admin.models';
import { RemoteStore, clean } from './admin-store';

export const toAd = (a: any): AdminAd => ({
  id: a.id, title: a.title, description: a.description || '', imageUrl: a.imageUrl || '', imagePosition: a.imagePosition || undefined, imageSize: a.imageSize || undefined,
  linkUrl: a.linkUrl || '', linkLabel: a.linkLabel || '', bgColor: a.bgColor, textColor: a.textColor, position: a.position, pages: a.pages || [],
  status: a.effectiveStatus || a.status, startDate: a.startDate, endDate: a.endDate, priority: a.priority, displayType: a.displayType, notifDuration: a.notifDuration,
  notifPosition: a.notifPosition || undefined, carouselInterval: a.carouselInterval, clicks: a.clicks || 0, views: a.views || 0, createdAt: a.createdAt, updatedAt: a.updatedAt,
});
const NULLABLE = ['imageUrl', 'imagePosition', 'imageSize', 'linkUrl', 'linkLabel', 'notifPosition'];
const toBody = (p: Partial<AdminAd>) => clean({ title: p.title, description: p.description, imageUrl: p.imageUrl, imagePosition: p.imagePosition, imageSize: p.imageSize, linkUrl: p.linkUrl, linkLabel: p.linkLabel,
  bgColor: p.bgColor, textColor: p.textColor, position: p.position, pages: p.pages, status: p.status === undefined ? undefined : (p.status === 'paused' ? 'paused' : 'active'),
  startDate: p.startDate, endDate: p.endDate, priority: p.priority, displayType: p.displayType, notifDuration: p.notifDuration, notifPosition: p.notifPosition, carouselInterval: p.carouselInterval }, NULLABLE);

/** Gestion des publicités (back-office). L'affichage côté site client passe par `PublicAdsService`. */
@Injectable({ providedIn: 'root' })
export class AdminAdsService extends RemoteStore {
  protected readonly needs: (keyof AdminPermissions)[] = ['canManageAds'];
  private readonly _ads = signal<AdminAd[]>([]);
  readonly ads    = this._ads.asReadonly();
  readonly active = computed(() => this._ads().filter(a => a.status === 'active'));
  readonly stats  = computed(() => ({
    total: this._ads().length, active: this._ads().filter(a => a.status === 'active').length, paused: this._ads().filter(a => a.status === 'paused').length,
    expired: this._ads().filter(a => a.status === 'expired').length, scheduled: this._ads().filter(a => a.status === 'scheduled').length,
    totalViews: this._ads().reduce((s, a) => s + a.views, 0), totalClicks: this._ads().reduce((s, a) => s + a.clicks, 0),
  }));

  protected async fetch(): Promise<void> { this._ads.set((await this.api.get<{ items: any[] }>('/admin/ads', { query: { limit: 100 } })).items.map(toAd)); }
  protected reset(): void { this._ads.set([]); }

  add(data: Omit<AdminAd, 'id' | 'clicks' | 'views' | 'createdAt' | 'updatedAt'>): AdminAd {
    const now = new Date().toISOString();
    const created = this.write(() => this.api.post<any>('/admin/ads', toBody(data)));
    const ad: AdminAd = { ...data, id: this.tempId(created), clicks: 0, views: 0, createdAt: now, updatedAt: now };
    this._ads.update(l => [ad, ...l]);
    return ad;
  }
  update(id: string, patch: Partial<AdminAd>): void {
    this._ads.update(l => l.map(a => a.id === id ? { ...a, ...patch } : a));
    const body = toBody(patch);
    if (Object.keys(body).length) void this.write(async () => this.api.patch(`/admin/ads/${await this.real(id)}`, body));
  }
  delete(id: string): void {
    this._ads.update(l => l.filter(a => a.id !== id));
    void this.write(async () => this.api.delete(`/admin/ads/${await this.real(id)}`));
  }
  toggleStatus(id: string): void {
    const ad = this._ads().find(a => a.id === id);
    if (ad) this.update(id, { status: ad.status === 'paused' ? 'active' : 'paused' });
  }
  /** Envoie une image de publicité et renvoie son adresse (2 Mo maximum ; PNG, JPEG, WebP ou GIF). */
  async uploadImage(file: File): Promise<string> {
    const form = new FormData(); form.append('file', file);
    return (await this.api.post<{ url: string }>('/admin/files?kind=ad', undefined, { form })).url;
  }
}
