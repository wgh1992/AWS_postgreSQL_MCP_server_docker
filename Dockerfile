# Use Node.js 18 Alpine for smaller image size
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy source code
COPY postgreSQL_server.js ./

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S mapai -u 1001

# Change ownership of the app directory
RUN chown -R mapai:nodejs /app
USER mapai

# Expose port (default 8883, but configurable via PORT env var)
EXPOSE 8883

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 8883) + '/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Start the server
CMD ["npm", "start"] 