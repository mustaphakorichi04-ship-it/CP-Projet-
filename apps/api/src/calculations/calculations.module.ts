import { Module } from '@nestjs/common';
import { CalculationsController } from './calculations.controller';
import { CpEngineeringCoreService } from './cp-engineering-core.service';
import { CalculationAuditService } from './calculation-audit.service';

@Module({
  controllers: [CalculationsController],
  providers: [CpEngineeringCoreService, CalculationAuditService],
  exports: [CpEngineeringCoreService, CalculationAuditService],
})
export class CalculationsModule {}
