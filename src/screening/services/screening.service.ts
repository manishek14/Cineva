import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, LessThan, MoreThan, Repository } from 'typeorm';
import { Injectable, Logger } from '@nestjs/common';
import { ScreeningEntity, ScreeningStatus } from '../entities/screening.entity';
import { ScreeningSeatEntity, ScreeningSeatStatus } from '../entities/screening-seat.entity';
import { MovieEntity } from '../../catalog/entities/movie.entity';
import { CinemaHallEntity } from '../../hall/entities/cinema-hall.entity';
import { SeatEntity, SeatStatus } from '../../hall/entities/seat.entity';
import { SeatCategoryEntity } from '../../catalog/entities/seat-category.entity';
import {
  CancelScreeningDto,
  CreateScreeningDto,
  ListScreeningsQueryDto,
  ScreeningResponseDto,
  ScreeningSeatResponseDto,
  UpdateScreeningDto,
} from '../dtos/screening.dto';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';

@Injectable()
export class ScreeningService {
  private readonly logger = new Logger(ScreeningService.name);

  constructor(
    @InjectRepository(ScreeningEntity)
    private readonly screeningRepo: Repository<ScreeningEntity>,
    @InjectRepository(ScreeningSeatEntity)
    private readonly seatRepo: Repository<ScreeningSeatEntity>,
    @InjectRepository(MovieEntity)
    private readonly movieRepo: Repository<MovieEntity>,
    @InjectRepository(CinemaHallEntity)
    private readonly hallRepo: Repository<CinemaHallEntity>,
    @InjectRepository(SeatEntity)
    private readonly seatsRepo: Repository<SeatEntity>,
    @InjectRepository(SeatCategoryEntity)
    private readonly categoryRepo: Repository<SeatCategoryEntity>,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Create a screening + auto-generate ScreeningSeat rows for every active
   * seat in the hall. Each seat's price is computed as:
   *
   *   screening.base_price_toman × category.base_price_multiplier
   *
   * This is the PRICE SNAPSHOT mentioned in PRD §5.3 - subsequent changes
   * to base_price_toman or category multipliers do NOT retro-edit these
   * rows, so historical sales see consistent prices.
   *
   * The DB-level EXCLUDE constraint (migration 0001) catches any overlap
   * race condition between two concurrent create() calls in the same hall.
   */
  async create(dto: CreateScreeningDto): Promise<ScreeningResponseDto> {
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt <= startsAt) {
      throw BusinessError.unprocessable(
        'endsAt must be after startsAt',
        ERROR_CODES.VALIDATION,
      );
    }
    const salesOpensAt = dto.salesOpensAt ? new Date(dto.salesOpensAt) : new Date(startsAt.getTime() - 5 * 60 * 1000);
    if (salesOpensAt > startsAt) {
      throw BusinessError.unprocessable(
        'salesOpensAt must be at or before startsAt',
        ERROR_CODES.VALIDATION,
      );
    }

    // Validate FKs.
    const [movie, hall] = await Promise.all([
      this.movieRepo.findOne({ where: { id: dto.movieId } }),
      this.hallRepo.findOne({ where: { id: dto.hallId } }),
    ]);
    if (!movie || movie.status === 'Archived') {
      throw BusinessError.notFound(`Movie ${dto.movieId} not found`, ERROR_CODES.MOVIE_NOT_FOUND);
    }
    if (!hall || hall.status === 'Archived') {
      throw BusinessError.notFound(`Hall ${dto.hallId} not found`, ERROR_CODES.HALL_NOT_FOUND);
    }

    // Sanity: ensure screening ends before movie duration + setup buffer
    // (PRD §FR-03 rule 4: prep time must be considered).
    const setupBuffer = dto.setupBufferMinutes ?? 15;
    const movieMinutes = movie.durationMinutes;
    const minEnd = new Date(startsAt.getTime() + movieMinutes * 60 * 1000);
    if (endsAt < minEnd) {
      throw BusinessError.unprocessable(
        `endsAt must be at least ${movieMinutes}min after startsAt (movie duration)`,
        ERROR_CODES.VALIDATION,
      );
    }

    // Pull all active seats + categories for price computation.
    const seats = await this.seatsRepo.find({
      where: { hallId: hall.id, status: 'Active' as SeatStatus },
    });
    const categoryIds = Array.from(new Set(seats.map((s) => s.categoryId)));
    const categories = await this.categoryRepo.find({
      where: { id: In(categoryIds) },
    });
    const catMultById = new Map(categories.map((c) => [c.id, Number(c.basePriceMultiplier)]));

    return await this.dataSource.transaction(async (manager) => {
      const screeningRepo = manager.getRepository(ScreeningEntity);
      const seatRepo = manager.getRepository(ScreeningSeatEntity);

      const screening = screeningRepo.create({
        movieId: movie.id,
        hallId: hall.id,
        startsAt,
        endsAt,
        salesOpensAt,
        setupBufferMinutes: setupBuffer,
        status: dto.status ?? 'Draft',
        basePriceToman: dto.basePriceToman,
      });

      // This save() will trip the EXCLUDE constraint if a screening in
      // the same hall already overlaps (or if another tx commits first).
      const saved = await screeningRepo.save(screening);
      this.logger.log(`Created screening ${saved.id} hall=${hall.id} starts=${startsAt.toISOString()}`);

      // Pre-generate ScreeningSeat rows for every active seat in the hall.
      // This avoids per-screening-seat lazy creation during checkout and
      // makes the screening's seat map a stable snapshot.
      if (seats.length > 0) {
        const screeningSeats: ScreeningSeatEntity[] = seats.map((seat) => {
          const mult = catMultById.get(seat.categoryId) ?? 1.0;
          const price = Math.max(0, Math.round(Number(dto.basePriceToman) * mult));
          return seatRepo.create({
            screeningId: saved.id,
            seatId: seat.id,
            price,
            saleStatus: 'Available' as ScreeningSeatStatus,
          });
        });
        await seatRepo.save(screeningSeats);
        this.logger.log(`Generated ${screeningSeats.length} screening seats for ${saved.id}`);
      }

      return ScreeningResponseDto.from(saved);
    });
  }

