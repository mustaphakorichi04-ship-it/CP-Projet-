import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { TokenService } from '../token.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    // 1. Priorité 1 : Extraction depuis le cookie sécurisé HttpOnly
    let token = request.cookies ? request.cookies['cp_session'] : undefined;

    // 2. Priorité 2 : Fallback header Authorization (pour CLI / API clients externes)
    if (!token && request.headers.authorization) {
      const [type, headerToken] = request.headers.authorization.split(' ');
      if (type === 'Bearer') {
        token = headerToken;
      }
    }

    if (!token) {
      throw new UnauthorizedException('Session non authentifiée. Cookie de session manquant.');
    }

    const userSession = this.tokenService.verifySessionToken(token);
    
    if (userSession.tenant.status === 'SUSPENDED') {
      throw new UnauthorizedException('L\'accès de votre organisation est suspendu suite à un incident de paiement.');
    }

    request.user = userSession;
    request.tenant = userSession.tenant;

    return true;
  }
}
