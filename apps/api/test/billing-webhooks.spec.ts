import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StripeWebhookService } from '../src/billing/stripe-webhook.service';

describe('Stripe Billing & Idempotent Webhook Tests', () => {
  let webhookService: StripeWebhookService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      tenant: {
        update: vi.fn().mockResolvedValue({ id: 'tenant-1', plan: 'PRO' }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const mockFactory = {
      getClientForTenant: vi.fn().mockResolvedValue(mockPrisma),
    };

    webhookService = new StripeWebhookService(mockFactory as any);
  });

  it('checkout.session.completed : active le plan PRO et associe les IDs Stripe', async () => {
    const event = {
      id: 'evt_test_checkout_123',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: '00000000-0000-0000-0000-000000000001',
          customer: 'cus_stripe_123',
          subscription: 'sub_stripe_123',
        },
      },
    };

    const result = await webhookService.handleWebhookEvent(event);

    expect(result.received).toBe(true);
    expect(result.status).toBe('success');
    expect(mockPrisma.tenant.update).toHaveBeenCalledWith({
      where: { id: '00000000-0000-0000-0000-000000000001' },
      data: {
        stripeCustomerId: 'cus_stripe_123',
        stripeSubscriptionId: 'sub_stripe_123',
        plan: 'PRO',
      },
    });
  });

  it('Idempotence : un événement Stripe ré-émis avec le même ID est ignoré', async () => {
    const event = {
      id: 'evt_test_duplicate_999',
      type: 'checkout.session.completed',
      data: {
        object: {
          client_reference_id: 'tenant-abc',
          customer: 'cus_abc',
          subscription: 'sub_abc',
        },
      },
    };

    // Premier appel
    const res1 = await webhookService.handleWebhookEvent(event);
    expect(res1.status).toBe('success');

    // Deuxième appel avec le même event.id
    const res2 = await webhookService.handleWebhookEvent(event);
    expect(res2.status).toBe('already_processed');
    // Vérifie que prisma.update n'a été appelé qu'une seule fois
    expect(mockPrisma.tenant.update).toHaveBeenCalledTimes(1);
  });

  it('customer.subscription.deleted : rétrograde le tenant en plan FREE', async () => {
    const event = {
      id: 'evt_test_cancel_456',
      type: 'customer.subscription.deleted',
      data: {
        object: {
          customer: 'cus_stripe_canceled',
        },
      },
    };

    const result = await webhookService.handleWebhookEvent(event);

    expect(result.received).toBe(true);
    expect(mockPrisma.tenant.updateMany).toHaveBeenCalledWith({
      where: { stripeCustomerId: 'cus_stripe_canceled' },
      data: {
        plan: 'FREE',
        stripeSubscriptionId: null,
      },
    });
  });
});
