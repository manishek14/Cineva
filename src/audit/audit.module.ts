import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditLogEntity } from './entities/audit-log.entity';
import { OutboxEventEntity } from './entities/outbox-event.entity';
import { AuditService } from './services/audit.service';
import { OutboxProcessor } from './processors/outbox.processor';
import { QUEUES } from '../jobs/jobs.constants';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuditLogEntity, OutboxEventEntity]),
    BullModule.registerQueue({ name: QUEUES.OUTBOX_DISPATCH }),
  ],
  providers: [AuditService, OutboxProcessor],
  exports: [AuditService],
})
export class AuditModule {}
