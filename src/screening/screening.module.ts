import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScreeningEntity } from './entities/screening.entity';
import { ScreeningSeatEntity } from './entities/screening-seat.entity';
import { MovieEntity } from '../catalog/entities/movie.entity';
import { CinemaHallEntity, SeatEntity } from '../hall';
import { SeatCategoryEntity } from '../catalog/entities/seat-category.entity';
import { ScreeningService } from './services/screening.service';
import { ScreeningController } from './controllers/screening.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ScreeningEntity,
      ScreeningSeatEntity,
      MovieEntity,
      CinemaHallEntity,
      SeatEntity,
      SeatCategoryEntity,
    ]),
  ],
  providers: [ScreeningService],
  controllers: [ScreeningController],
  exports: [ScreeningService],
})
export class ScreeningModule {}
