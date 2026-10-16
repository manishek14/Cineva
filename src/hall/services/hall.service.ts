import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import { Injectable, Logger } from '@nestjs/common';
import { CinemaHallEntity } from '../entities/cinema-hall.entity';
import { SeatEntity } from '../entities/seat.entity';
import {
  CinemaHallResponseDto,
  CreateCinemaHallDto,
  UpdateCinemaHallDto,
} from '../dtos/hall.dto';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';

@Injectable()
export class HallService {
  private readonly logger = new Logger(HallService.name);

  constructor(
    @InjectRepository(CinemaHallEntity)
    private readonly hallRepo: Repository<CinemaHallEntity>,
    @InjectRepository(SeatEntity)
    private readonly seatRepo: Repository<SeatEntity>,
    private readonly dataSource: DataSource,
  ) {}

  async create(dto: CreateCinemaHallDto): Promise<CinemaHallResponseDto> {
    const slug = dto.slug.trim().toLowerCase();
    const existing = await this.hallRepo.findOne({ where: { slug } });
    if (existing) {
      throw BusinessError.conflict(
        `Hall slug "${slug}" already exists`,
        ERROR_CODES.VALIDATION,
      );
    }
    const hall = this.hallRepo.create({
      name: dto.name,
      slug,
      description: dto.description,
      status: 'Active',
      totalCapacity: 0,
    });
    const saved = await this.hallRepo.save(hall);
    return CinemaHallResponseDto.from(saved);
  }

  async findOne(id: string): Promise<CinemaHallResponseDto> {
    const hall = await this.hallRepo.findOne({ where: { id } });
    if (!hall || hall.status === 'Archived') {
      throw BusinessError.notFound(`Hall ${id} not found`, ERROR_CODES.HALL_NOT_FOUND);
    }
    return CinemaHallResponseDto.from(hall);
  }

  async list(): Promise<CinemaHallResponseDto[]> {
    const items = await this.hallRepo.find({
      where: { status: 'Active' as const },
      order: { name: 'ASC' },
    });
    return items.map(CinemaHallResponseDto.from);
  }

  async update(id: string, dto: UpdateCinemaHallDto): Promise<CinemaHallResponseDto> {
    const hall = await this.hallRepo.findOne({ where: { id } });
    if (!hall || hall.status === 'Archived') {
      throw BusinessError.notFound(`Hall ${id} not found`, ERROR_CODES.HALL_NOT_FOUND);
    }
    if (dto.slug && dto.slug !== hall.slug) {
      const dupe = await this.hallRepo.findOne({ where: { slug: dto.slug } });
      if (dupe) {
        throw BusinessError.conflict(
          `Slug "${dto.slug}" already in use`,
          ERROR_CODES.VALIDATION,
        );
      }
      hall.slug = dto.slug;
    }
    if (dto.name) hall.name = dto.name;
    if (dto.description !== undefined) hall.description = dto.description;
    if (dto.status) hall.status = dto.status;
    if (hall.status === 'Archived' && !hall.archivedAt) hall.archivedAt = new Date();
    if (hall.status === 'Active') hall.archivedAt = null;
    const saved = await this.hallRepo.save(hall);
    return CinemaHallResponseDto.from(saved);
  }

  async archive(id: string): Promise<void> {
    const hall = await this.hallRepo.findOne({ where: { id } });
    if (!hall) {
      throw BusinessError.notFound(`Hall ${id} not found`, ERROR_CODES.HALL_NOT_FOUND);
    }
    if (hall.status === 'Archived') return;
    hall.status = 'Archived';
    hall.archivedAt = new Date();
    await this.hallRepo.save(hall);
  }

  /**
   * Recompute total capacity from active seats. Called by SeatService after
   * bulk upsert or maintenance toggle.
   */
  async recalcCapacity(hallId: string): Promise<number> {
    const active = await this.seatRepo.count({
      where: { hallId, status: Not('Removed' as never) },
    });
    await this.hallRepo.update({ id: hallId }, { totalCapacity: active });
    return active;
  }
}
