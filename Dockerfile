# Build stage: compile TypeScript
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY test ./test
RUN npx tsc -p tsconfig.json

# Runtime stage: production dependencies + compiled output only
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
USER node
# stdio by default; run with `--transport http --host 0.0.0.0` (and HTTP_AUTH_SECRET) to serve HTTP
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD [ "sh", "-c", "[ \"$MCP_TRANSPORT\" != http ] || wget -qO- http://127.0.0.1:${PORT:-3000}/healthz >/dev/null" ]
ENTRYPOINT ["node", "dist/src/index.js"]
