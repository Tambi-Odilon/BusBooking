import { Injectable, signal, computed, OnDestroy, NgZone, inject } from '@angular/core';

/** Durée du verrou temporaire : 10 minutes */
export const LOCK_TTL_MS = 10 * 60 * 1000;

/** Clé localStorage pour tous les verrous */
const STORAGE_KEY = 'soatrans_seat_locks';

/** Une session de verrou sur un siège */
export interface SeatLock {
  busKey:    string;   // busId+date+from+to
  seat:      string;   // ex. "A3"
  sessionId: string;   // UUID de la fenêtre courante
  expiresAt: number;   // timestamp ms
}

@Injectable({ providedIn: 'root' })
export class SeatLockService implements OnDestroy {
  private ngZone = inject(NgZone);

  /** UUID stable pour cette session navigateur */
  readonly sessionId = (() => {
    let id = sessionStorage.getItem('soatrans_sid');
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('soatrans_sid', id); }
    return id;
  })();

  /** Signal interne : snapshot de tous les verrous actifs (non expirés) */
  private readonly _locks = signal<SeatLock[]>([]);

  /** Timer pour rafraîchir le TTL affiché */
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private storageListener: ((e: StorageEvent) => void) | null = null;

  constructor() {
    this._loadFromStorage();
    this._startRefreshTimer();
    this._listenStorage();
  }

  // ─── API publique ────────────────────────────────────────────────────────

  /**
   * Retourne les sièges verrouillés PAR D'AUTRES sessions pour ce bus.
   * Ce sont les sièges à afficher en jaune.
   */
  lockedByOthers(busKey: string): string[] {
    return this._locks()
      .filter(l => l.busKey === busKey && l.sessionId !== this.sessionId)
      .map(l => l.seat);
  }

  /**
   * Retourne les sièges verrouillés PAR CETTE session.
   */
  lockedByMe(busKey: string): string[] {
    return this._locks()
      .filter(l => l.busKey === busKey && l.sessionId === this.sessionId)
      .map(l => l.seat);
  }

  /**
   * Pose un verrou sur chaque siège de la liste (pour cette session).
   * Renouvelle le TTL si le verrou existe déjà.
   */
  lockSeats(busKey: string, seats: string[]): void {
    const all = this._getFromStorage();
    const expiresAt = Date.now() + LOCK_TTL_MS;

    // Retire les anciens verrous de cette session pour ce bus
    const cleaned = all.filter(
      l => !(l.busKey === busKey && l.sessionId === this.sessionId)
    );

    // Ajoute les nouveaux
    const newLocks: SeatLock[] = seats.map(seat => ({
      busKey, seat, sessionId: this.sessionId, expiresAt,
    }));

    this._saveToStorage([...cleaned, ...newLocks]);
  }

  /**
   * Libère tous les verrous de cette session pour ce bus.
   */
  releaseSeats(busKey: string): void {
    const all = this._getFromStorage();
    this._saveToStorage(
      all.filter(l => !(l.busKey === busKey && l.sessionId === this.sessionId))
    );
  }

  /**
   * Libère TOUS les verrous de cette session (ex. à la confirmation).
   */
  releaseAll(): void {
    const all = this._getFromStorage();
    this._saveToStorage(all.filter(l => l.sessionId !== this.sessionId));
  }

  /**
   * Temps restant (en secondes) pour le verrou de cette session sur ce bus.
   * Retourne null si pas de verrou.
   */
  remainingSeconds(busKey: string): number | null {
    const lock = this._locks().find(
      l => l.busKey === busKey && l.sessionId === this.sessionId
    );
    if (!lock) return null;
    return Math.max(0, Math.ceil((lock.expiresAt - Date.now()) / 1000));
  }

  /**
   * Construit la clé unique bus+trajet+date.
   */
  buildKey(busId: string, from: string, to: string, date: string): string {
    return `${busId}|${from}|${to}|${date}`;
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private _getFromStorage(): SeatLock[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const all: SeatLock[] = JSON.parse(raw);
      // Purge les expirés
      return all.filter(l => l.expiresAt > Date.now());
    } catch { return []; }
  }

  private _saveToStorage(locks: SeatLock[]): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(locks));
      this._locks.set(locks.filter(l => l.expiresAt > Date.now()));
    } catch {}
  }

  private _loadFromStorage(): void {
    this._locks.set(this._getFromStorage());
  }

  /** Rafraîchit le signal toutes les 5 secondes (pour le compte à rebours) */
  private _startRefreshTimer(): void {
    this.refreshTimer = setInterval(() => {
      this.ngZone.run(() => this._loadFromStorage());
    }, 5000);
  }

  /** Écoute les changements localStorage d'autres onglets */
  private _listenStorage(): void {
    this.storageListener = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        this.ngZone.run(() => this._loadFromStorage());
      }
    };
    window.addEventListener('storage', this.storageListener);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.storageListener) window.removeEventListener('storage', this.storageListener);
    // Libère les verrous de cette session au destroy
    this.releaseAll();
  }
}
