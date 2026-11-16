-- CreateTable
CREATE TABLE "seats" (
    "id" UUID NOT NULL,
    "screen_id" TEXT NOT NULL,
    "row" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'standard',

    CONSTRAINT "seats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "seats_screen_id_row_number_key" ON "seats"("screen_id", "row", "number");

-- AddForeignKey
ALTER TABLE "seats" ADD CONSTRAINT "seats_screen_id_fkey" FOREIGN KEY ("screen_id") REFERENCES "screens"("id") ON DELETE CASCADE ON UPDATE CASCADE;
