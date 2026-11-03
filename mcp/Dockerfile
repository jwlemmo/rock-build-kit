FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY guides ./guides
RUN npm run build
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production TRANSPORT=http PORT=8080
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force && mkdir -p /app/logs && chown node:node /app/logs
COPY --from=build /app/dist ./dist
USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
