import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AppConfigService } from './config/app-config.service';

/** Tant que l'application n'a pas été configurée, tout mène à l'assistant de première configuration. */
export const setupDoneGuard: CanActivateFn = () => {
  const cfg = inject(AppConfigService);
  return cfg.setupCompleted() ? true : inject(Router).createUrlTree(['/setup']);
};
/** Une fois la configuration terminée, l'assistant n'est plus accessible (le serveur le refuse aussi). */
export const setupPendingGuard: CanActivateFn = () => {
  const cfg = inject(AppConfigService);
  return cfg.setupCompleted() ? inject(Router).createUrlTree(['/admin/login']) : true;
};
