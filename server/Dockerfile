FROM node:24-bookworm-slim AS build
WORKDIR /usr/src/app/zwift-offline/server
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate
COPY server/package.json server/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY server/ .
RUN pnpm build && pnpm prune --prod

FROM node:24-bookworm-slim AS runtime
WORKDIR /usr/src/app/zwift-offline/server
COPY --from=build /usr/src/app/zwift-offline/server/package.json ./
COPY --from=build /usr/src/app/zwift-offline/server/node_modules ./node_modules
COPY --from=build /usr/src/app/zwift-offline/server/dist ./dist
COPY assets ../assets
COPY server/examples ./examples
COPY server/examples/container/zluggish.config.ts ./zluggish.config.ts
EXPOSE 443 80 3024/udp 3025 53/udp
VOLUME /usr/src/app/zwift-offline/storage
CMD ["node", "dist/src/main.js"]

FROM runtime AS server
