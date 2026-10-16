import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Injectable, Logger } from '@nestjs/common';
import { SeatCategoryEntity } from '../entities/seat-category.entity';
import {
  CreateSeatCategoryDto,
  UpdateSeatCategoryDto,
  SeatCategoryResponseDto,
} from '../dtos/seat-category.dto';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';

@Injectable()
export class SeatCategoryService {
  private readonly logger = new Logger(SeatCategoryService.name);

  constructor(
    @InjectRepository(SeatCategoryEntity)
    private readonly repo: Repository<SeatCategoryEntity>,
  ) {}

  async create(dto: CreateSeatCategoryDto): Promise<SeatCategoryResponseDto> {
    const existing = await this.repo.findOne({ where: { code: dto.code } });
    if (existing) {
      throw BusinessError.conflict(
        `Seat category code "${dto.code}" already exists`,
        ERROR_CODES.VALIDATION,
      );
    }
    const entity = this.repo.create({
      name: dto.name,
      code: dto.code,
      description: dto.description,
      basePriceMultiplier: dto.basePriceMultiplier ?? 1.0,
      displayOrder: dto.displayOrder ?? 0,
      status: 'Active',
    });
    const saved = await this.repo.save(entity);
    this.logger.log(`Created seat category id=${saved.id} code=${saved.code}`);
    return SeatCategoryResponseDto.from(saved);
  }

  async findOne(id: string): Promise<SeatCategoryResponseDto> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity || entity.status === 'Archived') {
      throw BusinessError.notFound(`Seat category ${id} not found`, ERROR_CODES.VALIDATION);
    }
    return SeatCategoryResponseDto.from(entity);
  }

  async list(): Promise<SeatCategoryResponseDto[]> {
    const items = await this.repo.find({
      where: { status: 'Active' as const },
      order: { displayOrder: 'ASC', createdAt: 'ASC' },
    });
    return items.map(SeatCategoryResponseDto.from);
  }

  async update(id: string, dto: UpdateSeatCategoryDto): Promise<SeatCategoryResponseDto> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity || entity.status === 'Archived') {
      throw BusinessError.notFound(`Seat category ${id} not found`, ERROR_CODES.VALIDATION);
    }
    // Code changes are dangerous - many existing seats reference categories by id
    // not code, so a code change is safe at the catalog level but caller should
    // be aware. We allow it but log loudly.
    if (dto.code && dto.code !== entity.code) {
      this.logger.warn(`Seat category ${id} code change: ${entity.code} -> ${dto.code}`);
    }
    Object.assign(entity, dto);
    const saved = await this.repo.save(entity);
    return SeatCategoryResponseDto.from(saved);
  }

  async archive(id: string): Promise<void> {
    const entity = await this.repo.findOne({ where: { id } });
    if (!entity) {
      throw BusinessError.notFound(`Seat category ${id} not found`, ERROR_CODES.VALIDATION);
    }
    if (entity.status === 'Archived') return;
    entity.status = 'Archived';
    await this.repo.save(entity);
  }
}
