import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CancellationPolicyEntity } from './entities/cancellation-policy.entity';
import { RefundEntity } from './entities/refund.entity';
import { ReservationEntity, ReservationSeatEntity, SeatAllocationEntity } from '../reservation';
import { PaymentEntity } from '../payment/entities/payment.entity';
import { ScreeningEntity, ScreeningSeatEntity } from '../screening';
import { CancellationService } from './services/cancellation.service';
import { CancellationController } from './controllers/cancellation.controller';
import { TicketModule } from '../ticket/ticket.module';
import { ReservationModule } from '../reservation/reservation.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CancellationPolicyEntity,
      RefundEntity,
      ReservationEntity,
      ReservationSeatEntity,
      SeatAllocationEntity,
      PaymentEntity,
      ScreeningEntity,
      ScreeningSeatEntity,
    ]),
    TicketModule,
    ReservationModule,
  ],
  providers: [CancellationService],
  controllers: [CancellationController],
  exports: [CancellationService],
})
export class CancellationModule {}
