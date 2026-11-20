# Matinee server (ADR 0009): the API and the BullMQ worker deploy from this one image. The API is the
# default CMD (migrate-on-start, then serve); the worker is a second Railway service that overrides the
# start command (a portless private service, no public URL, no HTTP healthcheck).
#
# Migrate-on-API-start is safe ONLY because there is a single API instance (ADR 0020-era deploy note, see
# docs/ARCHITECTURE.md): `prisma migrate deploy` is idempotent, but two instances booting at once would race
# it. If the API is ever scaled horizontally, move the migration to a release/pre-deploy phase.
FROM node:24-bookworm-slim

WORKDIR /app

# Install deps first (a cached layer), including devDependencies: `prisma migrate deploy` at deploy time
# needs the prisma CLI, so the runtime image keeps it.
COPY package.json package-lock.json ./
RUN npm ci

# The rest of the app, then build. `npm run build` runs the `prebuild` hook (regenerate the Prisma client
# into src/generated/prisma, which needs no database), then `tsc` -> dist/.
COPY . .
RUN npm run build

ENV NODE_ENV=production

# Migrate-on-deploy (idempotent), then serve. `exec` replaces the shell with node so it is PID 1 and
# receives SIGTERM directly. The worker overrides this with `node --enable-source-maps dist/jobs/worker.js`.
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && exec node --enable-source-maps dist/api/main.js"]
