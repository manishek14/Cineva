import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { ReservationStatus } from '../entities/reservation.entity';
import type { ReservationSeatStatus } from '../entities/reservation-seat.entity';

export class CreateReservationDto {
  @ApiProperty()
  @IsUUID()
  screeningId!: string;

  @ApiProperty({
    type: () => [String],
    description: 'Screening-seat IDs (from GET /screenings/:id/seat-map)',
    minItems: 1,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsString({ each: true })
  @IsUUID('all', { each: true })
  screeningSeatIds!: string[];

  @ApiPropertyOptional({ description: 'Required if customer is not logged in' })
  @IsOptional()
  @IsString()
  @MaxLength(16)
  guestPhone?: string;
}

export class ExtendReservationDto {
  @ApiPropertyOptional({ default: 'extend TTL by 10 min' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(60)
  additionalMinutes?: number;
}

export class ReservationSeatResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() reservationId!: string;
  @ApiProperty() screeningSeatId!: string;
  @ApiProperty() unitPrice!: number;
  @ApiProperty() status!: ReservationSeatStatus;
}

export class ReservationResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() customerId?: string | null;
  @ApiPropertyOptional() guestPhone?: string | null;
  @ApiProperty() screeningId!: string;
  @ApiProperty() status!: ReservationStatus;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() currency!: string;
  @ApiPropertyOptional() expiresAt?: string | null;
  @ApiPropertyOptional() confirmedAt?: string | null;
  @ApiPropertyOptional() cancelledAt?: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ type: () => [ReservationSeatResponseDto] })
  seats!: ReservationSeatResponseDto[];

  static from(
    reservation: {
      id: string;
      customerId?: string | null;
      guestPhone?: string | null;
      screeningId: string;
      status: ReservationStatus;
      totalAmount: number | string;
      currency: string;
      expiresAt?: Date | null;
      confirmedAt?: Date | null;
      cancelledAt?: Date | null;
      createdAt: Date;
      updatedAt: Date;
      seats?: {
        id: string;
        reservationId: string;
        screeningSeatId: string;
        unitPrice: number | string;
        status: ReservationSeatStatus;
      }[];
    },
  ): ReservationResponseDto {
    const dto = new ReservationResponseDto();
    dto.id = reservation.id;
    dto.customerId = reservation.customerId ?? null;
    dto.guestPhone = reservation.guestPhone ?? null;
    dto.screeningId = reservation.screeningId;
    dto.status = reservation.status;
    dto.totalAmount = Number(reservation.totalAmount);
    dto.currency = reservation.currency;
    dto.expiresAt = reservation.expiresAt ? reservation.expiresAt.toISOString() : null;
    dto.confirmedAt = reservation.confirmedAt ? reservation.confirmedAt.toISOString() : null;
    dto.cancelledAt = reservation.cancelledAt ? reservation.cancelledAt.toISOString() : null;
    dto.createdAt = reservation.createdAt.toISOString();
    dto.updatedAt = reservation.updatedAt.toISOString();
    dto.seats = (reservation.seats ?? []).map((s) => ({
      id: s.id,
      reservationId: s.reservationId,
      screeningSeatId: s.screeningSeatId,
      unitPrice: Number(s.unitPrice),
      status: s.status,
    }));
    return dto;
  }
}
