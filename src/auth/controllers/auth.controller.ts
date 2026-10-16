import { Body, Controller, HttpCode, HttpStatus, Post, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { AuthService } from '../services/auth.service';
import { OtpService } from '../services/otp.service';
import {
  AuthResponseDto,
  OtpSentResponseDto,
  RefreshTokenDto,
  RequestOtpDto,
  VerifyOtpDto,
} from '../dtos/auth.dto';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ROLES } from '../../common/constants/state-machine';
import type { RequestUser } from '../strategies/jwt.strategy';
import { CurrentUser } from '../decorators/current-user.decorator';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';

const REFRESH_COOKIE = 'refresh_token';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly otp: OtpService,
    private readonly auth: AuthService,
  ) {}

  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request an OTP to be sent to phone (dev: prints code)' })
  requestOtp(@Body() dto: RequestOtpDto): Promise<OtpSentResponseDto> {
    return this.otp.requestOtp(dto);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify OTP and receive access+refresh tokens' })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const tokens = await this.auth.verifyOtpAndLogin(dto);
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days; mirror JWT_REFRESH_TTL
      path: '/api/v1/auth',
    });
    return tokens;
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate refresh token; returns new access+refresh pair' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AuthResponseDto> {
    const tokens = await this.auth.refreshTokens(dto);
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/v1/auth',
    });
    return tokens;
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Revoke current refresh token' })
  async logout(
    @CurrentUser() user: RequestUser,
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(user.id, dto.refreshToken);
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(ROLES.TECH_ADMIN)
  @Post('users/role')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Assign role to a user (tech_admin only)' })
  async assignRole(@Body() body: { userId: string; role: string }) {
    const user = await this.auth.assignRole(body.userId, body.role as never);
    return {
      userId: user.id,
      role: user.role,
    };
  }
}
