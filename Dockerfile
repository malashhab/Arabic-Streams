FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# data/ holds the auto-generated CONFIG_SECRET when none is provided; mount it as a volume
RUN mkdir -p data && chown -R node:node /app
USER node
EXPOSE 7100
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT:-7100}/health || exit 1
CMD ["node", "dist/index.js"]
