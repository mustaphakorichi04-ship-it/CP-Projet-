import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { TenantConnectionFactory } from '../database/tenant-connection.factory';
import { AlertingService } from '../operations/alerting.service';

@Injectable()
export class StripeWebhookService {
  private readonly logger = new Logger(StripeWebhookService.name);
  
  // Set mémoire / cache des événements déjà traités (idempotence)
  private readonly processedEvents = new Set<string>();

  constructor(
    private readonly connectionFactory: TenantConnectionFactory,
    private readonly alertingService: AlertingService
  ) {}

  /**
   * Traite un événement Stripe de manière strictement idempotente
   */
  async handleWebhookEvent(event: { id: string; type: string; data: { object: any } }): Promise<{ received: boolean; status: string }> {
    if (!event || !event.id || !event.type) {
      throw new BadRequestException('Payload Stripe webhook invalide.');
    }

    // 1. Vérification d'idempotence : si l'événement a déjà été traité, on acquitte immédiatement sans ré-exécuter
    if (this.processedEvents.has(event.id)) {
      this.logger.warn(`Événement Stripe déjà traité (doublon ignoré) : ${event.id}`);
      return { received: true, status: 'already_processed' };
    }

    this.logger.log(`Traitement webhook Stripe : [${event.type}] ID: ${event.id}`);

    const prisma = await this.connectionFactory.getClientForTenant({
      tenantId: 'system',
      organizationName: 'System',
      plan: 'PRO',
      status: 'ACTIVE',
      isolationMode: 'SHARED_RLS',
    });

    const obj = event.data.object;

    switch (event.type) {
      case 'checkout.session.completed': {
        const tenantId = obj.client_reference_id;
        const customerId = obj.customer;
        const subscriptionId = obj.subscription;

        if (tenantId) {
          await prisma.tenant.update({
            where: { id: tenantId },
            data: {
              stripeCustomerId: customerId,
              stripeSubscriptionId: subscriptionId,
              plan: 'PRO',
            },
          });
          this.logger.log(`Abonnement activé pour le tenant ${tenantId}`);
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscriptionId = obj.id;
        const status = obj.status; // 'active', 'past_due', 'canceled'

        if (status === 'past_due' || status === 'unpaid') {
          this.logger.warn(`Souscription ${subscriptionId} en défaut de paiement ! Passage en PAST_DUE.`);
          await prisma.tenant.updateMany({
            where: { stripeSubscriptionId: subscriptionId },
            data: { status: 'PAST_DUE' },
          });
        } else if (status === 'active') {
          await prisma.tenant.updateMany({
            where: { stripeSubscriptionId: subscriptionId },
            data: { status: 'ACTIVE' },
          });
        }
        break;
      }

      case 'invoice.payment_failed': {
        const customerId = obj.customer;
        // Dunning: on suspend directement le tenant pour bloquer l'accès aux ingénieurs
        await prisma.tenant.updateMany({
          where: { stripeCustomerId: customerId },
          data: { status: 'SUSPENDED' },
        });
        this.logger.error(`Échec de paiement (Dunning) pour le client ${customerId} -> Tenant SUSPENDED`);
        
        await this.alertingService.sendAlert({
          level: 'CRITICAL',
          title: '❌ Échec de Paiement (Dunning)',
          message: `Un paiement a échoué. Le client Stripe ${customerId} a été automatiquement SUSPENDU.`,
          metadata: { customerId, eventId: event.id }
        });
        break;
      }

      case 'customer.subscription.deleted': {
        const customerId = obj.customer;
        // Rétrogradation automatique vers le plan FREE et on suspend/bloque l'accès Pro
        await prisma.tenant.updateMany({
          where: { stripeCustomerId: customerId },
          data: {
            plan: 'FREE',
            stripeSubscriptionId: null,
            status: 'SUSPENDED' // Le client doit régulariser ou accepter les limites du FREE
          },
        });
        this.logger.warn(`Souscription résiliée pour le client ${customerId} -> Rétrogradé en FREE et SUSPENDED`);
        
        await this.alertingService.sendAlert({
          level: 'WARNING',
          title: '📉 Résiliation d\'abonnement',
          message: `Le client Stripe ${customerId} a annulé son abonnement. Il a été rétrogradé au plan FREE.`,
          metadata: { customerId }
        });
        break;
      }

      default:
        this.logger.debug(`Événement Stripe ${event.type} non géré (ignoré sans erreur)`);
    }

    // Marquer l'événement comme traité
    this.processedEvents.add(event.id);

    return { received: true, status: 'success' };
  }
}
