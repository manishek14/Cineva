import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CinemaHallEntity } from './entities/cinema-hall.entity';
import { SeatEntity } from './entities/seat.entity';
import { SeatCategoryEntity } from '../catalog/entities/seat-category.entity';
import { HallService } from './services/hall.service';
import { SeatService } from './services/seat.service';
import { HallController } from './controllers/hall.controller';
import { SeatController } from './controllers/seat.controller';

@Module({
  imports: [TypeOrmModule.forFeature([CinemaHallEntity, SeatEntity, SeatCategoryEntity])],
  providers: [HallService, SeatService],
  controllers: [HallController, SeatController],
  exports: [HallService, SeatService],
})
export class HallModule {}
