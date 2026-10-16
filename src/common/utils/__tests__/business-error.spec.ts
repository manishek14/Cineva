import { HttpException, HttpStatus } from '@nestjs/common';
import { BusinessError } from 'src/common/utils/business-error';
import { ERROR_CODES } from 'src/common/constants/error-codes';

describe('BusinessError', () => {
  it('extends HttpException so NestJS global filter handles it', () => {
    const err = new BusinessError({
      code: ERROR_CODES.VALIDATION,
      message: 'Bad input',
    });
    expect(err).toBeInstanceOf(HttpException);
    expect(err.code).toBe(ERROR_CODES.VALIDATION);
  });

  it('defaults to 400 BAD_REQUEST when no httpStatus provided', () => {
    const err = new BusinessError({
      code: ERROR_CODES.VALIDATION,
      message: 'Bad input',
    });
    expect(err.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    const response = err.getResponse() as { code: string; message: string; details?: unknown };
    expect(response.code).toBe(ERROR_CODES.VALIDATION);
    expect(response.message).toBe('Bad input');
  });

  it('carries details through to the response payload', () => {
    const err = new BusinessError({
      code: ERROR_CODES.SEAT_ALREADY_HELD,
      message: 'seat A1 already held',
      details: { seatId: 'abc', heldBy: 'def' },
    });
    const response = err.getResponse() as { details?: { seatId: string } };
    expect(response.details).toEqual({ seatId: 'abc', heldBy: 'def' });
  });

  describe('static factory: notFound', () => {
    it('produces 404 with the right code', () => {
      const err = BusinessError.notFound('Reservation X not found', ERROR_CODES.RESERVATION_NOT_FOUND);
      expect(err.getStatus()).toBe(HttpStatus.NOT_FOUND);
      expect(err.code).toBe(ERROR_CODES.RESERVATION_NOT_FOUND);
    });

    it('falls back to INTERNAL when no code provided', () => {
      const err = BusinessError.notFound('Generic 404');
      expect(err.code).toBe(ERROR_CODES.INTERNAL);
    });
  });

  describe('static factory: conflict', () => {
    it('produces 409', () => {
      const err = BusinessError.conflict('Already exists', ERROR_CODES.VALIDATION);
      expect(err.getStatus()).toBe(HttpStatus.CONFLICT);
    });
  });

  describe('static factory: forbidden', () => {
    it('produces 403 with FORBIDDEN by default', () => {
      const err = BusinessError.forbidden('Not your reservation');
      expect(err.getStatus()).toBe(HttpStatus.FORBIDDEN);
      expect(err.code).toBe(ERROR_CODES.FORBIDDEN);
    });
  });

  describe('static factory: unauthorized', () => {
    it('produces 401 with UNAUTHORIZED by default', () => {
      const err = BusinessError.unauthorized('Invalid OTP');
      expect(err.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
      expect(err.code).toBe(ERROR_CODES.UNAUTHORIZED);
    });
  });

  describe('static factory: unprocessable', () => {
    it('produces 422', () => {
      const err = BusinessError.unprocessable('Screening not published');
      expect(err.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    });
  });
});
