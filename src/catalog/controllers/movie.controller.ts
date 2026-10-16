import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { MovieService } from '../services/movie.service';
import {
  CreateMovieDto,
  ListMoviesQueryDto,
  MovieResponseDto,
  PaginatedMoviesDto,
  UpdateMovieDto,
} from '../dtos/movie.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { ROLES } from '../../common/constants/state-machine';

@ApiTags('movies')
@ApiBearerAuth()
@Controller('movies')
export class MovieController {
  constructor(private readonly movies: MovieService) {}

  @Post()
  @Roles(ROLES.CINEMA_MANAGER)
  @ApiOperation({ summary: 'Create a movie (manager)' })
  create(@Body() dto: CreateMovieDto): Promise<MovieResponseDto> {
    return this.movies.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List movies (paginated, optionally filter by status)' })
  list(@Query() query: ListMoviesQueryDto): Promise<PaginatedMoviesDto> {
    return this.movies.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a movie by id' })
  findOne(@Param('id') id: string): Promise<MovieResponseDto> {
    return this.movies.findOne(id);
  }

  @Patch(':id')
  @Roles(ROLES.CINEMA_MANAGER)
  @ApiOperation({ summary: 'Update a movie (manager)' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdateMovieDto,
  ): Promise<MovieResponseDto> {
    return this.movies.update(id, dto);
  }

  @Delete(':id')
  @Roles(ROLES.CINEMA_MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Archive (soft-delete) a movie (manager)' })
  archive(@Param('id') id: string): Promise<void> {
    return this.movies.archive(id);
  }

  @Post(':id/restore')
  @Roles(ROLES.CINEMA_MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Restore an archived movie (manager)' })
  restore(@Param('id') id: string): Promise<void> {
    return this.movies.restore(id);
  }
}
