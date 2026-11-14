import { Injectable, signal, effect } from '@angular/core';
import { store } from '../../core/storage';

export type AdminTheme = 'dark' | 'light';

@Injectable({ providedIn: 'root' })
export class AdminThemeService {

  readonly theme = signal<AdminTheme>(this.load());

  constructor() {
    // Applique le thème au démarrage et à chaque changement
    effect(() => {
      const t = this.theme();
      document.documentElement.setAttribute('data-admin-theme', t);
      store.set('admin_theme', t);
    });
  }

  toggle(): void {
    this.theme.update(t => t === 'dark' ? 'light' : 'dark');
  }

  set(t: AdminTheme): void { this.theme.set(t); }

  get isDark(): boolean  { return this.theme() === 'dark'; }
  get isLight(): boolean { return this.theme() === 'light'; }

  private load(): AdminTheme {
    const saved = store.get<string>('admin_theme', 'dark');
    return saved === 'light' ? 'light' : 'dark';
  }
}
