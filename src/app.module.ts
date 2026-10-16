import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { configuration } from './config/configuration';
import { validate } from './config/env.validation';
import { RedisModule } from './common/redis';
import { CatalogModule } from './catalog';
import { HallModule } from './hall';
import { ScreeningModule } from './screening';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validate,
      envFilePath: ['.env.local', '.env', `.env.${process.env.NODE_ENV ?? 'development'}`],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DATABASE_HOST'),
        port: config.get<number>('DATABASE_PORT'),
        username: config.get<string>('DATABASE_USER'),
        password: config.get<string>('DATABASE_PASSWORD'),
        database: config.get<string>('DATABASE_NAME'),
        schema: config.get<string>('DATABASE_SCHEMA', 'public'),
        synchronize: config.get<boolean>('DATABASE_SYNC', false),
        logging: config.get<boolean>('DATABASE_LOGGING', false),
        autoLoadEntities: true,
        extra: {
          max: config.get<number>('DATABASE_POOL_SIZE', 10),
        },
        // BullMQ needs reliable transactions; default isolation is fine but
        // Reservation finalization uses explicit SERIALIZABLE transactions.
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const host = config.get<string>('REDIS_HOST');
        const port = config.get<number>('REDIS_PORT');
        const password = config.get<string>('REDIS_PASSWORD') || undefined;
        const db = config.get<number>('REDIS_DB', 0);
        return {
          connection: {
            host,
            port,
            password,
            db,
            maxRetriesPerRequest: null,
            enableReadyCheck: true,
          },
          prefix: config.get<string>('BULLMQ_PREFIX', 'cineva'),
        };
      },
    }),
    // Default Redis client (ioredis). Tests can swap via RedisModule.forRoot({useMock:true}).
    RedisModule.forRoot(),
    CatalogModule,
    HallModule,
    ScreeningModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
