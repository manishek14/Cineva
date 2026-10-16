import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { useContainer } from 'class-validator';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bodyParser: true,
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
    cors: {
      origin: (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim()),
      credentials: true,
    },
  });

  const configService = app.get(ConfigService);
  const apiPrefix = configService.get<string>('API_PREFIX', 'api');
  const apiVersion = configService.get<string>('API_VERSION', 'v1');
  const globalPrefix = `${apiPrefix}/${apiVersion}`;
  app.setGlobalPrefix(globalPrefix);

  // Security
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.use(cookieParser());

  // Validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Filters & Interceptors
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Enable class-validator to use NestJS DI container for custom validators
  useContainer(app.select(AppModule), { fallbackOnErrors: true });

  // Swagger
  const swaggerConfig = new DocumentBuilder()
    .setTitle(configService.get<string>('APP_NAME', 'Cineva'))
    .setDescription('Cinema ticket reservation backend API')
    .setVersion(configService.get<string>('APP_VERSION', '1.0.0'))
    .addBearerAuth()
    .addCookieAuth('refresh_token')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);
  logger.log(`Cineva is running on http://localhost:${port}/${globalPrefix}`);
  logger.log(`Swagger UI: http://localhost:${port}/docs`);
}

void bootstrap();
