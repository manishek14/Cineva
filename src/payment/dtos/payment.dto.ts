import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { Type } from 'class-transformer';
import type { PaymentStatus } from '../entities/payment.entity';

const STATUSES: readonly PaymentStatus[] = [
  'Initiated',
  'Pending',
  'Succeeded',
  'Failed',
  'Cancelled',
  'RefundPending',
  'Refunded',
];

export class InitiatePaymentDto {
  @ApiProperty()
  @IsUUID()
  reservationId!: string;

  @ApiPropertyOptional({ description: 'Idempotency key (auto-generated if omitted)' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  idempotencyKey?: string;
}

export class PaymentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() reservationId!: string;
  @ApiProperty() provider!: string;
  @ApiProperty() amount!: number;
  @ApiProperty() currency!: string;
  @ApiProperty() status!: PaymentStatus;
  @ApiPropertyOptional() gatewayRedirectUrl?: string | null;
  @ApiPropertyOptional() providerReference?: string | null;
  @ApiPropertyOptional() failureReason?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;

  static from(e: {
    id: string;
    reservationId: string;
    provider: string;
    amount: number | string;
    currency: string;
    status: PaymentStatus;
    gatewayRedirectUrl?: string | null;
    providerReference?: string | null;
    failureReason?: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): PaymentResponseDto {
    const dto = new PaymentResponseDto();
    dto.id = e.id;
    dto.reservationId = e.reservationId;
    dto.provider = e.provider;
    dto.amount = Number(e.amount);
    dto.currency = e.currency;
    dto.status = e.status;
    dto.gatewayRedirectUrl = e.gatewayRedirectUrl ?? null;
    dto.providerReference = e.providerReference ?? null;
    dto.failureReason = e.failureReason ?? null;
    dto.createdAt = e.createdAt.toISOString();
    dto.updatedAt = e.updatedAt.toISOString();
    return dto;
  }
}

export class CallbackResultDto {
  @ApiProperty() success!: boolean;
  @ApiProperty() paymentId!: string;
  @ApiProperty() status!: PaymentStatus;
  @ApiPropertyOptional() redirectUrl?: string;
  @ApiPropertyOptional() message?: string;
}
