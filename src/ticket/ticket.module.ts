import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TicketEntity } from './entities/ticket.entity';
import {
  ReservationSeatEntity,
  ReservationEntity,
} from '../reservation';
import {
  ScreeningSeatEntity,
  ScreeningEntity,
} from '../screening';
import { SeatEntity, CinemaHallEntity } from '../hall';
import { MovieEntity } from '../catalog/entities/movie.entity';
import { TicketService } from './services/ticket.service';
import { TicketController } from './controllers/ticket.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TicketEntity,
      ReservationSeatEntity,
      ReservationEntity,
      ScreeningSeatEntity,
      ScreeningEntity,
      SeatEntity,
      CinemaHallEntity,
      MovieEntity,
    ]),
  ],
  providers: [TicketService],
  controllers: [TicketController],
  exports: [TicketService],
})
export class TicketModule {}
