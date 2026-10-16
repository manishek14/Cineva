import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { Injectable, Logger } from '@nestjs/common';
import { SeatEntity, SeatStatus } from '../entities/seat.entity';
import { CinemaHallEntity } from '../entities/cinema-hall.entity';
import { SeatCategoryEntity } from '../../catalog/entities/seat-category.entity';
import { BulkSeatUpsertDto, SeatDto, SeatResponseDto } from '../dtos/hall.dto';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';

@Injectable()
export class SeatService {
  private readonly logger = new Logger(SeatService.name);

  constructor(
    @InjectRepository(SeatEntity)
    private readonly seatRepo: Repository<SeatEntity>,
    @InjectRepository(CinemaHallEntity)
    private readonly hallRepo: Repository<CinemaHallEntity>,
    @InjectRepository(SeatCategoryEntity)
    private readonly categoryRepo: Repository<SeatCategoryEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Bulk upsert seats for a hall. Existing seats are matched by
   * (hallId, rowLabel, seatNumber) and updated; new ones inserted.
   * Whole operation runs in a single transaction so the unique constraint
   * (PRD §6) is enforced atomically across the upsert batch.
   *
   * Returns the full seat list of the hall after the upsert.
   */
  async bulkUpsert(hallId: string, dto: BulkSeatUpsertDto): Promise<SeatResponseDto[]> {
    // Validate hall exists and is active.
    const hall = await this.hallRepo.findOne({ where: { id: hallId } });
    if (!hall || hall.status === 'Archived') {
      throw BusinessError.notFound(`Hall ${hallId} not found`, ERROR_CODES.HALL_NOT_FOUND);
    }

    // Validate categories exist.
    const categoryIds = Array.from(new Set(dto.seats.map((s) => s.categoryId)));
    const foundCats = await this.categoryRepo.find({
      where: { id: In(categoryIds), status: 'Active' as const },
    });
    const foundIds = new Set(foundCats.map((c) => c.id));
    const missing = categoryIds.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw BusinessError.notFound(
        `Seat categories not found: ${missing.join(', ')}`,
        ERROR_CODES.VALIDATION,
      );
    }

    // Detect duplicates within the batch itself.
    const seen = new Set<string>();
    for (const seat of dto.seats) {
      const key = `${seat.rowLabel}:${seat.seatNumber}`;
      if (seen.has(key)) {
        throw BusinessError.conflict(
          `Duplicate seat ${seat.rowLabel}-${seat.seatNumber} in batch`,
          ERROR_CODES.VALIDATION,
        );
      }
      seen.add(key);
    }

    // Run the upsert inside a transaction.
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SeatEntity);
      for (const seat of dto.seats) {
        const existing = await repo.findOne({
          where: { hallId, rowLabel: seat.rowLabel, seatNumber: seat.seatNumber },
        });
        if (existing) {
          existing.categoryId = seat.categoryId;
          existing.positionX = seat.positionX;
          existing.positionY = seat.positionY;
          // Don't auto-restore Maintenance/Removed status during bulk update.
          if (existing.status === 'Removed') existing.status = 'Active';
          await repo.save(existing);
        } else {
          await repo.save(
            repo.create({
              hallId,
              categoryId: seat.categoryId,
              rowLabel: seat.rowLabel,
              seatNumber: seat.seatNumber,
              positionX: seat.positionX,
              positionY: seat.positionY,
              status: 'Active',
            }),
          );
        }
      }
    });

    // Recalculate hall capacity.
    const updated = await this.seatRepo.find({
      where: { hallId, status: In(['Active', 'Maintenance' as SeatStatus]) },
      order: { rowLabel: 'ASC', seatNumber: 'ASC' },
    });
    const activeCount = updated.filter((s) => s.status === 'Active').length;
    await this.hallRepo.update({ id: hallId }, { totalCapacity: activeCount });
    this.logger.log(`Hall ${hallId}: ${updated.length} seats (${activeCount} active)`);

    return updated.map((s) => SeatResponseDto.from(s));
  }

  async listByHall(hallId: string): Promise<SeatResponseDto[]> {
    const hall = await this.hallRepo.findOne({ where: { id: hallId } });
    if (!hall) {
      throw BusinessError.notFound(`Hall ${hallId} not found`, ERROR_CODES.HALL_NOT_FOUND);
    }
    const seats = await this.seatRepo.find({
      where: { hallId },
      order: { rowLabel: 'ASC', seatNumber: 'ASC' },
    });
    return seats.map((s) => SeatResponseDto.from(s));
  }

  /**
   * Toggle a single seat into maintenance. Per PRD §FR-02: maintenance
   * status on a physical seat should be preserved even if the seat is
   * later released by a cancelled screening sale.
   */
  async setMaintenance(seatId: string, reason: string | null): Promise<SeatResponseDto> {
    const seat = await this.seatRepo.findOne({ where: { id: seatId } });
    if (!seat) {
      throw BusinessError.notFound(`Seat ${seatId} not found`, ERROR_CODES.VALIDATION);
    }
    seat.status = reason ? 'Maintenance' : 'Active';
    seat.maintenanceReason = reason;
    const saved = await this.seatRepo.save(seat);
    // Recalc hall capacity since Maintenance seats don't count as Available.
    await this.hallRepo.update(
      { id: seat.hallId },
      {
        totalCapacity: await this.seatRepo.count({
          where: { hallId: seat.hallId, status: 'Active' as const },
        }),
      },
    );
    return SeatResponseDto.from(saved);
  }

  async removeSeat(seatId: string): Promise<void> {
    const seat = await this.seatRepo.findOne({ where: { id: seatId } });
    if (!seat) return;
    // Soft-remove: status='Removed'. We never hard delete because historical
    // screening_seat records reference seat_id; deleting would orphan them.
    seat.status = 'Removed';
    await this.seatRepo.save(seat);
  }
}