  async findOne(id: string): Promise<ScreeningResponseDto> {
    const screening = await this.screeningRepo.findOne({ where: { id } });
    if (!screening) {
      throw BusinessError.notFound(
        `Screening ${id} not found`,
        ERROR_CODES.SCREENING_NOT_FOUND,
      );
    }
    return ScreeningResponseDto.from(screening);
  }

  async list(query: ListScreeningsQueryDto): Promise<{ items: ScreeningResponseDto[]; total: number; page: number; pageSize: number }> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.screeningRepo.createQueryBuilder('s');

    if (query.movieId) qb.andWhere('s.movie_id = :movieId', { movieId: query.movieId });
    if (query.hallId) qb.andWhere('s.hall_id = :hallId', { hallId: query.hallId });
    if (query.status) qb.andWhere('s.status = :status', { status: query.status });
    if (query.startsAfter) qb.andWhere('s.starts_at > :after', { after: new Date(query.startsAfter) });

    qb.orderBy('s.starts_at', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize);
    const [items, total] = await qb.getManyAndCount();
    return {
      items: items.map(ScreeningResponseDto.from),
      total,
      page,
      pageSize,
    };
  }

  /**
   * Update a screening's metadata. Time changes are allowed only while
   * status=Draft; the EXCLUDE constraint still catches overlaps in DB.
   */
  async update(id: string, dto: UpdateScreeningDto): Promise<ScreeningResponseDto> {
    const screening = await this.screeningRepo.findOne({ where: { id } });
    if (!screening) {
      throw BusinessError.notFound(`Screening ${id} not found`, ERROR_CODES.SCREENING_NOT_FOUND);
    }
    if (screening.status === 'Cancelled' || screening.status === 'Completed') {
      throw BusinessError.conflict(
        `Cannot update screening in ${screening.status} state`,
        ERROR_CODES.VALIDATION,
      );
    }
    if (dto.startsAt) screening.startsAt = new Date(dto.startsAt);
    if (dto.endsAt) screening.endsAt = new Date(dto.endsAt);
    if (screening.endsAt <= screening.startsAt) {
      throw BusinessError.unprocessable('endsAt must be after startsAt', ERROR_CODES.VALIDATION);
    }
    if (dto.salesOpensAt) screening.salesOpensAt = new Date(dto.salesOpensAt);
    if (screening.salesOpensAt > screening.startsAt) {
      throw BusinessError.unprocessable('salesOpensAt must be at or before startsAt', ERROR_CODES.VALIDATION);
    }
    if (dto.setupBufferMinutes !== undefined) screening.setupBufferMinutes = dto.setupBufferMinutes;
    if (dto.basePriceToman !== undefined) {
      // Note: changing base_price does NOT retro-update existing
      // ScreeningSeat.price (snapshot stays) - new prices apply to
      // newly generated screening_seats only (PRD §5.3).
      screening.basePriceToman = dto.basePriceToman;
    }
    if (dto.status) screening.status = dto.status;

    const saved = await this.screeningRepo.save(screening);
    return ScreeningResponseDto.from(saved);
  }

  /**
   * Cancel a screening. Marks it as Cancelled; existing reservations on
   * this screening should be auto-refunded by the cancellation job
   * (added in CancellationModule). ScreeningSeat rows stay for audit.
   */
  async cancel(id: string, dto: CancelScreeningDto): Promise<ScreeningResponseDto> {
    const screening = await this.screeningRepo.findOne({ where: { id } });
    if (!screening) {
      throw BusinessError.notFound(`Screening ${id} not found`, ERROR_CODES.SCREENING_NOT_FOUND);
    }
    if (screening.status === 'Cancelled') {
      return ScreeningResponseDto.from(screening);
    }
    if (screening.status === 'Completed') {
      throw BusinessError.conflict('Cannot cancel completed screening', ERROR_CODES.VALIDATION);
    }
    screening.status = 'Cancelled' as ScreeningStatus;
    screening.cancelledAt = new Date();
    screening.cancelReason = dto.reason ?? null;
    const saved = await this.screeningRepo.save(screening);

    // Bulk-block all not-yet-sold screening seats so customers can't start
    // new reservations while refunds are processed.
    await this.seatRepo.update(
      { screeningId: id, saleStatus: 'Available' as ScreeningSeatStatus },
      { saleStatus: 'Blocked' as ScreeningSeatStatus, blockReason: 'Screening cancelled' },
    );
    return ScreeningResponseDto.from(saved);
  }

  /**
   * Get the screening's seat map with current sale status. Used by customer
   * UI when picking seats (PRD §FR-04 step 3 - show seat map).
   */
  async getSeatMap(screeningId: string): Promise<ScreeningSeatResponseDto[]> {
    const screening = await this.screeningRepo.findOne({ where: { id: screeningId } });
    if (!screening) {
      throw BusinessError.notFound(`Screening ${screeningId} not found`, ERROR_CODES.SCREENING_NOT_FOUND);
    }
    const seats = await this.seatRepo.find({
      where: { screeningId },
      order: { seat: { rowLabel: 'ASC', seatNumber: 'ASC' } } as never,
    });
    // Manual sort because TypeORM nested ordering through @ManyToOne is finicky.
    // Fetch via repository with relations to sort by seat.rowLabel.
    const withRels = await this.seatRepo.find({
      where: { screeningId },
      relations: ['seat'],
    });
    withRels.sort((a, b) => {
      const ra = a.seat?.rowLabel ?? '';
      const rb = b.seat?.rowLabel ?? '';
      if (ra !== rb) return ra.localeCompare(rb);
      return (a.seat?.seatNumber ?? 0) - (b.seat?.seatNumber ?? 0);
    });
    void seats; // suppress unused warning
    return withRels.map((s) =>
      ScreeningSeatResponseDto.from({
        id: s.id,
        screeningId: s.screeningId,
        seatId: s.seatId,
        price: s.price,
        saleStatus: s.saleStatus,
        blockReason: s.blockReason ?? null,
      }),
    );
  }
}
