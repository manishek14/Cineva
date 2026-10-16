import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Injectable, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as QRCode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import { TicketEntity, TicketStatus } from '../entities/ticket.entity';
import { ReservationSeatEntity } from '../../reservation/entities/reservation-seat.entity';
import { ReservationEntity } from '../../reservation/entities/reservation.entity';
import { ScreeningSeatEntity } from '../../screening/entities/screening-seat.entity';
import { ScreeningEntity } from '../../screening/entities/screening.entity';
import { SeatEntity } from '../../hall/entities/seat.entity';
import { CinemaHallEntity } from '../../hall/entities/cinema-hall.entity';
import { MovieEntity } from '../../catalog/entities/movie.entity';
import { ScanTicketDto, TicketResponseDto, ScanResultDto } from '../dtos/ticket.dto';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';
import { canTransition, TICKET_TRANSITIONS } from '../../common/constants/state-machine';

/**
 * TicketService - issue + scan.
 *
 * Issue is called by PaymentService (or its post-commit outbox event
 * handler) AFTER ReservationService.confirmReservation succeeds.
 *
 * Scan is called by gate attendants with a QR token. The scan is
 * ATOMIC via SELECT FOR UPDATE on the ticket row + state-machine
 * check; two concurrent scans cannot both succeed (PRD §FR-07 rule 4).
 */
