# Docker Hardened Images: a pull needs `docker login dhi.io`. Only the -dev stages have a shell.
FROM dhi.io/node:22.23.5-debian13-dev@sha256:30db03f92266c8f6d4098229b573f5bbae0a92b363f593e18edace583d2b18ea AS building

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive && yarn cache clean

COPY tsconfig.json tsconfig.build.json nest-cli.json .swcrc build-info.json ./
COPY src ./src

RUN yarn typechain && yarn build

ARG BUILD_VERSION
ARG BUILD_BRANCH
ARG BUILD_COMMIT
COPY docker/write-build-info.js ./docker/
RUN if [ -n "$BUILD_VERSION$BUILD_BRANCH$BUILD_COMMIT" ]; then \
      node docker/write-build-info.js "$BUILD_VERSION" "$BUILD_BRANCH" "$BUILD_COMMIT"; \
    fi

FROM dhi.io/node:22.23.5-debian13-dev@sha256:30db03f92266c8f6d4098229b573f5bbae0a92b363f593e18edace583d2b18ea AS proddeps

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive --production && yarn cache clean

FROM dhi.io/node:22.23.5-debian13@sha256:b6d82c03ceb8763766b387c3c8ff11fa320cf516570f253e704f049f0b922143 AS production

WORKDIR /app

COPY --from=building /app/dist ./dist
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=building /app/build-info.json ./
COPY package.json ./
COPY docker/healthcheck.js ./docker/

EXPOSE 8080

# The node user of the base image, by number so that a runAsNonRoot check can verify it without runAsUser
USER 1000:1000

HEALTHCHECK --interval=60s --timeout=10s --retries=3 CMD ["node", "docker/healthcheck.js"]

ENV NODE_OPTIONS="--max-old-space-size=8192 --experimental-vm-modules"

CMD ["node", "dist/main"]
