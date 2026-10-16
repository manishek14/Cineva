import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { OtpPurpose } from '../entities/otp-challenge.entity';

const PURPOSES: readonly OtpPurpose[] = ['login', 'guest_login', 'ownership_reclaim'];

export class RequestOtpDto {
  @ApiProperty({ example: '+989121234567' })
  @IsString()
  @MinLength(8)
  @MaxLength(16)
  phone!: string;

  @ApiPropertyOptional({ enum: PURPOSES, default: 'login' })
  @IsOptional()
  @IsIn(PURPOSES as readonly string[])
  purpose?: OtpPurpose;
}

export class VerifyOtpDto {
  @ApiProperty({ example: '+989121234567' })
  @IsString()
  @MinLength(8)
  @MaxLength(16)
  phone!: string;

  @ApiProperty({ example: '111111', description: '6-digit code' })
  @IsString()
  @MinLength(4)
  @MaxLength(8)
  code!: string;

  @ApiPropertyOptional({ enum: PURPOSES })
  @IsOptional()
  @IsIn(PURPOSES as readonly string[])
  purpose?: OtpPurpose;

  @ApiPropertyOptional({ description: 'Required for guest_login purpose' })
  @IsOptional()
  @IsString()
  reservationId?: string;
}

export class RefreshTokenDto {
  @ApiProperty({ description: 'Refresh token from httpOnly cookie' })
  @IsString()
  refreshToken!: string;
}

export class AuthResponseDto {
  @ApiProperty() accessToken!: string;
  @ApiProperty() refreshToken!: string;
  @ApiProperty() accessTokenExpiresAt!: string;
  @ApiProperty() userId!: string;
  @ApiProperty() phone!: string;
  @ApiProperty() role!: string;
}

export class OtpSentResponseDto {
  @ApiProperty() phone!: string;
  @ApiProperty() expiresIn!: number;
  @ApiPropertyOptional({ description: 'Fake code returned in dev mode only' })
  devCode?: string;
}
