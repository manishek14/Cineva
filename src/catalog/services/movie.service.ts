import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Injectable, Logger } from '@nestjs/common';
import { MovieEntity, type MovieStatus } from '../entities/movie.entity';
import {
  CreateMovieDto,
  UpdateMovieDto,
  ListMoviesQueryDto,
  PaginatedMoviesDto,
  MovieResponseDto,
} from '../dtos/movie.dto';
import { BusinessError } from '../../common/utils';
import { ERROR_CODES } from '../../common/constants/error-codes';

@Injectable()
export class MovieService {
  private readonly logger = new Logger(MovieService.name);

  constructor(
    @InjectRepository(MovieEntity)
    private readonly repo: Repository<MovieEntity>,
  ) {}

  async create(dto: CreateMovieDto): Promise<MovieResponseDto> {
    const movie = this.repo.create({
      title: dto.title,
      description: dto.description,
      durationMinutes: dto.durationMinutes,
      ageRating: dto.ageRating,
      posterUrl: dto.posterUrl,
      status: dto.status ?? 'Draft',
    });
    const saved = await this.repo.save(movie);
    this.logger.log(`Created movie id=${saved.id} title="${saved.title}"`);
    return MovieResponseDto.from(saved);
  }

  async findOne(id: string, includeArchived = false): Promise<MovieResponseDto> {
    const movie = await this.repo.findOne({ where: { id } });
    if (!movie || (!includeArchived && movie.status === 'Archived')) {
      throw BusinessError.notFound(`Movie ${id} not found`, ERROR_CODES.MOVIE_NOT_FOUND);
    }
    return MovieResponseDto.from(movie);
  }

  async list(query: ListMoviesQueryDto): Promise<PaginatedMoviesDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.repo.createQueryBuilder('m');

    if (query.status) {
      qb.andWhere('m.status = :status', { status: query.status });
    } else {
      // Default: hide archived unless explicitly requested.
      qb.andWhere('m.status != :archived', { archived: 'Archived' });
    }
    qb.orderBy('m.title', 'ASC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [items, total] = await qb.getManyAndCount();
    return {
      items: items.map(MovieResponseDto.from),
      total,
      page,
      pageSize,
    };
  }

  async update(id: string, dto: UpdateMovieDto): Promise<MovieResponseDto> {
    const movie = await this.repo.findOne({ where: { id } });
    if (!movie || movie.status === 'Archived') {
      throw BusinessError.notFound(`Movie ${id} not found`, ERROR_CODES.MOVIE_NOT_FOUND);
    }
    Object.assign(movie, dto);
    const saved = await this.repo.save(movie);
    return MovieResponseDto.from(saved);
  }

  /**
   * Soft-archive: never hard-delete a movie that has screenings or sales.
   * The repository should check upstream dependencies (active screenings)
   * BEFORE allowing archive; this method just flips status + archivedAt.
   * (PRD §FR-01: "غیرفعال‌سازی یا آرشیوکردن گزینه مناسب‌تری است")
   */
  async archive(id: string): Promise<void> {
    const movie = await this.repo.findOne({ where: { id } });
    if (!movie) {
      throw BusinessError.notFound(`Movie ${id} not found`, ERROR_CODES.MOVIE_NOT_FOUND);
    }
    if (movie.status === 'Archived') return; // idempotent
    movie.status = 'Archived' as MovieStatus;
    movie.archivedAt = new Date();
    await this.repo.save(movie);
  }

  async restore(id: string): Promise<void> {
    const movie = await this.repo.findOne({ where: { id } });
    if (!movie) {
      throw BusinessError.notFound(`Movie ${id} not found`, ERROR_CODES.MOVIE_NOT_FOUND);
    }
    if (movie.status !== 'Archived') return;
    movie.status = 'Draft';
    movie.archivedAt = null;
    await this.repo.save(movie);
  }
}
