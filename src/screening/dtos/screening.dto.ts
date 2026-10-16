import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ScreeningStatus } from '../entities/screening.entity';
import type { ScreeningEntity } from '../entities/screening.entity';

const STATUSES: readonly ScreeningStatus[] = ['Draft', 'Published', 'Cancelled', 'Completed'];

export class CreateScreeningDto {
  @ApiProperty()
  @IsString()
  movieId!: string;

  @ApiProperty()
  @IsString()
  hallId!: string;

  @ApiProperty({ example: '2026-10-20T18:00:00.000Z', format: 'date-time' })
  @IsDateString()
  startsAt!: string;

  @ApiProperty({ example: '2026-10-20T19:30:00.000Z', format: 'date-time' })
  @IsDateString()
  endsAt!: string;

  @ApiPropertyOptional({
    default: '5 minutes before startsAt',
    description: 'Earliest time tickets can be sold (defaults to startsAt - 5min)',
  })
  @IsOptional()
  @IsDateString()
  salesOpensAt?: string;

  @ApiPropertyOptional({ default: 15 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(120)
  setupBufferMinutes?: number;

  @ApiProperty({ example: 200000, description: 'Base price in Iranian Toman' })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(0)
  basePriceToman!: number;

  @ApiPropertyOptional({ enum: STATUSES, default: 'Draft' })
  @IsOptional()
  @IsIn(STATUSES as readonly string[])
  status?: ScreeningStatus;
}

export class UpdateScreeningDto {
  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  salesOpensAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  @Max(120)
  setupBufferMinutes?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(0)
  basePriceToman?: number;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES as readonly string[])
  status?: ScreeningStatus;
}

export class CancelScreeningDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason?: string;
}

export class ScreeningResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() movieId!: string;
  @ApiProperty() hallId!: string;
  @ApiProperty() startsAt!: string;
  @ApiProperty() endsAt!: string;
  @ApiProperty() salesOpensAt!: string;
  @ApiProperty() setupBufferMinutes!: number;
  @ApiProperty() status!: ScreeningStatus;
  @ApiProperty() basePriceToman!: number;
  @ApiPropertyOptional() cancelledAt?: string | null;
  @ApiPropertyOptional() cancelReason?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;

  static from(e: ScreeningEntity): ScreeningResponseDto {
    const dto = new ScreeningResponseDto();
    dto.id = e.id;
    dto.movieId = e.movieId;
    dto.hallId = e.hallId;
    dto.startsAt = e.startsAt.toISOString();
    dto.endsAt = e.endsAt.toISOString();
    dto.salesOpensAt = e.salesOpensAt.toISOString();
    dto.setupBufferMinutes = e.setupBufferMinutes;
    dto.status = e.status;
    dto.basePriceToman = Number(e.basePriceToman);
    dto.cancelledAt = e.cancelledAt ? e.cancelledAt.toISOString() : null;
    dto.cancelReason = e.cancelReason ?? null;
    dto.createdAt = e.createdAt.toISOString();
    dto.updatedAt = e.updatedAt.toISOString();
    return dto;
  }
}

export class ScreeningSeatResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() screeningId!: string;
  @ApiProperty() seatId!: string;
  @ApiProperty() price!: number;
  @ApiProperty() saleStatus!: 'Available' | 'Held' | 'Sold' | 'Blocked';
  @ApiPropertyOptional() blockReason?: string | null;

  static from(e: {
    id: string;
    screeningId: string;
    seatId: string;
    price: number | string;
    saleStatus: 'Available' | 'Held' | 'Sold' | 'Blocked';
    blockReason?: string | null;
  }): ScreeningSeatResponseDto {
    const dto = new ScreeningSeatResponseDto();
    dto.id = e.id;
    dto.screeningId = e.screeningId;
    dto.seatId = e.seatId;
    dto.price = Number(e.price);
    dto.saleStatus = e.saleStatus;
    dto.blockReason = e.blockReason ?? null;
    return dto;
  }
}

export class ListScreeningsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  movieId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  hallId?: string;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES as readonly string[])
  status?: ScreeningStatus;

  @ApiPropertyOptional({ description: 'ISO date - show only screenings starting after this' })
  @IsOptional()
  @IsDateString()
  startsAfter?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}
