import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { I18nService } from '../core/services/i18n.service';
import { LANG_META, Lang } from '../core/i18n/index';

@Component({
  selector: 'app-layout',
  standalone: true,
  imports: [RouterOutlet, RouterLink],
  templateUrl: './layout.component.html',
  styleUrl: './layout.component.scss',
})
export class LayoutComponent {
  readonly i18n     = inject(I18nService);
  readonly langMeta = LANG_META;
  readonly dropOpen = signal(false);

  setLang(code: Lang): void {
    this.i18n.setLang(code);
    this.dropOpen.set(false);
  }

  toggleDrop(): void { this.dropOpen.update(v => !v); }
  closeDrop(): void  { this.dropOpen.set(false); }

  get currentMeta() {
    return this.langMeta.find(l => l.code === this.i18n.lang()) ?? this.langMeta[0];
  }
}
