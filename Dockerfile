FROM node:22-bookworm AS building

WORKDIR /app

COPY package.json yarn.lock build-info.json ./
COPY ./tsconfig*.json ./nest-cli.json ./.swcrc ./
COPY ./src ./src

RUN yarn install --immutable && yarn cache clean && yarn typechain
RUN yarn build

FROM building AS production

WORKDIR /app

COPY --from=building /app/dist ./dist
COPY --from=building /app/node_modules ./node_modules
COPY ./package.json ./
COPY ./build-info.json ./

USER node

HEALTHCHECK --interval=60s --timeout=10s --retries=3 \
  CMD sh -c "wget -nv -t1 --spider http://127.0.0.1:$HTTP_PORT/health" || exit 1

CMD ["yarn", "start:prod"]
