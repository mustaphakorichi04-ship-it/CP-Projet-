import { Injectable, BadRequestException, UnauthorizedException } from '@nestjs/common';
import { TenantConnectionFactory } from '../database/tenant-connection.factory';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';
import { UserSessionDto, UserRole, TenantPlan, TenantDatabaseIsolation } from '@cp-engineer/shared-types';

export interface RegisterTenantDto {
  organizationName: string;
  slug: string;
  adminEmail: string;
  adminPassword: string;
  adminFirstName: string;
  adminLastName: string;
  plan?: TenantPlan;
}

export interface LoginDto {
  email: string;
  password: string;
  tenantSlug: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly connectionFactory: TenantConnectionFactory,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
  ) {}

  /**
   * Inscription d'un nouveau Tenant avec création du compte Administrateur
   */
  async registerTenant(dto: RegisterTenantDto): Promise<{ user: UserSessionDto; token: string }> {
    const passwordHash = await this.passwordService.hashPassword(dto.adminPassword);

    // On utilise le client partagé
    const prisma = await this.connectionFactory.getClientForTenant({
      tenantId: 'system',
      organizationName: 'System',
      plan: 'PRO',
      isolationMode: 'SHARED_RLS',
    });

    // Vérification de l'unicité du slug
    const existingTenant = await prisma.tenant.findUnique({
      where: { slug: dto.slug },
    });
    if (existingTenant) {
      throw new BadRequestException(`L'identifiant d'organisation "${dto.slug}" est déjà utilisé.`);
    }

    const tenant = await prisma.tenant.create({
      data: {
        name: dto.organizationName,
        slug: dto.slug,
        plan: dto.plan || 'PRO',
        isolationMode: 'SHARED_RLS',
        users: {
          create: {
            email: dto.adminEmail.toLowerCase().trim(),
            passwordHash,
            firstName: dto.adminFirstName,
            lastName: dto.adminLastName,
            role: 'ADMIN',
          },
        },
      },
      include: {
        users: true,
      },
    });

    const adminUser = tenant.users[0];
    const session: UserSessionDto = {
      userId: adminUser.id,
      email: adminUser.email,
      firstName: adminUser.firstName,
      lastName: adminUser.lastName,
      role: adminUser.role as UserRole,
      tenant: {
        tenantId: tenant.id,
        organizationName: tenant.name,
        plan: tenant.plan as TenantPlan,
        status: tenant.status as any,
        isolationMode: tenant.isolationMode as TenantDatabaseIsolation,
      },
    };

    const token = this.tokenService.generateSessionToken(session);
    return { user: session, token };
  }

  /**
   * Connexion avec email, mot de passe et slug d'organisation
   */
  async login(dto: LoginDto): Promise<{ user: UserSessionDto; token: string }> {
    const prisma = await this.connectionFactory.getClientForTenant({
      tenantId: 'system',
      organizationName: 'System',
      plan: 'PRO',
      isolationMode: 'SHARED_RLS',
    });

    const tenant = await prisma.tenant.findUnique({
      where: { slug: dto.tenantSlug },
      include: {
        users: {
          where: { email: dto.email.toLowerCase().trim() },
        },
      },
    });

    if (!tenant || tenant.users.length === 0) {
      throw new UnauthorizedException('Identifiants ou organisation incorrects.');
    }

    const user = tenant.users[0];
    const isPasswordValid = await this.passwordService.verifyPassword(dto.password, user.passwordHash);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Identifiants ou organisation incorrects.');
    }

    const session: UserSessionDto = {
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role as UserRole,
      tenant: {
        tenantId: tenant.id,
        organizationName: tenant.name,
        plan: tenant.plan as TenantPlan,
        status: tenant.status as any,
        isolationMode: tenant.isolationMode as TenantDatabaseIsolation,
        dedicatedDbUri: tenant.dedicatedDbUri || undefined,
      },
    };

    const token = this.tokenService.generateSessionToken(session);
    return { user: session, token };
  }
}
