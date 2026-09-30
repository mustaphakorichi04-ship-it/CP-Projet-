import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('GlobalExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const correlationId = (request as any).correlationId || 'N/A';
    const tenantId = (request as any).tenant?.tenantId || 'anonymous';

    const message =
      exception instanceof HttpException
        ? exception.getResponse()
        : 'Une erreur interne est survenue sur le serveur.';

    // Journalisation structurée de l'erreur avec stacktrace
    this.logger.error(
      JSON.stringify({
        message: 'Exception capturée',
        status,
        path: request.url,
        method: request.method,
        correlationId,
        tenantId,
        error: exception instanceof Error ? exception.message : String(exception),
        stack: exception instanceof Error ? exception.stack : undefined,
      }),
    );

    // Réponse épurée envoyée au client (ne divulgue jamais les stacktraces en production)
    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      correlationId,
      error: typeof message === 'object' ? (message as any).error || (message as any).message : message,
    });
  }
}
