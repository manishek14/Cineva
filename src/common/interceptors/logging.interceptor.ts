import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Request, Response } from 'express';

/**
 * Logs every incoming request and its duration. Attaches a traceId
 * (generated if missing) to the request for use by filters and audit logs.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<Request & { traceId?: string }>();
    const res = ctx.getResponse<Response>();

    // TraceId: prefer X-Trace-Id header, else generate.
    const traceId =
      (req.headers['x-trace-id'] as string | undefined) ??
      Math.random().toString(36).slice(2, 10);
    req.traceId = traceId;
    res.setHeader('X-Trace-Id', traceId);

    const startedAt = Date.now();
    const { method, url } = req;
    return next.handle().pipe(
      tap({
        next: () => {
          const ms = Date.now() - startedAt;
          this.logger.debug(`${method} ${url} ${res.statusCode} - ${ms}ms [${traceId}]`);
        },
        error: (err: { status?: number; statusCode?: number; message?: string }) => {
          const code = err?.status ?? err?.statusCode ?? 500;
          const ms = Date.now() - startedAt;
          this.logger.warn(
            `${method} ${url} ${code} - ${ms}ms [${traceId}] ${(err?.message ?? '').slice(0, 120)}`,
          );
        },
      }),
    );
  }
}
