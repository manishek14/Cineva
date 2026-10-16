import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_CODES, ErrorCode } from '../constants/error-codes';

interface BusinessErrorOptions {
  code: ErrorCode;
  message: string;
  httpStatus?: HttpStatus;
  details?: Record<string, unknown>;
}

/**
 * Domain-level exception carrying a stable business error code.
 * HttpExceptionFilter converts to HTTP response with the same payload.
 */
export class BusinessError extends HttpException {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor({ code, message, httpStatus = HttpStatus.BAD_REQUEST, details }: BusinessErrorOptions) {
    super({ code, message, details }, httpStatus);
    this.code = code;
    this.details = details;
  }

  static notFound(message: string, code: ErrorCode = ERROR_CODES.INTERNAL): BusinessError {
    return new BusinessError({ code, message, httpStatus: HttpStatus.NOT_FOUND });
  }

  static conflict(message: string, code: ErrorCode = ERROR_CODES.INTERNAL): BusinessError {
    return new BusinessError({ code, message, httpStatus: HttpStatus.CONFLICT });
  }

  static forbidden(message: string, code: ErrorCode = ERROR_CODES.FORBIDDEN): BusinessError {
    return new BusinessError({ code, message, httpStatus: HttpStatus.FORBIDDEN });
  }

  static unauthorized(message: string, code: ErrorCode = ERROR_CODES.UNAUTHORIZED): BusinessError {
    return new BusinessError({ code, message, httpStatus: HttpStatus.UNAUTHORIZED });
  }

  static unprocessable(message: string, code: ErrorCode = ERROR_CODES.INTERNAL): BusinessError {
    return new BusinessError({ code, message, httpStatus: HttpStatus.UNPROCESSABLE_ENTITY });
  }
}
