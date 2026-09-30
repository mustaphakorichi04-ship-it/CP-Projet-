import { Injectable, LoggerService } from '@nestjs/common';

@Injectable()
export class StructuredLoggerService implements LoggerService {
  private formatMessage(level: string, message: any, context?: string, metadata?: Record<string, any>) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      context: context || 'Application',
      message: typeof message === 'object' ? JSON.stringify(message) : message,
      correlationId: metadata?.correlationId || undefined,
      tenantId: metadata?.tenantId || undefined,
      userId: metadata?.userId || undefined,
      ...metadata,
    };

    return JSON.stringify(logEntry);
  }

  log(message: any, context?: string, metadata?: Record<string, any>) {
    console.log(this.formatMessage('info', message, context, metadata));
  }

  error(message: any, trace?: string, context?: string, metadata?: Record<string, any>) {
    console.error(this.formatMessage('error', message, context, { ...metadata, trace }));
  }

  warn(message: any, context?: string, metadata?: Record<string, any>) {
    console.warn(this.formatMessage('warn', message, context, metadata));
  }

  debug(message: any, context?: string, metadata?: Record<string, any>) {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(this.formatMessage('debug', message, context, metadata));
    }
  }

  verbose(message: any, context?: string, metadata?: Record<string, any>) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(this.formatMessage('verbose', message, context, metadata));
    }
  }
}
