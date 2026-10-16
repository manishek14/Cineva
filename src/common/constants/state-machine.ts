export type ReservationStatus =
  | 'PendingPayment'
  | 'Confirmed'
  | 'Expired'
  | 'Cancelled';

export type PaymentStatus =
  | 'Initiated'
  | 'Pending'
  | 'Succeeded'
  | 'Failed'
  | 'Cancelled'
  | 'RefundPending'
  | 'Refunded';

export type ScreeningSeatStatus = 'Available' | 'Held' | 'Sold' | 'Blocked';

export type TicketStatus = 'Valid' | 'Used' | 'Cancelled';

export type AllocationOwnerType = 'reservation' | 'admin' | 'maintenance';

export const ROLES = {
  CUSTOMER: 'customer',
  GATE_ATTENDANT: 'gate_attendant',
  CINEMA_OPERATOR: 'cinema_operator',
  CINEMA_MANAGER: 'cinema_manager',
  TECH_ADMIN: 'tech_admin',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/**
 * Reservation state machine - allowed transitions.
 */
export const RESERVATION_TRANSITIONS: Record<ReservationStatus, ReservationStatus[]> = {
  PendingPayment: ['Confirmed', 'Expired', 'Cancelled'],
  Confirmed: ['Cancelled'],
  Expired: [],
  Cancelled: [],
};

/**
 * Ticket state machine - allowed transitions.
 */
export const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  Valid: ['Used', 'Cancelled'],
  Used: [],
  Cancelled: [],
};

/**
 * Payment state machine - allowed transitions.
 */
export const PAYMENT_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  Initiated: ['Pending', 'Failed', 'Cancelled'],
  Pending: ['Succeeded', 'Failed', 'Cancelled'],
  Succeeded: ['RefundPending'],
  Failed: [],
  Cancelled: [],
  RefundPending: ['Refunded'],
  Refunded: [],
};

export function canTransition<T extends string>(
  transitions: Record<T, T[]>,
  from: T,
  to: T,
): boolean {
  return transitions[from]?.includes(to) ?? false;
}
