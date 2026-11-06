# The same base in every stage, written out in full: the hadolint of the CI does not resolve a global ARG in FROM
FROM node:22.23.4-trixie-slim AS building

WORKDIR /app

# Manifests before the source, so a source change does not bust the dependency layer
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive && yarn cache clean

# build-info.json is resolved by the type check through the path alias "build-info"
COPY tsconfig.json tsconfig.build.json nest-cli.json .swcrc build-info.json ./
COPY src ./src

RUN yarn typechain && yarn build

# Production-only dependency tree for the runtime stage
FROM node:22.23.4-trixie-slim AS proddeps

WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive --production && yarn cache clean

FROM node:22.23.4-trixie-slim AS production

# The app starts with node. npm, yarn and corepack are not needed at runtime, and the npm bundled with the base image
# carries its own CVEs.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    /usr/local/bin/corepack /opt/yarn-v*

WORKDIR /app

COPY --from=building /app/dist ./dist
COPY --from=proddeps /app/node_modules ./node_modules
COPY package.json ./

# Build metadata for the startup log and the build_info metric. The platform build workflow passes the three build
# args together; regenerate build-info.json from them. A build without any of them keeps the file from the checkout
# (the placeholders, or the values written by the release pipeline before the build). A partial set is a mistake
# and fails the build.
ARG BUILD_VERSION
ARG BUILD_BRANCH
ARG BUILD_COMMIT
COPY build-info.json ./
RUN if [ -n "$BUILD_VERSION$BUILD_BRANCH$BUILD_COMMIT" ]; then \
      if [ -z "$BUILD_VERSION" ] || [ -z "$BUILD_BRANCH" ] || [ -z "$BUILD_COMMIT" ]; then \
        echo "BUILD_VERSION, BUILD_BRANCH and BUILD_COMMIT must be set together" >&2; exit 1; \
      fi; \
      printf '{"version":"%s","branch":"%s","commit":"%s"}\n' \
        "$BUILD_VERSION" "$BUILD_BRANCH" "$BUILD_COMMIT" > build-info.json; \
    fi

EXPOSE 8080

# The node user of the base image, by number so that a runAsNonRoot check can verify it without runAsUser
USER 1000:1000

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.HTTP_PORT || 8080}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

CMD ["node", "--max-old-space-size=8192", "--experimental-vm-modules", "dist/main"]
