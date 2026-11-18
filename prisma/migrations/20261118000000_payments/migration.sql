-- CreateTable
CREATE TABLE "orders" (
    "id" UUID NOT NULL,
    "reference" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "showtime_id" UUID NOT NULL,
    "seat_ids" JSONB NOT NULL,
    "seat_total_cents" INTEGER NOT NULL,
    "fee_cents" INTEGER NOT NULL,
    "total_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "stripe_payment_intent_id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "stripe_object_id" TEXT NOT NULL,
    "stripe_event_id" TEXT,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_stripe_events" (
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payment_intent_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'received',
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "processed_stripe_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "orders_reference_key" ON "orders"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "orders_stripe_payment_intent_id_key" ON "orders"("stripe_payment_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_owner_id_idempotency_key_key" ON "orders"("owner_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "orders_owner_id_idx" ON "orders"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_stripe_object_id_key" ON "ledger_entries"("stripe_object_id");

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
