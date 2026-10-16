import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { PaymentService } from '../services/payment.service';
import {
  InitiatePaymentDto,
  PaymentResponseDto,
  CallbackResultDto,
} from '../dtos/payment.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Public } from '../../common/decorators/public.decorator';
import type { RequestUser } from '../../auth/strategies/jwt.strategy';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('payments')
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}

  @Post('initiate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Initiate a payment for a reservation' })
  initiate(@Body() dto: InitiatePaymentDto): Promise<PaymentResponseDto> {
    return this.payments.initiatePayment(dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a payment by id' })
  findOne(@Param('id') id: string): Promise<PaymentResponseDto> {
    return this.payments.findOne(id);
  }

  @Get('reservation/:reservationId')
  @ApiOperation({ summary: 'List all payment attempts for a reservation' })
  listByReservation(@Param('reservationId') reservationId: string): Promise<PaymentResponseDto[]> {
    return this.payments.listByReservation(reservationId);
  }
}

/**
 * Provider callback endpoint. The gateway (Zarinpal/Mock) redirects the
 * customer's browser here after they authorize/cancel. This route is
 * PUBLIC because the request comes from a browser, not our JWT client.
 */
@ApiTags('payments')
@Controller('payment/callback')
export class PaymentCallbackController {
  constructor(private readonly payments: PaymentService) {}

  @Public()
  @Get('zarinpal')
  @ApiOperation({ summary: 'Zarinpal callback - browser redirect target' })
  async handleZarinpalCallback(
    @Query('paymentId') paymentId: string,
    @Query('Authority') authority: string,
    @Query('Status') status: string,
  ): Promise<CallbackResultDto> {
    const result = await this.payments.handleCallback({
      paymentId,
      authority,
      status,
    });
    return {
      success: result.status === 'Succeeded' && !result.lateCallback,
      paymentId: result.paymentId,
      status: result.status,
      message: result.lateCallback
        ? 'Payment received after reservation expiry; refund will be processed'
        : result.status === 'Succeeded'
          ? 'Payment succeeded; tickets issued'
          : 'Payment failed or cancelled',
    };
  }

  // Support POST callback (some providers use POST)
  @Public()
  @Post('zarinpal')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Zarinpal callback POST variant' })
  async handleZarinpalCallbackPost(@Req() req: Request): Promise<CallbackResultDto> {
    const q = req.query;
    return this.handleZarinpalCallback(
      (q.paymentId as string) ?? '',
      (q.Authority as string) ?? '',
      (q.Status as string) ?? '',
    );
  }
}
