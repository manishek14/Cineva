import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { AgeRating, MovieStatus } from '../entities/movie.entity';
import type { MovieEntity } from '../entities/movie.entity';

const AGE_RATINGS: readonly AgeRating[] = ['ALL', '+3', '+7', '+12', '+15', '+16', '+18'];
const STATUSES: readonly MovieStatus[] = ['Draft', 'Published', 'Archived'];

export class CreateMovieDto {
  @ApiProperty({ example: 'The Matrix', minLength: 1, maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({ example: 'A computer hacker learns...' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ example: 136, description: 'Duration in minutes, must be > 0' })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @Type(() => Number)
  @IsInt()
  @Min(1)
  durationMinutes!: number;

  @ApiProperty({ enum: AGE_RATINGS, default: 'ALL' })
  @IsIn(AGE_RATINGS as readonly string[])
  ageRating!: AgeRating;

  @ApiPropertyOptional({ example: 'https://cdn.cineva.local/matrix.jpg' })
  @IsOptional()
  @IsUrl()
  posterUrl?: string;

  @ApiPropertyOptional({ enum: STATUSES, default: 'Draft' })
  @IsOptional()
  @IsIn(STATUSES as readonly string[])
  status?: MovieStatus;
}

export class UpdateMovieDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Duration in minutes, must be > 0' })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  durationMinutes?: number;

  @ApiPropertyOptional({ enum: AGE_RATINGS })
  @IsOptional()
  @IsIn(AGE_RATINGS as readonly string[])
  ageRating?: AgeRating;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  posterUrl?: string;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES as readonly string[])
  status?: MovieStatus;
}

export class MovieResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiPropertyOptional()
  description?: string | null;

  @ApiProperty()
  durationMinutes!: number;

  @ApiProperty()
  ageRating!: AgeRating;

  @ApiPropertyOptional()
  posterUrl?: string | null;

  @ApiProperty()
  status!: MovieStatus;

  @ApiPropertyOptional()
  archivedAt?: string | null;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty()
  updatedAt!: string;

  static from(entity: MovieEntity): MovieResponseDto {
    const dto = new MovieResponseDto();
    dto.id = entity.id;
    dto.title = entity.title;
    dto.description = entity.description ?? null;
    dto.durationMinutes = entity.durationMinutes;
    dto.ageRating = entity.ageRating;
    dto.posterUrl = entity.posterUrl ?? null;
    dto.status = entity.status;
    dto.archivedAt = entity.archivedAt ? entity.archivedAt.toISOString() : null;
    dto.createdAt = entity.createdAt.toISOString();
    dto.updatedAt = entity.updatedAt.toISOString();
    return dto;
  }
}

export class ListMoviesQueryDto {
  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES as readonly string[])
  status?: MovieStatus;

  @ApiPropertyOptional({ default: 1 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

export class PaginatedMoviesDto {
  @ApiProperty({ type: () => [MovieResponseDto] })
  items!: MovieResponseDto[];
  @ApiProperty()
  total!: number;
  @ApiProperty()
  page!: number;
  @ApiProperty()
  pageSize!: number;
}
