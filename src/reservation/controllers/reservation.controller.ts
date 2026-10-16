import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ReservationService } from '../services/reservation.service';
import {
  CreateReservationDto,
  ExtendReservationDto,
  ReservationResponseDto,
} from '../dtos/reservation.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Public } from '../../common/decorators/public.decorator';
import type { RequestUser } from '../../auth/strategies/jwt.strategy';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@ApiTags('reservations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reservations')
export class ReservationController {
  constructor(private readonly reservations: ReservationService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a reservation + hold seats (atomic all-or-nothing)' })
  create(
    @Body() dto: CreateReservationDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ReservationResponseDto> {
    return this.reservations.createReservation(dto, user.id);
  }

  @Get('mine')
  @ApiOperation({ summary: 'List my reservations (most recent 50)' })
  listMine(@CurrentUser() user: RequestUser): Promise<ReservationResponseDto[]> {
    return this.reservations.listMine(user.id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a reservation by id (owner or staff)' })
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<ReservationResponseDto> {
    return this.reservations.findOne(id, user.id);
  }

  @Post(':id/extend')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Extend pending reservation TTL (cap enforced)' })
  extend(
    @Param('id') id: string,
    @Body() dto: ExtendReservationDto,
  ): Promise<ReservationResponseDto> {
    return this.reservations.extendTtl(id, dto);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a pending reservation (before payment)' })
  cancel(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<ReservationResponseDto> {
    return this.reservations.cancelPending(id, user.id);
  }
}
