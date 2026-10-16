import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type { RefundStatus } from '../entities/refund.entity';
import type { CancellationPolicyEntity } from '../entities/cancellation-policy.entity';

export class CreateCancellationPolicyDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ minimum: 0, maximum: 100, default: 15 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  penaltyPercent!: number;

  @ApiProperty({ minimum: 0, maximum: 100, default: 85 })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  refundPercent!: number;

  @ApiProperty({
    description: 'Min minutes before screening.startsAt for customer cancel. Floor: env-configurable (15min default).',
    minimum: 15,
    maximum: 1440,
    default: 30,
  })
  @Transform(({ value }: { value: unknown }) => Number(value))
  @Type(() => Number)
  @IsNumber()
  @Min(15)
  @Max(1440)
  minMinutesBeforeScreening!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  customerCancelAllowed?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(0)
  sideFeeToman?: number;

  @ApiPropertyOptional({ description: 'ISO date when policy becomes effective (default: now)' })
  @IsOptional()
  @IsString()
  validFrom?: string;
}

export class UpdateCancellationPolicyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  penaltyPercent?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  refundPercent?: number;

  @ApiPropertyOptional({ minimum: 15, maximum: 1440 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber()
  @Min(15)
  @Max(1440)
  minMinutesBeforeScreening?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  customerCancelAllowed?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => Number(value))
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(0)
  sideFeeToman?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CancellationPolicyResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiProperty() penaltyPercent!: number;
  @ApiProperty() refundPercent!: number;
  @ApiProperty() minMinutesBeforeScreening!: number;
  @ApiProperty() customerCancelAllowed!: boolean;
  @ApiProperty() sideFeeToman!: number;
  @ApiProperty() validFrom!: string;
  @ApiProperty() isActive!: boolean;

  static from(e: CancellationPolicyEntity): CancellationPolicyResponseDto {
    const dto = new CancellationPolicyResponseDto();
    dto.id = e.id;
    dto.name = e.name;
    dto.description = e.description ?? null;
    dto.penaltyPercent = Number(e.penaltyPercent);
    dto.refundPercent = Number(e.refundPercent);
    dto.minMinutesBeforeScreening = e.minMinutesBeforeScreening;
    dto.customerCancelAllowed = e.customerCancelAllowed;
    dto.sideFeeToman = Number(e.sideFeeToman);
    dto.validFrom = e.validFrom.toISOString();
    dto.isActive = e.isActive;
    return dto;
  }
}

export class CancelReservationDto {
  @ApiPropertyOptional({ description: 'Idempotency key (auto-generated if omitted)' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

export class RefundResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() paymentId!: string;
  @ApiProperty() refundableAmount!: number;
  @ApiProperty() refundedAmount!: number;
  @ApiProperty() penaltyAmount!: number;
  @ApiProperty() status!: RefundStatus;
  @ApiPropertyOptional() providerReference?: string | null;
  @ApiPropertyOptional() cancellationPolicyId?: string | null;
  @ApiPropertyOptional() reason?: string | null;
  @ApiProperty() createdAt!: string;

  static from(e: {
    id: string;
    paymentId: string;
    refundableAmount: number | string;
    refundedAmount: number | string;
    penaltyAmount: number | string;
    status: RefundStatus;
    providerReference?: string | null;
    cancellationPolicyId?: string | null;
    reason?: string | null;
    createdAt: Date;
  }): RefundResponseDto {
    const dto = new RefundResponseDto();
    dto.id = e.id;
    dto.paymentId = e.paymentId;
    dto.refundableAmount = Number(e.refundableAmount);
    dto.refundedAmount = Number(e.refundedAmount);
    dto.penaltyAmount = Number(e.penaltyAmount);
    dto.status = e.status;
    dto.providerReference = e.providerReference ?? null;
    dto.cancellationPolicyId = e.cancellationPolicyId ?? null;
    dto.reason = e.reason ?? null;
    dto.createdAt = e.createdAt.toISOString();
    return dto;
  }
}
