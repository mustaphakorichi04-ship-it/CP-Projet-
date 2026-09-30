import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ProjectsService, CreateProjectDto, UpdateProjectDto } from './projects.service';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContextInterceptor } from '../common/interceptors/tenant-context.interceptor';
import { TenantContext } from '@cp-engineer/shared-types';

@Controller('api/v1/projects')
@UseInterceptors(TenantContextInterceptor)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  async getProjects(@CurrentTenant() tenant: TenantContext) {
    return this.projectsService.findAllForTenant(tenant);
  }

  @Get(':id')
  async getProject(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
  ) {
    return this.projectsService.findOne(tenant, id);
  }

  @Post()
  async createProject(
    @CurrentTenant() tenant: TenantContext,
    @Body() dto: CreateProjectDto,
  ) {
    return this.projectsService.create(tenant, dto);
  }

  @Put(':id')
  async updateProject(
    @CurrentTenant() tenant: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
  ) {
    return this.projectsService.update(tenant, id, dto);
  }
}
