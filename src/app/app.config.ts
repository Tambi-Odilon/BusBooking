import { ApplicationConfig, inject, provideAppInitializer, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { routes } from './app.routes';
import { AppConfigService } from './core/config/app-config.service';
import { AuthService } from './core/services/auth.service';
import { AdminSession } from './admin/services/admin-session.service';
import { purgeLegacyStorage } from './core/storage';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'enabled' })),
    provideAnimationsAsync(),
    // Avant le premier affichage : configuration de la société (nom, couleurs, langues…), puis sessions éventuelles.
    provideAppInitializer(async () => {
      const cfg = inject(AppConfigService), auth = inject(AuthService), staff = inject(AdminSession);
      purgeLegacyStorage();
      await cfg.load();
      if (cfg.setupCompleted()) await Promise.all([auth.restore(), staff.restore()]);
    }),
  ],
};
