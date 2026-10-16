import { Module, Provider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PaymentEntity } from './entities/payment.entity';
import { ReservationEntity } from '../reservation/entities/reservation.entity';
import { PaymentService } from './services/payment.service';
import { PaymentController, PaymentCallbackController } from './controllers/payment.controller';
import { MockPaymentProvider } from './providers/mock-payment.provider';
import { ZarinpalPaymentProvider } from './providers/zarinpal-payment.provider';
import { PAYMENT_PROVIDER_TOKEN } from './providers/payment-provider.port';
import { ReservationModule } from '../reservation/reservation.module';
import { RedisModule } from '../common/redis';

/**
 * PaymentModule - selects the active PaymentProvider based on
 * PAYMENT_PROVIDER env. Both Mock and Zarinpal adapters are
 * registered with the DI container, but only one is bound to
 * PAYMENT_PROVIDER_TOKEN based on env at module load time.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PaymentEntity, ReservationEntity]),
    ConfigModule,
    ReservationModule,
    RedisModule,
  ],
  providers: [
    PaymentService,
    MockPaymentProvider,
    ZarinpalPaymentProvider,
    {
      provide: PAYMENT_PROVIDER_TOKEN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const provider = config.get<string>('PAYMENT_PROVIDER', 'mock');
        if (provider === 'zarinpal') {
          // We need to instantiate ZarinpalPaymentProvider with config.
          // Returning the class itself works only if we use useClass.
          // Switching strategy: use useFactory + new instance.
          // But the class itself uses DI for ConfigService; we have to
          // resolve via the app context. Easier: use a dynamic provider
          // via useClass elsewhere; here we use useFactory with manual
          // instantiation.
          return new ZarinpalPaymentProvider(config);
        }
        return new MockPaymentProvider(config);
      },
    } as Provider,
  ],
  controllers: [PaymentController, PaymentCallbackController],
  exports: [PaymentService],
})
export class PaymentModule {}
