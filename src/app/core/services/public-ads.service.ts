import { Injectable, inject, signal } from '@angular/core';
import { ApiService } from '../api/api.service';
import { AdminAd } from '../../admin/models/admin.models';
import { toAd } from '../../admin/services/admin-ads.service';

/** Publicités affichées sur le site client : seules celles actives pour la page courante sont servies par l'API. */
@Injectable({ providedIn: 'root' })
export class PublicAdsService {
  private api = inject(ApiService);
  private readonly cache = signal<Record<string, AdminAd[]>>({});
  private pending = new Map<string, Promise<AdminAd[]>>();
  private seen = new Set<string>();

  /** Publicités actives pour une page ('' = toutes pages). Mis en cache pendant la visite. */
  load(page = ''): Promise<AdminAd[]> {
    const hit = this.cache()[page];
    if (hit) return Promise.resolve(hit);
    if (!this.pending.has(page)) {
      this.pending.set(page, this.api.get<any[]>('/ads', { query: { page }, scope: 'none', retries: 1 })
        .then(list => { const ads = list.map(toAd); this.cache.update(c => ({ ...c, [page]: ads })); return ads; }, () => [] as AdminAd[])
        .finally(() => this.pending.delete(page)));
    }
    return this.pending.get(page)!;
  }
  async getBanners(page = ''): Promise<AdminAd[]> { return (await this.load(page)).filter(a => a.displayType !== 'notification'); }
  async getNotifications(page = ''): Promise<AdminAd[]> { return (await this.load(page)).filter(a => a.displayType === 'notification'); }
  /** Un affichage est compté une seule fois par visite. */
  recordView(id: string): void {
    if (this.seen.has(id)) return;
    this.seen.add(id);
    void this.api.post(`/ads/${id}/view`, undefined, { scope: 'none', keepalive: true }).catch(() => undefined);
  }
  recordClick(id: string): void { void this.api.post(`/ads/${id}/click`, undefined, { scope: 'none', keepalive: true }).catch(() => undefined); }
}
