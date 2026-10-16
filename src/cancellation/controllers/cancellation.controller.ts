import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CancellationService } from '../services/cancellation.service';
import {
  CancelReservationDto,
  CancellationPolicyResponseDto,
  CreateCancellationPolicyDto,
  RefundResponseDto,
  UpdateCancellationPolicyDto,
} from '../dtos/cancellation.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ROLES } from '../../common/constants/state-machine';
import type { RequestUser } from '../../auth/strategies/jwt.strategy';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@ApiTags('cancellation')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('cancellation')
export class CancellationController {
  constructor(private readonly cancellations: CancellationService) {}

  @Post('policies')
  @Roles(ROLES.CINEMA_MANAGER)
  @ApiOperation({ summary: 'Create a cancellation policy (manager)' })
  createPolicy(@Body() dto: CreateCancellationPolicyDto): Promise<CancellationPolicyResponseDto> {
    return this.cancellations.createPolicy(dto);
  }

  @Get('policies')
  @Roles(ROLES.CINEMA_MANAGER)
  @ApiOperation({ summary: 'List all cancellation policies' })
  listPolicies(): Promise<CancellationPolicyResponseDto[]> {
    return this.cancellations.listPolicies();
  }

  @Patch('policies/:id')
  @Roles(ROLES.CINEMA_MANAGER)
  @ApiOperation({ summary: 'Update a cancellation policy (manager)' })
  updatePolicy(
    @Param('id') id: string,
    @Body() dto: UpdateCancellationPolicyDto,
  ): Promise<CancellationPolicyResponseDto> {
    return this.cancellations.updatePolicy(id, dto);
  }

  @Post('reservations/:reservationId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a confirmed reservation per active policy' })
  cancelReservation(
    @Param('reservationId') reservationId: string,
    @Body() dto: CancelReservationDto,
    @CurrentUser() user: RequestUser,
  ): Promise<RefundResponseDto> {
    return this.cancellations.cancelReservation(reservationId, dto, user.id);
  }

  @Get('reservations/:reservationId/refunds')
  @ApiOperation({ summary: 'List refunds for a reservation' })
  listRefunds(@Param('reservationId') reservationId: string): Promise<RefundResponseDto[]> {
    return this.cancellations.listRefundsByReservation(reservationId);
  }
}
