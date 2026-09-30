import {
  Controller,
  Post,
  Body,
  UseInterceptors,
} from '@nestjs/common';
import { CpEngineeringCoreService } from './cp-engineering-core.service';
import { CalculationAuditService } from './calculation-audit.service';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContextInterceptor } from '../common/interceptors/tenant-context.interceptor';
import {
  TenantContext,
  RequiredCurrentRequestDto,
  RequiredCurrentResponseDto,
  SACPDesignRequestDto,
  SACPDesignResponseDto,
  ICCPDesignRequestDto,
  ICCPDesignResponseDto,
} from '@cp-engineer/shared-types';

@Controller('api/v1/calculations')
@UseInterceptors(TenantContextInterceptor)
export class CalculationsController {
  constructor(
    private readonly engineeringCore: CpEngineeringCoreService,
    private readonly auditService: CalculationAuditService,
  ) {}

  @Post('required-current')
  async calculateRequiredCurrent(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: RequiredCurrentRequestDto,
  ): Promise<RequiredCurrentResponseDto> {
    const start = Date.now();
    const result = this.engineeringCore.calculateRequiredCurrent(dto);
    const durationMs = Date.now() - start;

    // Audit asynchrone non bloquant
    void this.auditService.recordCalculation(tenant, 'SACP', dto, result, durationMs);

    return result;
  }

  @Post('sacp')
  async designSACP(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: SACPDesignRequestDto,
  ): Promise<SACPDesignResponseDto> {
    const start = Date.now();
    const result = this.engineeringCore.designSACP(dto);
    const durationMs = Date.now() - start;

    void this.auditService.recordCalculation(tenant, 'SACP', dto, result, durationMs);

    return result;
  }

  @Post('iccp')
  async designICCP(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: ICCPDesignRequestDto,
  ): Promise<ICCPDesignResponseDto> {
    const start = Date.now();
    const result = this.engineeringCore.designICCP(dto);
    const durationMs = Date.now() - start;

    void this.auditService.recordCalculation(tenant, 'ICCP', dto, result, durationMs);

    return result;
  }
}
