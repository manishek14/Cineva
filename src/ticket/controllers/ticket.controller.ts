import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TicketService } from '../services/ticket.service';
import { ScanResultDto, ScanTicketDto, TicketResponseDto } from '../dtos/ticket.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { ROLES } from '../../common/constants/state-machine';
import type { RequestUser } from '../../auth/strategies/jwt.strategy';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@ApiTags('tickets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('tickets')
export class TicketController {
  constructor(private readonly tickets: TicketService) {}

  @Get(':id')
  @ApiOperation({ summary: 'Get a ticket by id (no qrToken in response)' })
  findOne(@Param('id') id: string): Promise<TicketResponseDto> {
    return this.tickets.findOne(id);
  }

  @Get('reservation/:reservationId')
  @ApiOperation({ summary: 'List tickets for a reservation' })
  listForReservation(@Param('reservationId') reservationId: string): Promise<TicketResponseDto[]> {
    return this.tickets.listForReservation(reservationId);
  }

  @Post('scan')
  @Roles(ROLES.GATE_ATTENDANT, ROLES.CINEMA_OPERATOR, ROLES.CINEMA_MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Scan a ticket at the gate (atomic Valid -> Used)' })
  scan(
    @Body() dto: ScanTicketDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ScanResultDto> {
    return this.tickets.scanTicket(dto, user.id);
  }
}
