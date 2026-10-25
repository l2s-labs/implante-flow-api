FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
LABEL org.opencontainers.image.source=https://github.com/l2s-labs/implante-flow-api
LABEL org.opencontainers.image.description="API clínica do Implante Flow"
LABEL org.opencontainers.image.licenses=UNLICENSED
ENV NODE_ENV=production
ENV APP_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
RUN addgroup -S app && adduser -S app -G app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
USER app
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
