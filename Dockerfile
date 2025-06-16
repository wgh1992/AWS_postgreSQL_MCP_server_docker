FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY postgreSQL_server.js ./

# Create a non-root user
RUN addgroup -S nodejs && adduser -S appuser -G nodejs
RUN chown -R appuser:nodejs /app

USER appuser

CMD ["node", "postgreSQL_server.js"]
