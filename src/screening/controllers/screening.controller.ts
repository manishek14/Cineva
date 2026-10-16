import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ScreeningService } from '../services/screening.service';
import {
  CancelScreeningDto,
  CreateScreeningDto,
  ListScreeningsQueryDto,
  ScreeningResponseDto,
  ScreeningSeatResponseDto,
  UpdateScreeningDto,
} from '../dtos/screening.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { ROLES } from '../../common/constants/state-machine';

@ApiTags('screenings')
@ApiBearerAuth()
@Controller('screenings')
export class ScreeningController {
  constructor(private readonly screenings: ScreeningService) {}

  @Post()
  @Roles(ROLES.CINEMA_MANAGER)
  @ApiOperation({ summary: 'Create a screening + auto-generate seat rows (manager)' })
  create(@Body() dto: CreateScreeningDto): Promise<ScreeningResponseDto> {
    return this.screenings.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List screenings with filters (movieId, hallId, status, startsAfter)' })
  list(@Query() query: ListScreeningsQueryDto): Promise<{
    items: ScreeningResponseDto[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    return this.screenings.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a screening by id' })
  findOne(@Param('id') id: string): Promise<ScreeningResponseDto> {
    return this.screenings.findOne(id);
  }

  @Patch(':id')
  @Roles(ROLES.CINEMA_MANAGER)
  @ApiOperation({ summary: 'Update a screening (manager)' })
  update(@Param('id') id: string, @Body() dto: UpdateScreeningDto): Promise<ScreeningResponseDto> {
    return this.screenings.update(id, dto);
  }

  @Post(':id/cancel')
  @Roles(ROLES.CINEMA_MANAGER, ROLES.CINEMA_OPERATOR)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a screening (manager/operator)' })
  cancel(@Param('id') id: string, @Body() dto: CancelScreeningDto): Promise<ScreeningResponseDto> {
    return this.screenings.cancel(id, dto);
  }

  @Get(':id/seat-map')
  @ApiOperation({ summary: 'Get the seat map with current sale status' })
  seatMap(@Param('id') id: string): Promise<ScreeningSeatResponseDto[]> {
    return this.screenings.getSeatMap(id);
  }
}
