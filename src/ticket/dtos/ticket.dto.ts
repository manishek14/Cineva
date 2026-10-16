import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { TicketStatus } from '../entities/ticket.entity';

export class ScanTicketDto {
  @ApiProperty({ description: 'The QR token (returned at ticket issuance)' })
  @IsString()
  @MinLength(16)
  @MaxLength(128)
  qrToken!: string;

  @ApiPropertyOptional({ description: 'Gate attendant user id (auto from JWT)' })
  @IsOptional()
  @IsUUID()
  gateAttendantId?: string;
}

export class TicketResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() reservationSeatId!: string;
  @ApiProperty() publicCode!: string;
  @ApiProperty() status!: TicketStatus;
  @ApiPropertyOptional() usedAt?: string | null;
  @ApiPropertyOptional() qrToken?: string; // only on issue - never returned after
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;

  static from(e: {
    id: string;
    reservationSeatId: string;
    publicCode: string;
    status: TicketStatus;
    usedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
    qrToken?: string;
  }): TicketResponseDto {
    const dto = new TicketResponseDto();
    dto.id = e.id;
    dto.reservationSeatId = e.reservationSeatId;
    dto.publicCode = e.publicCode;
    dto.status = e.status;
    dto.usedAt = e.usedAt ? e.usedAt.toISOString() : null;
    dto.qrToken = e.qrToken;
    dto.createdAt = e.createdAt.toISOString();
    dto.updatedAt = e.updatedAt.toISOString();
    return dto;
  }
}

export class ScanResultDto {
  @ApiProperty() success!: boolean;
  @ApiProperty() ticketId!: string;
  @ApiProperty() publicCode!: string;
  @ApiProperty() status!: TicketStatus;
  @ApiPropertyOptional() message?: string;
  @ApiPropertyOptional({ description: 'Movie / hall / seat info for display' })
  screening?: {
    movieTitle: string;
    hallName: string;
    startsAt: string;
    rowLabel: string;
    seatNumber: number;
  };
}
