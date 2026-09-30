import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';

@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    // Récupérer le correlation ID entrant ou en générer un nouveau (UUID v4)
    const correlationId = (req.headers['x-correlation-id'] as string) || crypto.randomUUID();

    // Attacher à la requête pour le logger et aux en-têtes de réponse pour le client
    (req as any).correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);

    next();
  }
}
