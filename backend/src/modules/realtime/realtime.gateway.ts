import { OnGatewayConnection, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { OnModuleDestroy } from '@nestjs/common';
import { Subscription } from 'rxjs';
import type { Server, Socket } from 'socket.io';
import { AuthLoader, verifyAccess } from '../../common/auth';
import { EventBus } from '../../common/events';
import { env } from '../../common/env';
import { BookingsService } from '../booking/bookings.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Temps réel (Socket.IO : WebSocket avec repli automatique en long-polling sur réseau mobile instable).
 * Salons : trip:{id} (public, état des sièges) · booking:{id} (invité muni du jeton) · user:{id} · staff · public.
 * Les événements ne sont jamais la source de vérité : à chaque (re)connexion le client relit l'état complet par l'API REST.
 */
@WebSocketGateway({ path: '/socket.io', cors: { origin: (o: string, cb: (e: Error | null, ok?: boolean) => void) => cb(null, !o || env().corsOrigins.includes(o) || !env().isProd), credentials: true }, maxHttpBufferSize: 10_000 })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private sub?: Subscription;
  constructor(private bus: EventBus, private loader: AuthLoader, private bookings: BookingsService) {}

  afterInit() { this.sub = this.bus.stream.subscribe(e => this.server.to(e.room).emit(e.event, e.payload)); }
  onModuleDestroy() { this.sub?.unsubscribe(); }
  get connections() { return this.server?.engine?.clientsCount ?? 0; }

  private async identify(client: Socket, token?: string) {
    for (const r of client.rooms) if (r.startsWith('user:') || r === 'staff') client.leave(r);
    client.data.user = null;
    if (!token) return;
    try {
      const u = await this.loader.load(verifyAccess(token));
      client.data.user = u;
      client.join(`user:${u.id}`);
      if (u.kind === 'staff') client.join('staff');
    } catch { client.emit('auth.error', { code: 'TOKEN_INVALID' }); }
  }
  async handleConnection(client: Socket) {
    client.join('public');
    await this.identify(client, client.handshake.auth?.token);
  }
  /** Après un renouvellement du jeton d'accès, le client se ré-identifie sans couper la connexion. */
  @SubscribeMessage('auth') async auth(client: Socket, d: any) { await this.identify(client, String(d?.token || '')); return { ok: !!client.data.user }; }
  @SubscribeMessage('trip.join') tripJoin(client: Socket, d: any) {
    const id = String(d?.tripId || '');
    if (!UUID.test(id)) return { ok: false };
    const mine = [...client.rooms].filter(r => r.startsWith('trip:'));
    if (mine.length >= 8 && !client.data.user) client.leave(mine[0]);   // un visiteur ne suit que quelques voyages à la fois
    client.join(`trip:${id}`);
    return { ok: true };
  }
  @SubscribeMessage('trip.leave') tripLeave(client: Socket, d: any) { client.leave(`trip:${String(d?.tripId || '')}`); return { ok: true }; }
  @SubscribeMessage('booking.join') async bookingJoin(client: Socket, d: any) {
    try { const b = await this.bookings.authorize(String(d?.reference || ''), { user: client.data.user }, String(d?.token || '')); client.join(`booking:${b.id}`); return { ok: true }; }
    catch { return { ok: false }; }
  }
}
