import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MovieEntity } from './entities/movie.entity';
import { SeatCategoryEntity } from './entities/seat-category.entity';
import { MovieService } from './services/movie.service';
import { SeatCategoryService } from './services/seat-category.service';
import { MovieController } from './controllers/movie.controller';
import { SeatCategoryController } from './controllers/seat-category.controller';

@Module({
  imports: [TypeOrmModule.forFeature([MovieEntity, SeatCategoryEntity])],
  providers: [MovieService, SeatCategoryService],
  controllers: [MovieController, SeatCategoryController],
  exports: [MovieService, SeatCategoryService],
})
export class CatalogModule {}
