import { Global, Module } from '@nestjs/common';
import { TenantConnectionFactory } from './tenant-connection.factory';

@Global()
@Module({
  providers: [TenantConnectionFactory],
  exports: [TenantConnectionFactory],
})
export class DatabaseModule {}
