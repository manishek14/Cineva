import {
  RESERVATION_TRANSITIONS,
  PAYMENT_TRANSITIONS,
  TICKET_TRANSITIONS,
  canTransition,
} from 'src/common/constants/state-machine';

describe('State machines', () => {
  describe('Reservation state machine', () => {
    it('allows PendingPayment -> Confirmed', () => {
      expect(canTransition(RESERVATION_TRANSITIONS, 'PendingPayment', 'Confirmed')).toBe(true);
    });

    it('allows PendingPayment -> Expired', () => {
      expect(canTransition(RESERVATION_TRANSITIONS, 'PendingPayment', 'Expired')).toBe(true);
    });

    it('allows PendingPayment -> Cancelled', () => {
      expect(canTransition(RESERVATION_TRANSITIONS, 'PendingPayment', 'Cancelled')).toBe(true);
    });

    it('allows Confirmed -> Cancelled', () => {
      expect(canTransition(RESERVATION_TRANSITIONS, 'Confirmed', 'Cancelled')).toBe(true);
    });

    it('rejects Expired -> Confirmed (PRD §9.1: expired reservation cannot be re-confirmed)', () => {
      expect(canTransition(RESERVATION_TRANSITIONS, 'Expired', 'Confirmed')).toBe(false);
    });

    it('rejects Cancelled -> Confirmed', () => {
      expect(canTransition(RESERVATION_TRANSITIONS, 'Cancelled', 'Confirmed')).toBe(false);
    });

    it('rejects Confirmed -> PendingPayment (no rolling back)', () => {
      expect(canTransition(RESERVATION_TRANSITIONS, 'Confirmed', 'PendingPayment')).toBe(false);
    });

    it('rejects any transition from terminal states', () => {
      expect(canTransition(RESERVATION_TRANSITIONS, 'Expired', 'Cancelled')).toBe(false);
      expect(canTransition(RESERVATION_TRANSITIONS, 'Cancelled', 'Expired')).toBe(false);
    });

    it('rejects same-state transition (no-op)', () => {
      // Note: state-machine.ts lists transitions to *other* states; same-state
      // is intentionally not in the allowed list (callers must use
      // idempotency guards like expire_processed_at instead).
      expect(canTransition(RESERVATION_TRANSITIONS, 'PendingPayment', 'PendingPayment')).toBe(false);
    });
  });

  describe('Payment state machine', () => {
    it('allows Initiated -> Pending', () => {
      expect(canTransition(PAYMENT_TRANSITIONS, 'Initiated', 'Pending')).toBe(true);
    });

    it('allows Pending -> Succeeded (happy path)', () => {
      expect(canTransition(PAYMENT_TRANSITIONS, 'Pending', 'Succeeded')).toBe(true);
    });

    it('allows Pending -> Failed (unhappy path)', () => {
      expect(canTransition(PAYMENT_TRANSITIONS, 'Pending', 'Failed')).toBe(true);
    });

    it('allows Succeeded -> RefundPending (PRD §9.2: refund is independent)', () => {
      expect(canTransition(PAYMENT_TRANSITIONS, 'Succeeded', 'RefundPending')).toBe(true);
    });

    it('allows RefundPending -> Refunded', () => {
      expect(canTransition(PAYMENT_TRANSITIONS, 'RefundPending', 'Refunded')).toBe(true);
    });

    it('rejects Succeeded -> Succeeded (PRD §6.3: single success)', () => {
      expect(canTransition(PAYMENT_TRANSITIONS, 'Succeeded', 'Succeeded')).toBe(false);
    });

    it('rejects Refunded -> Succeeded (no re-succeed after refund)', () => {
      expect(canTransition(PAYMENT_TRANSITIONS, 'Refunded', 'Succeeded')).toBe(false);
    });

    it('rejects Failed -> Succeeded (terminal failure)', () => {
      expect(canTransition(PAYMENT_TRANSITIONS, 'Failed', 'Succeeded')).toBe(false);
    });
  });

  describe('Ticket state machine', () => {
    it('allows Valid -> Used (gate scan)', () => {
      expect(canTransition(TICKET_TRANSITIONS, 'Valid', 'Used')).toBe(true);
    });

    it('allows Valid -> Cancelled (cancellation refund)', () => {
      expect(canTransition(TICKET_TRANSITIONS, 'Valid', 'Cancelled')).toBe(true);
    });

    it('rejects Used -> Used (PRD §FR-07 rule 4: ticket is one-time)', () => {
      expect(canTransition(TICKET_TRANSITIONS, 'Used', 'Used')).toBe(false);
    });

    it('rejects Used -> Valid (no reviving)', () => {
      expect(canTransition(TICKET_TRANSITIONS, 'Used', 'Valid')).toBe(false);
    });

    it('rejects Cancelled -> Valid (no reviving cancelled)', () => {
      expect(canTransition(TICKET_TRANSITIONS, 'Cancelled', 'Valid')).toBe(false);
    });
  });

  describe('canTransition edge cases', () => {
    it('returns false for unknown source state', () => {
      // Cast to any because unknown states are not in the union;
      // we still want canTransition to NOT throw and just return false.
      expect(canTransition(RESERVATION_TRANSITIONS, 'Unknown' as never, 'Confirmed')).toBe(false);
    });

    it('returns false for unknown target state', () => {
      expect(canTransition(RESERVATION_TRANSITIONS, 'PendingPayment', 'Unknown' as never)).toBe(false);
    });
  });
});
