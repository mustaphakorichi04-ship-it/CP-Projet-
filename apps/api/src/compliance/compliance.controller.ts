import {
  Controller,
  Get,
  Delete,
  Patch,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ComplianceService } from './compliance.service';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { TenantContextInterceptor } from '../common/interceptors/tenant-context.interceptor';
import { TenantContext, UserSessionDto } from '@cp-engineer/shared-types';

@Controller('api/v1/compliance')
@UseGuards(AuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  @Roles('ADMIN')
  @Get('tenant/export')
  async exportTenantData(@CurrentTenant() tenant: TenantContext) {
    return this.complianceService.exportTenantData(tenant);
  }

  @Roles('ADMIN')
  @Delete('tenant')
  async deleteTenantAccount(
    @CurrentTenant() tenant: TenantContext,
    @Body('confirmationSlug') confirmationSlug: string,
  ) {
    return this.complianceService.deleteTenantAccount(tenant, confirmationSlug);
  }

  // --- NOUVELLES ROUTES : Phase 8 (Utilisateur individuel) ---

  @Get('user/export')
  async exportUserData(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserSessionDto,
    @Query('format') format: 'json' | 'csv' = 'json',
  ) {
    return this.complianceService.exportUserData(tenant, user.userId, format);
  }

  @Delete('user')
  async deleteUserAccount(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserSessionDto,
    @Body('confirmationEmail') confirmationEmail: string,
  ) {
    return this.complianceService.deleteUserAccount(tenant, user.userId, confirmationEmail);
  }

  @Patch('user/consent')
  async updateUserConsent(
    @CurrentTenant() tenant: TenantContext,
    @CurrentUser() user: UserSessionDto,
    @Body() consentData: { hasAcceptedTerms?: boolean; cookieConsent?: Record<string, boolean> },
  ) {
    return this.complianceService.updateUserConsent(tenant, user.userId, consentData);
  }
}
