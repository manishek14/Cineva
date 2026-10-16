// Empty shim for @nestjs/swagger - decorators are no-ops in tests.
export function ApiProperty(_opts?: unknown): PropertyDecorator {
  return function () {} as PropertyDecorator;
}
export function ApiPropertyOptional(_opts?: unknown): PropertyDecorator {
  return function () {} as PropertyDecorator;
}
export function ApiTags(_opts?: unknown): ClassDecorator & MethodDecorator {
  return function () {} as ClassDecorator & MethodDecorator;
}
export function ApiOperation(_opts?: unknown): MethodDecorator {
  return function () {} as MethodDecorator;
}
export function ApiBearerAuth(_opts?: unknown): ClassDecorator & MethodDecorator {
  return function () {} as ClassDecorator & MethodDecorator;
}
export function ApiBody(_opts?: unknown): MethodDecorator {
  return function () {} as MethodDecorator;
}
export {};
