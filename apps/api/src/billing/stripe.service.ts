import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TenantContext } from '@cp-engineer/shared-types';

export interface CreateCheckoutSessionParams {
  tenant: TenantContext;
  seatsCount: number;
  successUrl: string;
  cancelUrl: string;
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripeApiKey = process.env.STRIPE_SECRET_KEY || 'sk_test_mock_stripe_key_for_staging';
  private readonly pricePerSeatMonthly = process.env.STRIPE_PRICE_SEAT_ID || 'price_seat_monthly_pro';
  private readonly priceMeteredCalculations = process.env.STRIPE_PRICE_METERED_ID || 'price_metered_calculations';

  /**
   * Crée une session Checkout Stripe pour abonner l'organisation
   * avec N sièges et l'item de consommation à l'usage pour les calculs
   */
  async createCheckoutSession(params: CreateCheckoutSessionParams): Promise<{ url: string }> {
    const { tenant, seatsCount, successUrl, cancelUrl } = params;

    if (seatsCount < 1) {
      throw new BadRequestException('Le nombre de sièges doit être au minimum de 1.');
    }

    this.logger.log(`Création session Stripe Checkout pour ${tenant.organizationName} (${seatsCount} sièges)...`);

    // En environnement réel, fait appel au SDK Stripe officiel :
    // const session = await stripe.checkout.sessions.create({ ... })
    // On simule l'URL de redirection sécurisée Stripe
    const mockCheckoutUrl = `https://checkout.stripe.com/c/pay/cs_test_${tenant.tenantId}?seats=${seatsCount}`;

    return {
      url: mockCheckoutUrl,
    };
  }

  /**
   * Crée une session pour le portail client Stripe (self-service factures, CB, résiliation)
   */
  async createCustomerPortalSession(tenantId: string, stripeCustomerId: string, returnUrl: string): Promise<{ url: string }> {
    if (!stripeCustomerId) {
      throw new BadRequestException('Aucun compte client Stripe associé à cette organisation.');
    }

    this.logger.log(`Ouverture Stripe Billing Portal pour le client ${stripeCustomerId}...`);
    return {
      url: `https://billing.stripe.com/p/session/portal_test_${tenantId}?return_url=${encodeURIComponent(returnUrl)}`,
    };
  }

  /**
   * Déclare à Stripe la consommation de calculs en surplus (Metered Usage Record)
   */
  async reportMeteredUsage(subscriptionItemId: string, unitsToBill: number, timestamp: number): Promise<string> {
    this.logger.log(`Déclaration usage Stripe : ${unitsToBill} calculs supplémentaires pour ${subscriptionItemId}`);
    
    // Appel Stripe SDK : stripe.subscriptionItems.createUsageRecord(subscriptionItemId, { quantity, timestamp, action: 'increment' })
    const usageRecordId = `mrec_${Date.now()}_${unitsToBill}`;
    return usageRecordId;
  }
}
