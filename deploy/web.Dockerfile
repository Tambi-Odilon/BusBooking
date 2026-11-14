# Frontend Angular servi par Caddy, qui fait aussi office de reverse proxy HTTPS.
# Construction (depuis la racine du dépôt) : docker build -f deploy/web.Dockerfile -t busbooking-web .
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY angular.json tsconfig.json tsconfig.app.json tailwind.config.js postcss.config.js ./
COPY src ./src
RUN npm run build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist/web/browser /srv
EXPOSE 80 443 443/udp
