import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorPayload {
  statusCode: number;
  message: string | string[];
  error: string;
  path?: string;
  timestamp: string;
  traceId?: string;
}

/**
 * Global exception filter that produces a consistent error envelope.
 * Unknown errors are logged with their stack trace and converted to 500.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { traceId?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let payload: ErrorPayload = {
      statusCode: status,
      message: 'Internal server error',
      error: 'Internal Server Error',
      path: request.url,
      timestamp: new Date().toISOString(),
      traceId: request.traceId,
    };

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const resp = exception.getResponse();
      if (typeof resp === 'string') {
        payload = { ...payload, statusCode: status, message: resp, error: exception.name };
      } else if (typeof resp === 'object' && resp !== null) {
        payload = {
          ...payload,
          ...(resp as Record<string, unknown>),
          statusCode: status,
          path: request.url,
          timestamp: new Date().toISOString(),
          traceId: request.traceId,
        } as ErrorPayload;
      }
    } else if (exception instanceof Error) {
      this.logger.error(`Unhandled error: ${exception.message}`, exception.stack);
      payload.message = exception.message;
    } else {
      this.logger.error(`Unhandled non-error exception: ${JSON.stringify(exception)}`);
    }

    response.status(status).json(payload);
  }
}
