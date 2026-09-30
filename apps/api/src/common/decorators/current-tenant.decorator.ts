import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { TenantContext } from '@cp-engineer/shared-types';

export const CurrentTenant = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): TenantContext => {
    const request = ctx.switchToHttp().getRequest();
    return request.tenant;
  },
);
