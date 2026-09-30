import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserSessionDto } from '@cp-engineer/shared-types';

export const CurrentUser = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): UserSessionDto => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
