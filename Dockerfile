# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# BenchBox backend — multi-stage build (HOA protocol 04), run on the shared EC2 box.
#
#   builder : install ALL deps, generate the Prisma client, compile TS -> dist/
#             (also the image the `migrate` service runs: the Prisma CLI is a dev dependency)
#   runner  : production deps only + compiled app + generated Prisma client, non-root
#
# The build needs no secrets: `tsc` and `prisma generate` don't connect to the database.
# Everything is supplied at runtime from the server's .env.
# ---------------------------------------------------------------------------

# ----------------------------- Builder -------------------------------------
FROM node:22-slim AS builder

# Prisma's query engine needs OpenSSL to be generated.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (cached unless package*.json changes).
COPY package*.json ./
RUN npm ci

# Generate the Prisma client BEFORE compiling — tsc imports its generated types.
COPY prisma ./prisma
RUN npx prisma generate

# Compile TypeScript -> dist/
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ----------------------------- Runner --------------------------------------
FROM node:22-slim AS runner

# The Prisma query engine needs OpenSSL at runtime too.
RUN apt-get update -y \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# src/config/env.ts reads PORT; docker-compose.prod.yml publishes it on a loopback host port.
ENV PORT=8080

WORKDIR /app

# Production dependencies only (no dev toolchain in the final image).
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled app and the generated Prisma client + engine.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Drop root privileges — the official image ships a non-root `node` user.
USER node

EXPOSE 8080

CMD ["node", "dist/app.js"]
