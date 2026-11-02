FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry=https://registry.npmjs.org && npm cache clean --force
COPY shared ./shared
COPY server ./server
COPY cloudflare/parser/server.mjs ./cloudflare/parser/server.mjs
ENV NODE_ENV=production
USER node
EXPOSE 8080
CMD ["node", "cloudflare/parser/server.mjs"]
