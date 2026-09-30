import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import * as cookieParser from 'cookie-parser';
import { StructuredLoggerService } from './common/logger/structured-logger.service';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';

async function bootstrap() {
  const structuredLogger = new StructuredLoggerService();
  const app = await NestFactory.create(AppModule, {
    logger: structuredLogger,
  });

  // 1. Parsing des cookies sécurisés (pour HttpOnly JWT)
  app.use(cookieParser());

  // 2. Filtre global d'exceptions (réponses uniformisées avec correlationId)
  app.useGlobalFilters(new GlobalExceptionFilter());

  // 3. Validation globale des DTOs avec class-validator
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // 4. En-têtes de sécurité HTTP stricts (OWASP)
  app.use((req: any, res: any, next: any) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https:;"
    );
    next();
  });

  // 5. CORS strict pour le frontend
  app.enableCors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-tenant-id', 'x-correlation-id'],
    exposedHeaders: ['x-correlation-id'],
  });

  // 4. Graceful Shutdown pour conteneurs Docker / K8s
  app.enableShutdownHooks();

  const port = process.env.PORT || 4000;
  await app.listen(port);
  structuredLogger.log(`🚀 CP Engineer SaaS API démarrée sur le port ${port} (Graceful Shutdown actif)`);
}

bootstrap();
