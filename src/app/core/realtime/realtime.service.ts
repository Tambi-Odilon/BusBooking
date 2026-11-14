import { Injectable, NgZone, inject, signal } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { ApiService, Scope } from '../api/api.service';

type Handler = (payload: any) => void;

/**
 * Temps réel (Socket.IO). Les événements servent uniquement à rafraîchir l'affichage : après chaque (re)connexion,
 * les écrans relisent l'état complet par l'API (voir `onReconnect`).
 */
@Injectable({ providedIn: 'root' })
export class RealtimeService {
  private zone = inject(NgZone);
  private api = inject(ApiService);
  private socket: Socket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private trips = new Set<string>();
  private bookings = new Map<string, string>();
  private reconnectHandlers = new Set<() => void>();
  private scope: Scope = 'customer';
  readonly connected = signal(false);

  private ensure(): Socket {
    if (this.socket) return this.socket;
    const s = this.zone.runOutsideAngular(() => io({ path: '/socket.io', transports: ['websocket', 'polling'], auth: cb => cb({ token: this.api.token(this.scope) || undefined }),
      reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10000 }));
    s.on('connect', () => {
      this.zone.run(() => this.connected.set(true));
      for (const id of this.trips) s.emit('trip.join', { tripId: id });
      for (const [reference, token] of this.bookings) s.emit('booking.join', { reference, token });
      this.zone.run(() => this.reconnectHandlers.forEach(h => h()));
    });
    s.on('disconnect', () => this.zone.run(() => this.connected.set(false)));
    s.onAny((event: string, payload: any) => {
      const hs = this.handlers.get(event);
      if (hs?.size) this.zone.run(() => hs.forEach(h => { try { h(payload); } catch { /* un écran en erreur ne coupe pas les autres */ } }));
    });
    this.socket = s;
    return s;
  }
  /** À appeler après une connexion, une déconnexion ou un renouvellement de jeton. */
  identify(scope: Scope): void {
    this.scope = scope;
    if (this.socket?.connected) this.socket.emit('auth', { token: this.api.token(scope) || '' });
    else if (this.api.token(scope)) this.ensure();
  }
  on(event: string, handler: Handler): () => void {
    this.ensure();
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
    return () => this.handlers.get(event)?.delete(handler);
  }
  /** Rappel exécuté à chaque (re)connexion : l'écran y relit son état complet. */
  onReconnect(handler: () => void): () => void { this.ensure(); this.reconnectHandlers.add(handler); return () => this.reconnectHandlers.delete(handler); }
  joinTrip(tripId: string): void { this.trips.add(tripId); this.ensure().emit('trip.join', { tripId }); }
  leaveTrip(tripId: string): void { this.trips.delete(tripId); this.socket?.emit('trip.leave', { tripId }); }
  joinBooking(reference: string, token: string): void { this.bookings.set(reference, token); this.ensure().emit('booking.join', { reference, token }); }
  leaveBooking(reference: string): void { this.bookings.delete(reference); }
}
