import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  UnauthorizedException,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { TenantContext } from '@cp-engineer/shared-types';

@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();

    // 1. Extraction du contexte utilisateur/tenant depuis la session authentifiée (cookie HttpOnly)
    // ou header de contexte en environnement de service/dev
    const userSession = request.user;
    const headerTenantId = request.headers['x-tenant-id'];

    let tenant: TenantContext | null = null;

    if (userSession && userSession.tenant) {
      tenant = userSession.tenant;
    } else if (headerTenantId) {
      // Pour les tests ou intégrations internes sécurisées
      tenant = {
        tenantId: String(headerTenantId),
        organizationName: 'Context Resolving Tenant',
        plan: 'PRO',
        isolationMode: 'SHARED_RLS',
      };
    }

    // Si la route n'est pas publique et requiert un tenant
    const isPublic = Reflect.getMetadata('isPublic', context.getHandler());
    if (!isPublic && !tenant) {
      throw new UnauthorizedException('Contexte de tenant manquant ou invalide.');
    }

    // Injection dans l'objet request pour accès dans les contrôleurs et services
    request.tenant = tenant;

    return next.handle();
  }
}
