import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SeatService } from '../services/seat.service';
import { BulkSeatUpsertDto, SeatResponseDto } from '../dtos/hall.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { ROLES } from '../../common/constants/state-machine';

@ApiTags('seats')
@ApiBearerAuth()
@Controller('halls/:hallId/seats')
export class SeatController {
  constructor(private readonly seats: SeatService) {}

  @Post('bulk')
  @Roles(ROLES.CINEMA_MANAGER)
  @ApiOperation({ summary: 'Bulk upsert seats for a hall (manager)' })
  bulkUpsert(
    @Param('hallId') hallId: string,
    @Body() dto: BulkSeatUpsertDto,
  ): Promise<SeatResponseDto[]> {
    return this.seats.bulkUpsert(hallId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all seats for a hall (ordered by row + number)' })
  list(@Param('hallId') hallId: string): Promise<SeatResponseDto[]> {
    return this.seats.listByHall(hallId);
  }

  @Patch(':seatId/maintenance')
  @Roles(ROLES.CINEMA_MANAGER, ROLES.CINEMA_OPERATOR)
  @ApiOperation({ summary: 'Toggle maintenance on a seat' })
  setMaintenance(
    @Param('hallId') _hallId: string,
    @Param('seatId') seatId: string,
    @Body() body: { reason?: string | null },
  ): Promise<SeatResponseDto> {
    return this.seats.setMaintenance(seatId, body.reason ?? null);
  }

  @Delete(':seatId')
  @Roles(ROLES.CINEMA_MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-remove a seat (status=Removed)' })
  remove(
    @Param('hallId') _hallId: string,
    @Param('seatId') seatId: string,
  ): Promise<void> {
    return this.seats.removeSeat(seatId);
  }
}
