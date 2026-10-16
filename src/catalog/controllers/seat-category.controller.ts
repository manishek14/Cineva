import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SeatCategoryService } from '../services/seat-category.service';
import {
  CreateSeatCategoryDto,
  SeatCategoryResponseDto,
  UpdateSeatCategoryDto,
} from '../dtos/seat-category.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { ROLES } from '../../common/constants/state-machine';

@ApiTags('seat-categories')
@ApiBearerAuth()
@Controller('seat-categories')
export class SeatCategoryController {
  constructor(private readonly categories: SeatCategoryService) {}

  @Post()
  @Roles(ROLES.CINEMA_MANAGER)
  @ApiOperation({ summary: 'Create a seat category (manager)' })
  create(@Body() dto: CreateSeatCategoryDto): Promise<SeatCategoryResponseDto> {
    return this.categories.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List active seat categories ordered by displayOrder' })
  list(): Promise<SeatCategoryResponseDto[]> {
    return this.categories.list();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a seat category by id' })
  findOne(@Param('id') id: string): Promise<SeatCategoryResponseDto> {
    return this.categories.findOne(id);
  }

  @Patch(':id')
  @Roles(ROLES.CINEMA_MANAGER)
  @ApiOperation({ summary: 'Update a seat category (manager)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateSeatCategoryDto,
  ): Promise<SeatCategoryResponseDto> {
    return this.categories.update(id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.CINEMA_MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archive a seat category (manager)' })
  archive(@Param('id') id: string): Promise<void> {
    return this.categories.archive(id);
  }
}
