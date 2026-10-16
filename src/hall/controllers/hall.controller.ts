import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HallService } from '../services/hall.service';
import { CinemaHallResponseDto, CreateCinemaHallDto, UpdateCinemaHallDto } from '../dtos/hall.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { ROLES } from '../../common/constants/state-machine';

@ApiTags('cinema-halls')
@ApiBearerAuth()
@Controller('halls')
export class HallController {
  constructor(private readonly halls: HallService) {}

  @Post()
  @Roles(ROLES.CINEMA_MANAGER)
  @ApiOperation({ summary: 'Create a cinema hall (manager)' })
  create(@Body() dto: CreateCinemaHallDto): Promise<CinemaHallResponseDto> {
    return this.halls.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List active cinema halls' })
  list(): Promise<CinemaHallResponseDto[]> {
    return this.halls.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a cinema hall by id' })
  findOne(@Param('id') id: string): Promise<CinemaHallResponseDto> {
    return this.halls.findOne(id);
  }

  @Patch(':id')
  @Roles(ROLES.CINEMA_MANAGER)
  @ApiOperation({ summary: 'Update a cinema hall (manager)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCinemaHallDto,
  ): Promise<CinemaHallResponseDto> {
    return this.halls.update(id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.CINEMA_MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archive a cinema hall (manager)' })
  archive(@Param('id') id: string): Promise<void> {
    return this.halls.archive(id);
  }
}
