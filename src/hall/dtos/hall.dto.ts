import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
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
import { CinemaHallStatus } from '../entities/cinema-hall.entity';
import type { CinemaHallEntity } from '../entities/cinema-hall.entity';

const STATUSES: readonly CinemaHallStatus[] = ['Active', 'Archived'];

export class CreateCinemaHallDto {
  @ApiProperty({ example: 'Salon 1' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'salon-1' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  slug!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class UpdateCinemaHallDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES as readonly string[])
  status?: CinemaHallStatus;
}

export class CinemaHallResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() slug!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty() status!: CinemaHallStatus;
  @ApiProperty() totalCapacity!: number;
  @ApiPropertyOptional() archivedAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;

  static from(e: CinemaHallEntity): CinemaHallResponseDto {
    const dto = new CinemaHallResponseDto();
    dto.id = e.id;
    dto.name = e.name;
    dto.slug = e.slug;
    dto.description = e.description ?? null;
    dto.status = e.status;
    dto.totalCapacity = e.totalCapacity;
    dto.archivedAt = e.archivedAt ? e.archivedAt.toISOString() : null;
    dto.createdAt = e.createdAt.toISOString();
    dto.updatedAt = e.updatedAt.toISOString();
    return dto;
  }
}

export class SeatPositionDto {
  @ApiProperty({ minimum: 0, maximum: 1 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  x!: number;

  @ApiProperty({ minimum: 0, maximum: 1 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  y!: number;
}

export class SeatDto {
  @ApiProperty() hallId!: string;
  @ApiProperty() categoryId!: string;
  @ApiProperty({ example: 'A' })
  @IsString()
  @MinLength(1)
  @MaxLength(8)
  rowLabel!: string;

  @ApiProperty({ example: 1, minimum: 1 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @Type(() => Number)
  @IsInt()
  @Min(1)
  seatNumber!: number;

  @ApiProperty({ minimum: 0, maximum: 1 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  positionX!: number;

  @ApiProperty({ minimum: 0, maximum: 1 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  positionY!: number;
}

export class BulkSeatUpsertDto {
  @ApiProperty({ type: () => [SeatDto] })
  seats!: SeatDto[];
}

export class SeatResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() hallId!: string;
  @ApiProperty() categoryId!: string;
  @ApiProperty() rowLabel!: string;
  @ApiProperty() seatNumber!: number;
  @ApiProperty() positionX!: number;
  @ApiProperty() positionY!: number;
  @ApiProperty() status!: 'Active' | 'Maintenance' | 'Removed';
  @ApiPropertyOptional() maintenanceReason?: string | null;

  static from(e: {
    id: string;
    hallId: string;
    categoryId: string;
    rowLabel: string;
    seatNumber: number;
    positionX: number | string;
    positionY: number | string;
    status: 'Active' | 'Maintenance' | 'Removed';
    maintenanceReason?: string | null;
  }): SeatResponseDto {
    const dto = new SeatResponseDto();
    dto.id = e.id;
    dto.hallId = e.hallId;
    dto.categoryId = e.categoryId;
    dto.rowLabel = e.rowLabel;
    dto.seatNumber = e.seatNumber;
    dto.positionX = Number(e.positionX);
    dto.positionY = Number(e.positionY);
    dto.status = e.status;
    dto.maintenanceReason = e.maintenanceReason ?? null;
    return dto;
  }
}
