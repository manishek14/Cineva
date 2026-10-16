// Real CommonJS shim for @nestjs/jwt - delegates to the jsonwebtoken
// library (installed as a transitive dep of @nestjs/jwt).
// Implements just enough of JwtService for our unit tests to sign/verify
// tokens without going through the full NestJS DI.

import * as jwt from 'jsonwebtoken';

export class JwtService {
  private readonly secret: string | Buffer;
  private readonly signOptions: jwt.SignOptions;

  constructor(options: {
    secret?: string | Buffer;
    signOptions?: jwt.SignOptions;
  } = {}) {
    this.secret = options.secret ?? '';
    this.signOptions = options.signOptions ?? {};
  }

  async signAsync(
    payload: string | object | Buffer,
    options: { secret?: string | Buffer; expiresIn?: string | number } = {},
  ): Promise<string> {
    const secret = options.secret ?? this.secret;
    const signOpts: jwt.SignOptions = {
      ...this.signOptions,
      ...(options.expiresIn ? { expiresIn: options.expiresIn as never } : {}),
    };
    return jwt.sign(payload as object, secret, signOpts);
  }

  sign(
    payload: string | object | Buffer,
    options: { secret?: string | Buffer; expiresIn?: string | number } = {},
  ): string {
    const secret = options.secret ?? this.secret;
    const signOpts: jwt.SignOptions = {
      ...this.signOptions,
      ...(options.expiresIn ? { expiresIn: options.expiresIn as never } : {}),
    };
    return jwt.sign(payload as object, secret, signOpts);
  }

  async verifyAsync<T = unknown>(
    token: string,
    options: { secret?: string | Buffer } = {},
  ): Promise<T> {
    const secret = options.secret ?? this.secret;
    return new Promise<T>((resolve, reject) => {
      jwt.verify(token, secret, (err, decoded) => {
        if (err) reject(err);
        else resolve(decoded as T);
      });
    });
  }

  decode(token: string, options?: jwt.DecodeOptions): unknown {
    return jwt.decode(token, options);
  }
}

export {};
