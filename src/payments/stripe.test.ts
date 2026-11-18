import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { createStripeGateway } from './stripe.js';

/**
 * The real Stripe SDK's signature verification: this is the one seam we do NOT fake. It proves the gateway
 * accepts a genuinely-signed webhook and rejects a tampered one, using Stripe's own header generator (no
 * network, no real secret).
 */

const WEBHOOK_SECRET = 'whsec_test_secret';

function signedPayload(payload: string, secret = WEBHOOK_SECRET): string {
  return new Stripe('sk_test_dummy').webhooks.generateTestHeaderString({ payload, secret });
}

test('constructEvent accepts a real signature and reads the event id, type and PaymentIntent id', () => {
  const gateway = createStripeGateway({ secretKey: 'sk_test_dummy', webhookSecret: WEBHOOK_SECRET });
  const payload = JSON.stringify({
    id: 'evt_123',
    object: 'event',
    type: 'payment_intent.succeeded',
    data: { object: { id: 'pi_123', object: 'payment_intent' } },
  });
  const event = gateway.constructEvent(Buffer.from(payload), signedPayload(payload));
  assert.equal(event.id, 'evt_123');
  assert.equal(event.type, 'payment_intent.succeeded');
  assert.equal(event.paymentIntentId, 'pi_123');
});

test('constructEvent rejects a tampered body and a signature from another secret', () => {
  const gateway = createStripeGateway({ secretKey: 'sk_test_dummy', webhookSecret: WEBHOOK_SECRET });
  const payload = JSON.stringify({ id: 'evt_123', object: 'event', type: 'payment_intent.succeeded', data: { object: { id: 'pi_123' } } });

  assert.throws(() => gateway.constructEvent(Buffer.from('{"id":"evt_forged"}'), signedPayload(payload)), /signature/i);
  assert.throws(() => gateway.constructEvent(Buffer.from(payload), signedPayload(payload, 'whsec_other_secret')), /signature/i);
});

test('constructEvent without a webhook secret refuses (a worker that only refunds must not verify)', () => {
  const gateway = createStripeGateway({ secretKey: 'sk_test_dummy' });
  assert.throws(() => gateway.constructEvent(Buffer.from('{}'), 't=1,v1=x'), /STRIPE_WEBHOOK_SECRET is not set/);
});
