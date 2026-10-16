import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReservationEntity } from './entities/reservation.entity';
import { ReservationSeatEntity } from './entities/reservation-seat.entity';
import { SeatAllocationEntity } from './entities/seat-allocation.entity';
import { ScreeningEntity, ScreeningSeatEntity } from '../screening';
import { ReservationService } from './services/reservation.service';
import { ReservationController } from './controllers/reservation.controller';
import { RedisModule } from '../common/redis';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      ReservationEntity,
      ReservationSeatEntity,
      SeatAllocationEntity,
      ScreeningEntity,
      ScreeningSeatEntity,
    ]),
    RedisModule,
  ],
  providers: [ReservationService],
  controllers: [ReservationController],
  exports: [ReservationService],
})
export class ReservationModule {}
