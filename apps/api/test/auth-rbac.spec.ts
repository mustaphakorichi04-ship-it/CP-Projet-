import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PasswordService } from '../src/auth/password.service';
import { TokenService } from '../src/auth/token.service';
import { RolesGuard } from '../src/auth/guards/roles.guard';
import { UserRole, UserSessionDto } from '@cp-engineer/shared-types';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

describe('Auth & RBAC Security Tests', () => {
  let passwordService: PasswordService;
  let tokenService: TokenService;
  let rolesGuard: RolesGuard;

  const mockSession: UserSessionDto = {
    userId: '10000000-0000-0000-0000-000000000001',
    email: 'lead@sonatrach.dz',
    firstName: 'Karim',
    lastName: 'Mansour',
    role: 'LEAD_ENGINEER',
    tenant: {
      tenantId: '00000000-0000-0000-0000-000000000001',
      organizationName: 'Sonatrach Pipeline Division',
      plan: 'PRO',
      isolationMode: 'SHARED_RLS',
    },
  };

  beforeEach(() => {
    passwordService = new PasswordService();
    tokenService = new TokenService();
  });

  it('PasswordService : génère un hash sécurisé et vérifie avec succès', async () => {
    const rawPassword = 'StrongPassword!2026';
    const hash = await passwordService.hashPassword(rawPassword);

    expect(hash).toContain(':'); // Contient iterations:salt:hash
    const isValid = await passwordService.verifyPassword(rawPassword, hash);
    expect(isValid).toBe(true);

    const isWrong = await passwordService.verifyPassword('WrongPass', hash);
    expect(isWrong).toBe(false);
  });

  it('TokenService : génère un token signé et rejette les tokens altérés', () => {
    const token = tokenService.generateSessionToken(mockSession);
    const verified = tokenService.verifySessionToken(token);

    expect(verified.userId).toBe(mockSession.userId);
    expect(verified.role).toBe('LEAD_ENGINEER');
    expect(verified.tenant.tenantId).toBe(mockSession.tenant.tenantId);

    // Tentative de falsification du token
    const parts = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ ...mockSession, role: 'ADMIN' })).toString('base64url');
    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    expect(() => tokenService.verifySessionToken(tamperedToken)).toThrow(UnauthorizedException);
  });

  it('RolesGuard : autorise le rôle adéquat et bloque les accès non privilégiés', () => {
    const mockReflector = {
      getAllAndOverride: vi.fn(),
    };
    rolesGuard = new RolesGuard(mockReflector as any);

    // Scénario 1 : Route réservée aux ADMIN
    mockReflector.getAllAndOverride.mockReturnValue(['ADMIN']);
    const contextLeadUser = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { role: 'LEAD_ENGINEER' } }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as any;

    expect(() => rolesGuard.canActivate(contextLeadUser)).toThrow(ForbiddenException);

    // Scénario 2 : Route accessible aux LEAD_ENGINEER
    mockReflector.getAllAndOverride.mockReturnValue(['ADMIN', 'LEAD_ENGINEER']);
    const isAllowed = rolesGuard.canActivate(contextLeadUser);
    expect(isAllowed).toBe(true);
  });
});
