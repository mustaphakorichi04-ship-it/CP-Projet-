/**
 * @file tenant.dto.ts
 * Contrats d'interfaces pour le Multi-Tenancy SaaS et le RBAC
 */

export type UserRole = 'ADMIN' | 'LEAD_ENGINEER' | 'FIELD_TECHNICIAN' | 'VIEWER';

export type TenantPlan = 'FREE' | 'PRO' | 'ENTERPRISE';

export type TenantStatus = 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED';

export type TenantDatabaseIsolation = 'SHARED_RLS' | 'DEDICATED_DATABASE';

export interface TenantContext {
  tenantId: string;
  organizationName: string;
  plan: TenantPlan;
  status: TenantStatus;
  isolationMode: TenantDatabaseIsolation;
  dedicatedDbUri?: string;
}

export interface UserSessionDto {
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  tenant: TenantContext;
}

export interface ApiQuotaUsageDto {
  tenantId: string;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  calculationsUsedThisMonth: number;
  calculationsIncludedInPlan: number;
  overageCalculations: number;
  isQuotaExceeded: boolean;
}
