import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { I18nService } from '../../core/services/i18n.service';
import { AppConfigService } from '../../core/config/app-config.service';

/** Textes légaux saisis par la société dans ses paramètres : conditions générales, annulation et remboursement, confidentialité. */
@Component({
  selector: 'app-legal',
  standalone: true,
  imports: [RouterLink],
  template: `
  <article class="max-w-3xl mx-auto bg-white rounded-2xl border border-slate-200 shadow-sm p-6 sm:p-10">
    <h1 class="text-2xl font-bold font-display text-slate-900">{{ title() }}</h1>
    <p class="text-sm text-slate-500 mt-1">{{ cfg.identity().legalName || cfg.name() }}</p>
    @if (text()) { <div class="mt-6 text-slate-700 leading-relaxed whitespace-pre-line">{{ text() }}</div> }
    @else { <p class="mt-6 text-slate-500">{{ t().x.noLegal }}</p> }
    @if (doc() === 'contact') {
      <dl class="mt-6 grid sm:grid-cols-2 gap-4 text-sm">
        @for (ph of cfg.contact().phones; track ph) { <div><dt class="text-slate-500">Téléphone</dt><dd><a class="text-blue-700 font-semibold" [href]="'tel:' + ph">{{ ph }}</a></dd></div> }
        @if (cfg.contact().whatsapp) { <div><dt class="text-slate-500">WhatsApp</dt><dd><a class="text-blue-700 font-semibold" [href]="'https://wa.me/' + digits(cfg.contact().whatsapp)" rel="noopener" target="_blank">{{ cfg.contact().whatsapp }}</a></dd></div> }
        @if (cfg.contact().email) { <div><dt class="text-slate-500">E-mail</dt><dd><a class="text-blue-700 font-semibold" [href]="'mailto:' + cfg.contact().email">{{ cfg.contact().email }}</a></dd></div> }
        @if (cfg.contact().address) { <div><dt class="text-slate-500">Adresse</dt><dd class="text-slate-800">{{ cfg.contact().address }} {{ cfg.contact().city }}</dd></div> }
        @if (cfg.contact().openingHours) { <div class="sm:col-span-2"><dt class="text-slate-500">Horaires</dt><dd class="text-slate-800 whitespace-pre-line">{{ cfg.contact().openingHours }}</dd></div> }
      </dl>
      @if (cfg.config().legal.registrationNumbers.length) {
        <ul class="mt-6 text-xs text-slate-500 space-y-1">@for (n of cfg.config().legal.registrationNumbers; track n.label) { <li>{{ n.label }} : {{ n.value }}</li> }</ul>
      }
    }
    <a routerLink="/" class="inline-block mt-8 text-sm font-semibold text-blue-700 hover:underline">← {{ t().x.home }}</a>
  </article>`,
})
export class LegalComponent {
  readonly cfg = inject(AppConfigService);
  readonly t = inject(I18nService).t;
  readonly doc = toSignal(inject(ActivatedRoute).paramMap.pipe(map(p => p.get('doc') || 'terms')), { initialValue: 'terms' });
  readonly title = computed(() => ({ terms: this.t().x.terms, privacy: this.t().x.privacy, cancellation: this.t().x.cancelPolicy, contact: this.t().x.contactUs } as Record<string, string>)[this.doc()] ?? this.t().x.terms);
  readonly text = computed(() => { const l = this.cfg.config().legal; return ({ terms: l.termsText, privacy: l.privacyText, cancellation: l.cancellationPolicyText, contact: this.cfg.identity().description || ' ' } as Record<string, string>)[this.doc()] ?? ''; });
  digits(s: string): string { return s.replace(/\D/g, ''); }
}
