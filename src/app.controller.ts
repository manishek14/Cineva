import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Public } from './common/decorators/public.decorator';

class HealthResponseDto {
  status!: string;
  service!: string;
  version!: string;
  timestamp!: string;
}

@ApiTags('health')
@Controller('health')
export class AppController {
  @Public()
  @Get()
  @ApiOperation({ summary: 'Health check' })
  health(): HealthResponseDto {
    return {
      status: 'ok',
      service: 'Cineva',
      version: process.env.APP_VERSION ?? '1.0.0',
      timestamp: new Date().toISOString(),
    };
  }
}
