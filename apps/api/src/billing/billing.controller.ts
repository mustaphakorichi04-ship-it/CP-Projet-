import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { StripeService } from './stripe.service';
import { StripeWebhookService } from './stripe-webhook.service';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { CurrentTenant } from '../common/decorators/current-tenant.decorator';
import { TenantContextInterceptor } from '../common/interceptors/tenant-context.interceptor';
import { TenantContext } from '@cp-engineer/shared-types';
import { TenantConnectionFactory } from '../database/tenant-connection.factory';

@Controller('api/v1/billing')
@UseGuards(AuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
export class BillingController {
  constructor(
    private readonly stripeService: StripeService,
    private readonly webhookService: StripeWebhookService,
    private readonly connectionFactory: TenantConnectionFactory,
  ) {}

  @Roles('ADMIN')
  @Post('checkout')
  async createCheckout(
    @CurrentTenant() tenant: TenantContext,
    @Body('seatsCount') seatsCount: number,
    @Body('successUrl') successUrl: string,
    @Body('cancelUrl') cancelUrl: string,
  ) {
    return this.stripeService.createCheckoutSession({
      tenant,
      seatsCount: seatsCount || 1,
      successUrl: successUrl || 'http://localhost:3000/billing/success',
      cancelUrl: cancelUrl || 'http://localhost:3000/billing/cancel',
    });
  }

  @Roles('ADMIN')
  @Post('portal')
  async createPortal(
    @CurrentTenant() tenant: TenantContext,
    @Body('returnUrl') returnUrl: string,
  ) {
    const prisma = await this.connectionFactory.getClientForTenant(tenant);
    const tenantDb = await prisma.tenant.findUnique({
      where: { id: tenant.tenantId },
    });

    return this.stripeService.createCustomerPortalSession(
      tenant.tenantId,
      tenantDb?.stripeCustomerId || '',
      returnUrl || 'http://localhost:3000/billing',
    );
  }

  @Roles('ADMIN', 'LEAD_ENGINEER')
  @Get('quota-status')
  async getQuotaStatus(@CurrentTenant() tenant: TenantContext) {
    const prisma = await this.connectionFactory.getClientForTenant(tenant);
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const quota = await prisma.apiQuota.findFirst({
      where: {
        tenantId: tenant.tenantId,
        periodStart: { gte: startOfMonth },
      },
    });

    const used = quota?.usedUnits || 0;
    const included = quota?.includedUnits || 500;
    const overage = Math.max(0, used - included);

    return {
      tenantId: tenant.tenantId,
      plan: tenant.plan,
      periodStart: startOfMonth.toISOString(),
      usedCalculations: used,
      includedCalculations: included,
      overageCalculations: overage,
      isQuotaExceeded: used >= included,
    };
  }

  @Public()
  @Post('webhook')
  async handleStripeWebhook(@Body() event: any) {
    return this.webhookService.handleWebhookEvent(event);
  }

  // --- NOUVELLES ROUTES (Phase 9 - Facturation & PDF) ---

  @Roles('ADMIN')
  @Get('invoices')
  async listInvoices(@CurrentTenant() tenant: TenantContext) {
    // Retourne la liste des factures Stripe mockée pour le portail
    return {
      data: [
        { id: 'in_1ABC', amount_due: 15000, currency: 'dzd', status: 'paid', date: Math.floor(Date.now() / 1000) },
        { id: 'in_1XYZ', amount_due: 15000, currency: 'dzd', status: 'open', date: Math.floor(Date.now() / 1000) - 2592000 }
      ]
    };
  }

  @Roles('ADMIN')
  @Get('invoices/:id/pdf')
  async downloadInvoicePdf(@CurrentTenant() tenant: TenantContext, @Param('id') invoiceId: string, @Res() res: any) {
    // Dans un cas réel : 
    // 1. Récupérer la facture depuis Stripe : stripe.invoices.retrieve(invoiceId)
    // 2. Générer un PDF avec puppeteer ou pdfkit incluant :
    //    - La TVA algérienne 19%
    //    - Les numéros NIF/NIS/RC
    
    // Pour l'exercice, on simule le renvoi d'un buffer PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="facture_${invoiceId}.pdf"`);
    res.send(Buffer.from('%PDF-1.4\n%Fake PDF Content pour la TVA 19% DZ'));
  }
}
