FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache imagemagick imagemagick-jpeg imagemagick-webp && mkdir -p /data && chown node:node /data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY server.js media-store.js thumbnail.js portable.js ./
COPY public ./public
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8765 DATABASE_PATH=/data/kinexport.sqlite
USER node
EXPOSE 8765
CMD ["node", "server.js"]
