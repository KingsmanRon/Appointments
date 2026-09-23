FROM node:20.20.2-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/core-api/package.json apps/core-api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/console/package.json apps/console/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/policy/package.json packages/policy/package.json
COPY packages/observability/package.json packages/observability/package.json
RUN npm install
COPY . .
RUN npm run build
FROM node:20.20.2-bookworm-slim
USER node
WORKDIR /app
COPY --from=build --chown=node:node /app /app
ENV NODE_ENV=production
CMD ["node","apps/core-api/dist/server.js"]
