FROM node:24.14.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node vendor ./vendor
COPY --chown=node:node LICENSE ./LICENSE
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV NODE_ENV=production DATABASE_PATH=/app/data/calls.sqlite
EXPOSE 8080
CMD ["node", "src/server.js"]
