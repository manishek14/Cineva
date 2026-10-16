import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { SeatCategoryStatus } from '../entities/seat-category.entity';
import type { SeatCategoryEntity } from '../entities/seat-category.entity';

const STATUSES: readonly SeatCategoryStatus[] = ['Active', 'Archived'];

export class CreateSeatCategoryDto {
  @ApiProperty({ example: 'VIP' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'VIP', description: 'Stable short code, unique' })
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  code!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 1.5, default: 1.0 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99.99)
  basePriceMultiplier?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  displayOrder?: number;
}

export class UpdateSeatCategoryDto {
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
  @MaxLength(16)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(99.99)
  basePriceMultiplier?: number;

  @ApiPropertyOptional({ enum: STATUSES })
  @IsOptional()
  @IsIn(STATUSES as readonly string[])
  status?: SeatCategoryStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsInt()
  @Min(0)
  displayOrder?: number;
}

export class SeatCategoryResponseDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  name!: string;
  @ApiProperty()
  code!: string;
  @ApiPropertyOptional()
  description?: string | null;
  @ApiProperty()
  basePriceMultiplier!: number;
  @ApiProperty()
  status!: SeatCategoryStatus;
  @ApiProperty()
  displayOrder!: number;
  @ApiProperty()
  createdAt!: string;
  @ApiProperty()
  updatedAt!: string;

  static from(entity: SeatCategoryEntity): SeatCategoryResponseDto {
    const dto = new SeatCategoryResponseDto();
    dto.id = entity.id;
    dto.name = entity.name;
    dto.code = entity.code;
    dto.description = entity.description ?? null;
    dto.basePriceMultiplier = Number(entity.basePriceMultiplier);
    dto.status = entity.status;
    dto.displayOrder = entity.displayOrder;
    dto.createdAt = entity.createdAt.toISOString();
    dto.updatedAt = entity.updatedAt.toISOString();
    return dto;
  }
}