@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    @InjectRepository(TicketEntity)
    private readonly ticketRepo: Repository<TicketEntity>,
    @InjectRepository(ReservationSeatEntity)
    private readonly resSeatRepo: Repository<ReservationSeatEntity>,
    @InjectRepository(ReservationEntity)
    private readonly reservationRepo: Repository<ReservationEntity>,
    @InjectRepository(ScreeningSeatEntity)
    private readonly screeningSeatRepo: Repository<ScreeningSeatEntity>,
    @InjectRepository(ScreeningEntity)
    private readonly screeningRepo: Repository<ScreeningEntity>,
    @InjectRepository(SeatEntity)
    private readonly seatRepo: Repository<SeatEntity>,
    @InjectRepository(CinemaHallEntity)
    private readonly hallRepo: Repository<CinemaHallEntity>,
    @InjectRepository(MovieEntity)
    private readonly movieRepo: Repository<MovieEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Issue tickets for all Sold seats in a reservation.
   * Idempotent: if tickets already exist for these seats, skip.
   * Returns the tickets with their plaintext qrToken (only time we
   * surface this; never persisted in plaintext).
   */
  async issueForReservation(
    reservationId: string,
  ): Promise<{ issued: TicketResponseDto[]; skipped: string[] }> {
    return await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const tRepo = manager.getRepository(TicketEntity);
      const rsRepo = manager.getRepository(ReservationSeatEntity);

      // Lock reservation + load all Sold seats.
      const reservation = await manager
        .getRepository(ReservationEntity)
        .createQueryBuilder('r')
        .setLock('pessimistic_write')
        .where('r.id = :id', { id: reservationId })
        .getOne();
      if (!reservation) {
        throw BusinessError.notFound(
          `Reservation ${reservationId} not found`,
          ERROR_CODES.RESERVATION_NOT_FOUND,
        );
      }
      if (reservation.status !== 'Confirmed') {
        throw BusinessError.conflict(
          `Reservation is ${reservation.status}; cannot issue tickets`,
          ERROR_CODES.RESERVATION_CONFIRMED,
        );
      }

      const soldSeats = await rsRepo.find({
        where: { reservationId, status: 'Sold' as never },
      });

      // Skip seats that already have a ticket (idempotent re-issue).
      const existing = await tRepo.find({
        where: { reservationSeatId: soldSeats.map((s) => s.id) as never },
      });
      const existingByRsId = new Map(existing.map((t) => [t.reservationSeatId, t]));
      const issued: TicketResponseDto[] = [];
      const skipped: string[] = [];

      for (const rs of soldSeats) {
        if (existingByRsId.has(rs.id)) {
          skipped.push(rs.id);
          continue;
        }
        const qrToken = uuidv4() + uuidv4(); // 72-char unguessable token
        const qrTokenHash = await bcrypt.hash(qrToken, 10);
        const publicCode = this.generatePublicCode();

        const ticket = tRepo.create({
          reservationSeatId: rs.id,
          publicCode,
          qrTokenHash,
          status: 'Valid' as TicketStatus,
        });
        const saved = await tRepo.save(ticket);
        issued.push(
          TicketResponseDto.from({
            id: saved.id,
            reservationSeatId: saved.reservationSeatId,
            publicCode: saved.publicCode,
            status: saved.status,
            usedAt: null,
            createdAt: saved.createdAt,
            updatedAt: saved.updatedAt,
            qrToken,
          }),
        );
      }
      return { issued, skipped };
    });
  }

  /**
   * Generate a QR PNG for a ticket (returns base64 data URL).
   * This is a convenience; the qrToken itself is what gets validated
   * at the gate. The QR encodes the qrToken (not customer PII).
   *
   * PRD §FR-07 rule 3: QR must not leak customer PII.
   */
  async getQrPng(ticketId: string, userId: string): Promise<string> {
    const ticket = await this.ticketRepo.findOne({ where: { id: ticketId } });
    if (!ticket) {
      throw BusinessError.notFound(`Ticket ${ticketId} not found`, ERROR_CODES.TICKET_NOT_FOUND);
    }
    // The plaintext token is not stored, so we can only re-issue a new
    // QR (with a NEW token) if the original was lost. This endpoint
    // returns a placeholder PNG of the publicCode; the actual token
    // is presented via a separate "re-issue" path.
    const png = await QRCode.toDataURL(`cineva:${ticket.publicCode}`, { width: 256 });
    return png;
  }

  /**
   * Validate + consume a ticket at the gate.
   * ATOMIC: SELECT FOR UPDATE on ticket row + state-machine check.
   * Two concurrent scans CANNOT both succeed (PRD §FR-07 rule 4).
   */
  async scanTicket(dto: ScanTicketDto, gateAttendantId: string): Promise<ScanResultDto> {
    // Pre-fetch by hashed token. We can't directly query by token hash
    // because bcrypt includes random salt. We must enumerate Valid tickets
    // and bcrypt.compare each. For perf, narrow by status=Valid first.
    const candidates = await this.ticketRepo.find({
      where: { status: 'Valid' as TicketStatus },
      take: 1000, // bounded scan; in production index by reservation/screening date
    });

    let matched: TicketEntity | null = null;
    for (const t of candidates) {
      const ok = await bcrypt.compare(dto.qrToken, t.qrTokenHash);
      if (ok) {
        matched = t;
        break;
      }
    }
    if (!matched) {
      throw BusinessError.notFound(
        'No valid ticket matches this QR token',
        ERROR_CODES.TICKET_QR_INVALID,
      );
    }

    // Now acquire a pessimistic lock and re-check status (another scan
    // may have just consumed it).
    return await this.dataSource.transaction('SERIALIZABLE', async (manager) => {
      const tRepo = manager.getRepository(TicketEntity);
      const ticket = await tRepo
        .createQueryBuilder('t')
        .setLock('pessimistic_write')
        .where('t.id = :id', { id: matched!.id })
        .getOne();
      if (!ticket) {
        throw BusinessError.notFound('Ticket vanished during scan', ERROR_CODES.TICKET_NOT_FOUND);
      }
      if (ticket.status === 'Used') {
        throw BusinessError.conflict(
          'Ticket already used',
          ERROR_CODES.TICKET_ALREADY_USED,
        );
      }
      if (ticket.status === 'Cancelled') {
        throw BusinessError.conflict(
          'Ticket cancelled',
          ERROR_CODES.TICKET_CANCELLED,
        );
      }
      if (!canTransition(TICKET_TRANSITIONS, ticket.status, 'Used')) {
        throw BusinessError.conflict(
          `Cannot use ticket in state ${ticket.status}`,
          ERROR_CODES.TICKET_ALREADY_USED,
        );
      }

      ticket.status = 'Used' as TicketStatus;
      ticket.usedAt = new Date();
      ticket.usedByUserId = gateAttendantId;
      await tRepo.save(ticket);

      // Look up screening info for display.
      let screeningInfo: ScanResultDto['screening'];
      const rs = await manager.getRepository(ReservationSeatEntity).findOne({
        where: { id: ticket.reservationSeatId },
      });
      if (rs) {
        const ss = await manager.getRepository(ScreeningSeatEntity).findOne({
          where: { id: rs.screeningSeatId },
        });
        if (ss) {
          const screeningRow = await manager
            .getRepository(ScreeningEntity)
            .findOne({ where: { id: ss.screeningId } });
          if (screeningRow) {
            const movie = await manager
              .getRepository(MovieEntity)
              .findOne({ where: { id: screeningRow.movieId } });
            const hall = await manager
              .getRepository(CinemaHallEntity)
              .findOne({ where: { id: screeningRow.hallId } });
            const seat = await manager
              .getRepository(SeatEntity)
              .findOne({ where: { id: ss.seatId } });
            screeningInfo = {
              movieTitle: movie?.title ?? 'Unknown',
              hallName: hall?.name ?? 'Unknown',
              startsAt: screeningRow.startsAt.toISOString(),
              rowLabel: seat?.rowLabel ?? '?',
              seatNumber: seat?.seatNumber ?? 0,
            };
          }
        }
      }

      return {
        success: true,
        ticketId: ticket.id,
        publicCode: ticket.publicCode,
        status: ticket.status,
        screening: screeningInfo,
      };
    });
  }

  /**
   * Cancel tickets when a reservation is cancelled post-payment.
   * Idempotent via state machine.
   */
  async cancelForReservation(reservationId: string): Promise<number> {
    const rsSeats = await this.resSeatRepo.find({ where: { reservationId } });
    if (rsSeats.length === 0) return 0;
    const tickets = await this.ticketRepo.find({
      where: { reservationSeatId: rsSeats.map((s) => s.id) as never },
    });
    let count = 0;
    for (const t of tickets) {
      if (t.status !== 'Valid') continue;
      t.status = 'Cancelled' as TicketStatus;
      t.cancelledAt = new Date();
      await this.ticketRepo.save(t);
      count++;
    }
    return count;
  }

  /**
   * List tickets for a reservation (no plaintext qrToken).
   */
  async listForReservation(reservationId: string): Promise<TicketResponseDto[]> {
    const rs = await this.resSeatRepo.find({ where: { reservationId } });
    if (rs.length === 0) return [];
    const tickets = await this.ticketRepo.find({
      where: { reservationSeatId: rs.map((s) => s.id) as never },
    });
    return tickets.map((t) =>
      TicketResponseDto.from({
        id: t.id,
        reservationSeatId: t.reservationSeatId,
        publicCode: t.publicCode,
        status: t.status,
        usedAt: t.usedAt,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }),
    );
  }

  /**
   * Customer-facing: fetch their own ticket. The qrToken is NOT re-surfaced;
   * the QR PNG endpoint above returns a publicCode placeholder.
   */
  async findOne(id: string): Promise<TicketResponseDto> {
    const t = await this.ticketRepo.findOne({ where: { id } });
    if (!t) {
      throw BusinessError.notFound(`Ticket ${id} not found`, ERROR_CODES.TICKET_NOT_FOUND);
    }
    return TicketResponseDto.from({
      id: t.id,
      reservationSeatId: t.reservationSeatId,
      publicCode: t.publicCode,
      status: t.status,
      usedAt: t.usedAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    });
  }

  private generatePublicCode(): string {
    // 8-character alphanumeric, prefixed with 'CV-'
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
    let s = '';
    for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return `CV-${s}`;
  }
}
