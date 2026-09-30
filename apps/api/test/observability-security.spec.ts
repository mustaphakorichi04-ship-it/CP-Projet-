import { describe, it, expect, vi } from 'vitest';
import { StructuredLoggerService } from '../src/common/logger/structured-logger.service';
import { GlobalExceptionFilter } from '../src/common/filters/global-exception.filter';
import { CorrelationIdMiddleware } from '../src/common/middleware/correlation-id.middleware';
import { HttpException, HttpStatus } from '@nestjs/common';

describe('Observability & Security Headers Tests', () => {
  it('StructuredLoggerService : produit un log JSON avec correlationId et tenantId', () => {
    const logger = new StructuredLoggerService();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.log('Calcul ICCP exécuté avec succès', 'CalculationsService', {
      correlationId: 'corr-1234',
      tenantId: 'tenant-sonatrach-1',
      executionMs: 12,
    });

    expect(consoleSpy).toHaveBeenCalled();
    const rawOutput = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(rawOutput);

    expect(parsed.level).toBe('INFO');
    expect(parsed.correlationId).toBe('corr-1234');
    expect(parsed.tenantId).toBe('tenant-sonatrach-1');
    expect(parsed.executionMs).toBe(12);

    consoleSpy.mockRestore();
  });

  it('GlobalExceptionFilter : sanitize l\'erreur et renvoie le correlationId au client', () => {
    const filter = new GlobalExceptionFilter();
    const mockJson = vi.fn();
    const mockStatus = vi.fn().mockReturnValue({ json: mockJson });

    const mockHost = {
      switchToHttp: () => ({
        getResponse: () => ({ status: mockStatus }),
        getRequest: () => ({
          url: '/api/v1/calculations/sacp',
          method: 'POST',
          correlationId: 'req-corr-999',
          tenant: { tenantId: 'tenant-1' },
        }),
      }),
    } as any;

    const exception = new HttpException('Paramètre invalide', HttpStatus.BAD_REQUEST);
    filter.catch(exception, mockHost);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        correlationId: 'req-corr-999',
        error: 'Paramètre invalide',
      }),
    );
  });

  it('CorrelationIdMiddleware : génère ou propage x-correlation-id', () => {
    const middleware = new CorrelationIdMiddleware();
    const req: any = { headers: {} };
    const res: any = { setHeader: vi.fn() };
    const next = vi.fn();

    middleware.use(req, res, next);

    expect(req.correlationId).toBeDefined();
    expect(res.setHeader).toHaveBeenCalledWith('x-correlation-id', req.correlationId);
    expect(next).toHaveBeenCalled();
  });
});
