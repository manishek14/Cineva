import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ReservationEntity } from '../reservation/entities/reservation.entity';
import { ReservationModule } from '../reservation/reservation.module';
import { JobsService } from './services/jobs.service';
import {
  ReservationExpiryProcessor,
  ReconciliationProcessor,
} from './processors/reservation-expiry.processor';
import { QUEUES } from './jobs.constants';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: QUEUES.RESERVATION_EXPIRY },
      { name: QUEUES.RECONCILIATION },
      { name: QUEUES.PAYMENT_CALLBACK_TIMEOUT },
      { name: QUEUES.OUTBOX_DISPATCH },
    ),
    TypeOrmModule.forFeature([ReservationEntity]),
    ReservationModule,
  ],
  providers: [JobsService, ReservationExpiryProcessor, ReconciliationProcessor],
  exports: [JobsService],
})
export class JobsModule {}
