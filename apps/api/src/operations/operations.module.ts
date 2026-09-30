import { Module } from '@nestjs/common';
import { AlertingService } from './alerting.service';
import { OperationsController } from './operations.controller';
import { DatabaseModule } from '../database/database.module';

@Module({
  imports: [DatabaseModule],
  controllers: [OperationsController],
  providers: [AlertingService],
  exports: [AlertingService],
})
export class OperationsModule {}
