-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "reference" UUID NOT NULL,
    "showtime_id" UUID NOT NULL,
    "seat_id" UUID NOT NULL,
    "owner_id" TEXT NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bookings_showtime_id_seat_id_key" ON "bookings"("showtime_id", "seat_id");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_showtime_id_fkey" FOREIGN KEY ("showtime_id") REFERENCES "showtimes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_seat_id_fkey" FOREIGN KEY ("seat_id") REFERENCES "seats"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

