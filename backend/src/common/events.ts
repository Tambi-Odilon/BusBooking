import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Subject } from 'rxjs';
import type Redis from 'ioredis';
import { RedisService } from './redis';

export interface AppEvent { room: string; event: string; payload: any }
const CHANNEL = 'bb:events';

/**
 * Bus d'événements temps réel. Chaque événement est publié sur Redis : toutes les instances de l'API
 * (et le worker) le reçoivent et le relaient à leurs propres sockets. Sans Redis, repli local.
 */
@Injectable()
export class EventBus implements OnModuleInit, OnModuleDestroy {
  readonly stream = new Subject<AppEvent>();
  private sub?: Redis;
  private subscribed = false;
  constructor(private redis: RedisService) {}
  async onModuleInit() {
    try {
      this.sub = this.redis.duplicate();
      this.sub.on('message', (_c, msg) => { try { this.stream.next(JSON.parse(msg)); } catch { /* message illisible ignoré */ } });
      await this.sub.subscribe(CHANNEL);
      this.subscribed = true;
    } catch { this.subscribed = false; }
  }
  emit(room: string, event: string, payload: any = {}) {
    const e: AppEvent = { room, event, payload };
    if (!this.subscribed) { this.stream.next(e); return; }
    this.redis.client.publish(CHANNEL, JSON.stringify(e)).catch(() => this.stream.next(e));
  }
  async onModuleDestroy() { try { await this.sub?.quit(); } catch { this.sub?.disconnect(); } this.stream.complete(); }
}
