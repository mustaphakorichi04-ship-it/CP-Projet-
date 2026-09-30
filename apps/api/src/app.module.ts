import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { ProjectsModule } from './projects/projects.module';
import { CalculationsModule } from './calculations/calculations.module';
import { BillingModule } from './billing/billing.module';
import { HealthModule } from './health/health.module';
import { ComplianceModule } from './compliance/compliance.module';
import { OperationsModule } from './operations/operations.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.staging', '.env'],
    }),
    DatabaseModule,
    AuthModule,
    ProjectsModule,
    CalculationsModule,
    BillingModule,
    HealthModule,
    ComplianceModule,
    OperationsModule,
  ],
})
export class AppModule {}

