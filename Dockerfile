FROM node:22.23.4-trixie-slim AS building

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive && yarn cache clean

COPY tsconfig.json tsconfig.build.json nest-cli.json .swcrc build-info.json ./
COPY src ./src

RUN yarn typechain && yarn build

FROM node:22.23.4-trixie-slim AS proddeps

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive --production && yarn cache clean

FROM node:22.23.4-trixie-slim AS production

RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    /usr/local/bin/corepack /opt/yarn-v*

WORKDIR /app

COPY --from=building /app/dist ./dist
COPY --from=proddeps /app/node_modules ./node_modules
COPY package.json ./

ARG BUILD_VERSION
ARG BUILD_BRANCH
ARG BUILD_COMMIT
COPY build-info.json ./
COPY docker/healthcheck.js docker/write-build-info.js ./docker/
RUN if [ -n "$BUILD_VERSION$BUILD_BRANCH$BUILD_COMMIT" ]; then \
      node docker/write-build-info.js "$BUILD_VERSION" "$BUILD_BRANCH" "$BUILD_COMMIT"; \
    fi

EXPOSE 8080

# The node user of the base image, by number so that a runAsNonRoot check can verify it without runAsUser
USER 1000:1000

HEALTHCHECK --interval=60s --timeout=10s --retries=3 CMD ["node", "docker/healthcheck.js"]

ENV NODE_OPTIONS="--max-old-space-size=8192 --experimental-vm-modules"

CMD ["node", "dist/main"]
