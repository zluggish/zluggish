FROM node:26-bookworm-slim AS build
WORKDIR /usr/src/app/zluggish
RUN npm install --global pnpm@12.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY i18n/package.json i18n/package.json
RUN pnpm install --frozen-lockfile
COPY media media
COPY assets/cdn/style assets/cdn/style
COPY server/ server/
COPY web/ web/
COPY i18n/ i18n/
RUN pnpm build
# Install production dependencies in the same workspace layout; retain both entry outputs.
RUN rm -rf node_modules server/node_modules web/node_modules && pnpm install --prod --frozen-lockfile

FROM node:26-bookworm-slim AS runtime
WORKDIR /usr/src/app/zluggish/server
COPY --from=build /usr/src/app/zluggish/node_modules ../node_modules
COPY --from=build /usr/src/app/zluggish/server/package.json ./
COPY --from=build /usr/src/app/zluggish/server/node_modules ./node_modules
COPY --from=build /usr/src/app/zluggish/server/dist ./dist
COPY --from=build /usr/src/app/zluggish/i18n ../i18n
COPY --from=build /usr/src/app/zluggish/web/package.json ../web/package.json
COPY --from=build /usr/src/app/zluggish/web/node_modules ../web/node_modules
COPY --from=build /usr/src/app/zluggish/web/dist ../web/dist
COPY --from=build /usr/src/app/zluggish/web/src/lib/game-app.dto.d.ts ../web/src/lib/game-app.dto.d.ts
COPY --from=build /usr/src/app/zluggish/web/src/game/render.d.ts ../web/src/game/render.d.ts
COPY assets ../assets
COPY examples ../examples
COPY examples/container/zluggish.config.ts ./zluggish.config.ts
RUN command -v tar && command -v gzip && chmod +x dist/src/cli/bin.js && ln -s /usr/src/app/zluggish/server/dist/src/cli/bin.js /usr/local/bin/zluggish
ENV ZLUGGISH_CONTAINER_STORAGE_DIR=/usr/src/app/zluggish/storage
EXPOSE 443 80 3024/udp 3025 53/udp 8080
VOLUME ["/usr/src/app/zluggish/storage"]
CMD ["node", "dist/src/main.js"]

FROM runtime AS server
