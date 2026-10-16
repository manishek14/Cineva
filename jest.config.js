/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.module.ts', '!src/main.ts'],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
    // NestJS 12 ships pure ESM (`"type": "module"`). Jest with ts-jest
    // CommonJS interop chokes on `import.meta`. For pure unit tests we
    // replace the parts of @nestjs/* we touch with lightweight CommonJS
    // shims. Integration/e2e tests use Test.createTestingModule which
    // sets up the proper loader via ts-jest's transformIgnorePatterns.
    '^@nestjs/common$': '<rootDir>/test/shims/@nestjs/common.ts',
    '^@nestjs/config$': '<rootDir>/test/shims/@nestjs/config.ts',
    '^@nestjs/typeorm$': '<rootDir>/test/shims/@nestjs/typeorm.ts',
    '^@nestjs/jwt$': '<rootDir>/test/shims/@nestjs/jwt.ts',
    '^@nestjs/passport$': '<rootDir>/test/shims/passport-shim.ts',
    '^@nestjs/bullmq$': '<rootDir>/test/shims/@nestjs/bullmq.ts',
    '^@nestjs/swagger$': '<rootDir>/test/shims/@nestjs/swagger.ts',
    '^@nestjs/core$': '<rootDir>/test/shims/@nestjs/core.ts',
    '^passport$': '<rootDir>/test/shims/passport-shim.ts',
    '^passport-jwt$': '<rootDir>/test/shims/passport-jwt-shim.ts',
  },
  setupFiles: ['<rootDir>/test/setup.ts'],
};
