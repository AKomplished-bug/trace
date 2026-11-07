# One image for the web app, the worker and the migrate/seed tasks.
# Base pinned to the multi-arch index digest; refresh: docker buildx imagetools inspect node:24-bookworm-slim
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx next build && rm -rf .next/cache && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# RDS certificate authorities, so DATABASE_URL can use sslmode=verify-full. When AWS updates the
# bundle the build fails; refresh: curl -fsS <url> | shasum -a 256
ADD --chmod=644 --checksum=sha256:90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/app/rds-global-bundle.pem
# Production dependencies only; the worker and scripts run their TypeScript through tsx.
COPY --from=build --chown=node:node /app ./
USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "--port", "3000"]
