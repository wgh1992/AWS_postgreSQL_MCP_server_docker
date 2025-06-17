# MapAI PostgreSQL MCP Server - Docker Setup

A Model Context Protocol (MCP) server that provides read-only access to PostgreSQL databases via HTTP endpoints.

## Quick Start

### 1. Configure Environment

Copy the example environment file and configure your database:

```bash
cp .env.example .env
```  

Edit `.env` and set your `DATABASE_URL`:

```bash
DATABASE_URL=postgresql://username:password@host:port/database_name
```

### 2. Run with Docker Compose

```bash
# Build and start the server
docker-compose up --build

# Run in background
docker-compose up -d --build
```

### 3. Test the Server

```bash
# Health check
curl http://localhost:8833/health

# Server info
curl http://localhost:8833/

# Test MCP query (example)
curl -X POST http://localhost:8833/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "query",
      "arguments": {
        "sql": "SELECT version();"
      }
    }
  }'
```

## Configuration

### Environment Variables

- `DATABASE_URL`: PostgreSQL connection string (required)
- `PORT`: Server port (default: 8833)
- `NODE_ENV`: Environment mode (default: production)

### Database URL Examples

```bash
# Local PostgreSQL
DATABASE_URL=postgresql://user:password@localhost:5432/database

# Docker host access (from container to host)
DATABASE_URL=postgresql://user:password@host.docker.internal:5432/database

# AWS RDS
DATABASE_URL=postgresql://user:password@your-rds.region.rds.amazonaws.com:5432/database

# Google Cloud SQL
DATABASE_URL=postgresql://user:password@your-cloud-sql-ip:5432/database
```

## Docker Commands

```bash
# Build the image
docker build -t mapai-mcp-server .

# Run container with environment variables
docker run -p 8833:8833 \
  -e DATABASE_URL="postgresql://user:pass@host:5432/db" \
  mapai-mcp-server

# View logs
docker-compose logs -f

# Stop services
docker-compose down

# Rebuild and restart
docker-compose up --build --force-recreate
```

## API Endpoints

- `GET /` - Server information
- `GET /health` - Health check
- `POST /mcp` - MCP protocol endpoint

## Security Features

- Read-only database transactions
- SQL injection protection (SELECT only)
- Non-root user in container
- Health checks included
- CORS enabled for web clients

## Troubleshooting

### Connection Issues

1. **Database connection failed**: Check your `DATABASE_URL` format
2. **Port already in use**: Change `PORT` in `.env` or use different port mapping
3. **Container can't reach database**: Use `host.docker.internal` for local databases

### Debug Mode

Run with debug logging:

```bash
docker-compose up --build
# Check logs for connection details
```

## Development

```bash
# Install dependencies locally
npm install

# Run in development mode
npm run dev
``` 