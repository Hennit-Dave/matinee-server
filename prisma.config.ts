import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Migrations require a direct (unpooled) Postgres connection; runtime queries use the pooled
    // DATABASE_URL / DATABASE_READ_URL in src/db/clients.ts (ADR 0010).
    url: process.env.DATABASE_DIRECT_URL ?? process.env.TEST_DATABASE_URL ?? '',
  },
});
