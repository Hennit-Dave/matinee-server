-- AlterTable: a showtime is cancellable. `cancelled_at` is the single durable source of truth
-- (ADR 0020): null = live, set = cancelled. One primary write sets it; reads filter on it.
ALTER TABLE "showtimes" ADD COLUMN "cancelled_at" TIMESTAMPTZ(3);
