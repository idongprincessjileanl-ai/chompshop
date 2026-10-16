# Chom Shop API image. Build from the REPOSITORY ROOT (it needs backend/ and frontend/):
#   docker build -f backend/Dockerfile -t chomshop-app .
FROM node:20-alpine

WORKDIR /app/backend
ENV NODE_ENV=production

# Install dependencies first (cached between builds)
COPY backend/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# API code and the website it serves
COPY backend/ ./
COPY frontend/ /app/frontend/
RUN mkdir -p uploads/proofs logs backups && chown -R node:node /app

# Do not run as root
USER node
EXPOSE 3000

# Docker marks the container unhealthy (and the load balancer skips it) if this fails
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
