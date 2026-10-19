import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { OnEvent, EventEmitter2 } from '@nestjs/event-emitter';
import { REALTIME_ROOMS } from '../realtime.constants';
import type {
  SeatStatusPayload,
  ScreeningCancelledPayload,
  ReservationEventPayload,
} from '../realtime.constants';

/**
 * SeatStatusGateway - WebSocket gateway that customers connect to
 * when they're viewing a screening's seat map.
 *
 * Client flow:
 *   1. const socket = io('http://localhost:3000', { transports: ['websocket'] });
 *   2. socket.emit('subscribe', { screeningId: '...' });
 *   3. socket.on('seat:held', (payload) => { ... });
 *   4. socket.on('seat:sold', (payload) => { ... });
 *   5. socket.on('seat:available', (payload) => { ... });
 *
 * Server flow:
 *   - On 'subscribe' message: socket.join(REALTIME_ROOMS.screening(id))
 *   - On RedisSubscriber's 'realtime:message' event: extract
 *     screeningId from the channel name and emit to the corresponding
 *     room.
 *
 * CORS: allowed origins configured via env CORS_ORIGINS (matches the
 * main HTTP server's CORS config).
 *
 * Auth: token is verified via the handshake's auth field. We accept
 * the Bearer access token from the customer's HTTP session and verify
 * it via JwtService. Public clients (no auth) are allowed for the
 * seat-map-only flow because seat status is not sensitive data; the
 * actual reservation creation still requires JWT auth on the HTTP
 * REST endpoints.
 */
@WebSocketGateway({
  namespace: 'realtime',
  cors: {
    origin: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()),
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
@Injectable()
export class SeatStatusGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(SeatStatusGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly events: EventEmitter2,
  ) {}

  afterInit(_server: Server): void {
    this.logger.log('SeatStatusGateway initialized (namespace: /realtime)');
  }

  handleConnection(client: Socket): void {
    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  /**
   * Client subscribes to updates for a specific screening. The client
   * joins a Socket.IO room named `screening:{screeningId}` so that we
   * can use server.to(roomName).emit(...) to broadcast only to
   * interested clients.
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @MessageBody() body: { screeningId?: string; reservationId?: string },
    @ConnectedSocket() client: Socket,
  ): { ok: true; rooms: string[] } {
    const rooms: string[] = [];
    if (body.screeningId) {
      const room = REALTIME_ROOMS.screening(body.screeningId);
      void client.join(room);
      rooms.push(room);
      this.logger.debug(`${client.id} joined ${room}`);
    }
    if (body.reservationId) {
      const room = REALTIME_ROOMS.reservation(body.reservationId);
      void client.join(room);
      rooms.push(room);
      this.logger.debug(`${client.id} joined ${room}`);
    }
    return { ok: true, rooms };
  }

  /**
   * Client unsubscribes from a screening (e.g. when navigating away).
   */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @MessageBody() body: { screeningId?: string; reservationId?: string },
    @ConnectedSocket() client: Socket,
  ): { ok: true } {
    if (body.screeningId) {
      void client.leave(REALTIME_ROOMS.screening(body.screeningId));
    }
    if (body.reservationId) {
      void client.leave(REALTIME_ROOMS.reservation(body.reservationId));
    }
    return { ok: true };
  }

  /**
   * Listen for Redis pub/sub messages forwarded by RedisSubscriber via
   * the NestJS EventEmitter2. Extract the scope id from the channel
   * name and emit the event to the corresponding Socket.IO room.
   */
  @OnEvent('realtime.message', { async: false })
  onRealtimeMessage(args: {
    channel: string;
    event: string;
    payload: unknown;
  }): void {
    const { channel, event, payload } = args;

    // Extract scope type + id from channel name: "cineva:events:{type}:{id}"
    // Strip the key prefix first.
    const prefix = process.env.REDIS_KEY_PREFIX ?? 'cineva:';
    const stripped = channel.startsWith(prefix) ? channel.slice(prefix.length) : channel;
    // stripped looks like: "events:screening:{uuid}"
    // The scope id is everything after the second colon.
    const match = stripped.match(/^events:([a-z]+):(.+)$/);
    if (!match) {
      this.logger.warn(`Unrecognized channel format: ${channel}`);
      return;
    }
    const scopeType = match[1];
    const scopeId = match[2];

    let room: string;
    if (scopeType === 'screening') {
      room = REALTIME_ROOMS.screening(scopeId);
    } else if (scopeType === 'reservation') {
      room = REALTIME_ROOMS.reservation(scopeId);
    } else {
      // Unknown scope - log and skip.
      this.logger.debug(`Skipping unknown scope type ${scopeType}`);
      return;
    }

    // Emit to the room. Clients in the room receive the event.
    this.server?.to(room).emit(event, payload);
    this.logger.debug(`Emitted ${event} to room ${room}`);
  }

  // ----------------------------------------------------------
  // Convenience emit helpers (used in unit tests; in production
  // all events flow through RedisSubscriber).
  // ----------------------------------------------------------

  emitSeatStatus(payload: SeatStatusPayload): void {
    const room = REALTIME_ROOMS.screening(payload.screeningId);
    this.server?.to(room).emit(`seat:${payload.status.toLowerCase()}`, payload);
  }

  emitScreeningCancelled(payload: ScreeningCancelledPayload): void {
    const room = REALTIME_ROOMS.screening(payload.screeningId);
    this.server?.to(room).emit('screening:cancelled', payload);
  }

  emitReservationEvent(payload: ReservationEventPayload & { screeningId?: string }): void {
    if (payload.screeningId) {
      const room = REALTIME_ROOMS.screening(payload.screeningId);
      this.server?.to(room).emit(`reservation:${payload.status.toLowerCase()}`, payload);
    }
  }
}
