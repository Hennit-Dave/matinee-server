import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../http/errors.js';
import { JOB_PAYMENT_SUCCEEDED } from '../jobs/queue.js';
import { createFakePaymentGateway, createFakeStripeEventRepo } from './fakes.js';
import { createWebhookService } from './webhookService.js';

const BODY = Buffer.from('{}');

function boot() {
  const gateway = createFakePaymentGateway();
  const events = createFakeStripeEventRepo();
  const enqueued: { name: string; data: Record<string, string>; jobId: string }[] = [];
  const service = createWebhookService({ gateway, events, enqueue: async (name, data, jobId) => { enqueued.push({ name, data, jobId }); } });
  return { service, gateway, events, enqueued };
}

test('a bad signature is refused before anything is recorded or enqueued', async () => {
  const { service, gateway, events, enqueued } = boot();
  gateway.badSignature = true;
  await assert.rejects(service.handle({ rawBody: BODY, signatureHeader: 't=1,v1=bad' }), (err) => err instanceof ApiError && err.code === 'validation_failed');
  assert.equal(events.events.size, 0);
  assert.equal(enqueued.length, 0);
});

test('a payment_intent.succeeded event is recorded, enqueued once and acked', async () => {
  const { service, gateway, events, enqueued } = boot();
  gateway.nextEvent = { id: 'evt_1', type: 'payment_intent.succeeded', paymentIntentId: 'pi_1' };
  await service.handle({ rawBody: BODY, signatureHeader: 't=1,v1=ok' });
  assert.equal(events.events.get('evt_1')?.status, 'received');
  assert.deepEqual(enqueued, [{ name: JOB_PAYMENT_SUCCEEDED, data: { eventId: 'evt_1', paymentIntentId: 'pi_1' }, jobId: 'evt_1' }]);
});

test('a re-delivered event is skipped — never enqueued twice', async () => {
  const { service, gateway, enqueued } = boot();
  gateway.nextEvent = { id: 'evt_1', type: 'payment_intent.succeeded', paymentIntentId: 'pi_1' };
  await service.handle({ rawBody: BODY, signatureHeader: 't=1,v1=ok' });
  await service.handle({ rawBody: BODY, signatureHeader: 't=1,v1=ok' });
  assert.equal(enqueued.length, 1);
});

test('an event that is not a succeeded payment is recorded but NOT enqueued', async () => {
  const { service, gateway, events, enqueued } = boot();
  gateway.nextEvent = { id: 'evt_2', type: 'payment_intent.created', paymentIntentId: 'pi_2' };
  await service.handle({ rawBody: BODY, signatureHeader: 't=1,v1=ok' });
  assert.equal(events.events.get('evt_2')?.type, 'payment_intent.created');
  assert.equal(enqueued.length, 0);
});
