import { Injectable, signal } from '@angular/core';

export interface Toast { id: number; message: string; type: 'info'|'success'|'error'|'warning'; }

let _id = 0;

@Injectable({ providedIn: 'root' })
export class AdminToastService {
  readonly toasts = signal<Toast[]>([]);

  show(message: string, type: Toast['type'] = 'info'): void {
    const id = ++_id;
    this.toasts.update(t => [...t, { id, message, type }]);
    setTimeout(() => this.toasts.update(t => t.filter(x => x.id !== id)), type === 'error' ? 6000 : 3000);
  }

  success(msg: string) { this.show(msg, 'success'); }
  error(msg: string)   { this.show(msg, 'error'); }
  warning(msg: string) { this.show(msg, 'warning'); }
  warn(msg: string)    { this.show(msg, 'warning'); }
}
