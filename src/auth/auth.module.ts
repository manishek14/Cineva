import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UserEntity } from './entities/user.entity';
import { OtpChallengeEntity } from './entities/otp-challenge.entity';
import { OtpService } from './services/otp.service';
import { AuthService } from './services/auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { AuthController } from './controllers/auth.controller';
import { RedisModule } from '../common/redis';

@Module({
  imports: [
    TypeOrmModule.forFeature([UserEntity, OtpChallengeEntity]),
    PassportModule,
    RedisModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_ACCESS_SECRET') ?? 'dev_only_secret',
        signOptions: { expiresIn: config.get<string>('JWT_ACCESS_TTL', '15m') as never },
      }),
    }),
  ],
  providers: [
    OtpService,
    AuthService,
    JwtStrategy,
    // Global JWT guard - every route requires auth unless @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // RolesGuard is applied per-route via @UseGuards(RolesGuard) alongside
    // JwtAuthGuard where role enforcement is needed (it's not global).
  ],
  controllers: [AuthController],
  exports: [OtpService, AuthService, JwtStrategy],
})
export class AuthModule {}
