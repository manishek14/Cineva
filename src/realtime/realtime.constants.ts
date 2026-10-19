/**
 * Redis Pub/Sub channels for real-time events.
 *
 * Convention:
 *   cineva:events:screening:{screeningId}  - all events for a screening
 *   cineva:events:reservation:{reservationId} - all events for a reservation
 *
 * Publishers (any service that mutates state) call RealtimeService.publish*.
 * The RedisSubscriber listens on these channels and re-broadcasts to
 * the corresponding WebSocket rooms.
 *
 * Why Redis Pub/Sub instead of directly emitting from the gateway:
 *   - Multiple NestJS instances behind a load balancer must all deliver
 *     events to their local clients. If instance A processes a reservation
 *     but the client is connected to instance B, only Redis Pub/Sub can
 *     bridge them. The gateway on instance B receives the published
 *     message and emits to its local clients.
 */
export const REALTIME_CHANNELS = {
  SCREENING: 'cineva:events:screening',
  RESERVATION: 'cineva:events:reservation',
  PAYMENT: 'cineva:events:payment',
  TICKET: 'cineva:events:ticket',
} as const;

export const REALTIME_ROOMS = {
  screening: (screeningId: string) => `screening:${screeningId}`,
  reservation: (reservationId: string) => `reservation:${reservationId}`,
} as const;

export const REALTIME_EVENTS = {
  // Seat-status events (per-screening scope).
  SEAT_HELD: 'seat:held',
  SEAT_RELEASED: 'seat:released',
  SEAT_SOLD: 'seat:sold',
  SEAT_BLOCKED: 'seat:blocked',
  SEAT_AVAILABLE: 'seat:available',

  // Screening-scope events.
  SCREENING_CANCELLED: 'screening:cancelled',

  // Reservation-scope events.
  RESERVATION_CONFIRMED: 'reservation:confirmed',
  RESERVATION_EXPIRED: 'reservation:expired',
  RESERVATION_CANCELLED: 'reservation:cancelled',
} as const;

export type RealtimeEventName = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

export interface SeatStatusPayload {
  screeningId: string;
  seatIds: string[];
  status: 'Held' | 'Sold' | 'Released' | 'Available' | 'Blocked';
  reservationId?: string;
  reason?: string;
  occurredAt: string;
}

export interface ScreeningCancelledPayload {
  screeningId: string;
  reason?: string;
  occurredAt: string;
}

export interface ReservationEventPayload {
  reservationId: string;
  customerId?: string | null;
  screeningId?: string;
  status: 'PendingPayment' | 'Confirmed' | 'Expired' | 'Cancelled';
  occurredAt: string;
}
