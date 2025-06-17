#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as pg from "pg";
import * as http from "http";
import * as url from "url";

const server = new Server(
  {
    name: "mapai-postgres-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Use the provided database URL - adjust host based on environment
const databaseUrl = process.env.DATABASE_URL || "postgresql://mapai_data_reader:barfoo@localhost:5432/mapai_app_db";

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Test database connection
pool.on('connect', () => {
  console.log('Connected to PostgreSQL database');
});

pool.on('error', (err) => {
  console.error('PostgreSQL pool error:', err);
});

// MCP Server handlers - Only tools, no resources
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query",
        description: "Run a read-only SQL query against the MapAI database",
        inputSchema: {
          type: "object",
          properties: {
            sql: { 
              type: "string",
              description: "The SQL query to execute (SELECT statements only)"
            },
          },
          required: ["sql"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "query") {
    const sql = args?.sql;
    
    if (!sql || typeof sql !== 'string') {
      throw new Error("SQL query is required");
    }

    // Basic SQL injection protection - only allow SELECT statements
    const trimmedSql = sql.trim().toLowerCase();
    if (!trimmedSql.startsWith('select')) {
      throw new Error("Only SELECT queries are allowed");
    }

    const client = await pool.connect();
    try {
      await client.query("SET TRANSACTION READ ONLY");
      const result = await client.query(sql);
      
      return {
        content: [
          { 
            type: "text", 
            text: JSON.stringify({
              rows: result.rows,
              rowCount: result.rowCount,
              fields: result.fields?.map(f => ({ name: f.name, dataTypeID: f.dataTypeID }))
            }, null, 2) 
          }
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Query error:', error);
      return {
        content: [
          { 
            type: "text", 
            text: `Error executing query: ${error instanceof Error ? error.message : 'Unknown error'}` 
          }
        ],
        isError: true,
      };
    } finally {
      client.release();
    }
  }

  throw new Error(`Unknown tool: ${name}`);
});

// HTTP Server for direct HTTP communication (no SSE)
const httpServer = http.createServer(async (req, res) => {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url || '', true);
  
  // Handle MCP messages via direct HTTP POST
  if (parsedUrl.pathname === '/mcp' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const requestData = JSON.parse(body);
        console.log('Received MCP request:', JSON.stringify(requestData, null, 2));
        
        let response;

        // Route MCP requests to appropriate handlers
        switch (requestData.method) {
          case 'initialize':
            response = {
              protocolVersion: "2025-03-26",
              capabilities: {
                tools: {}
              },
              serverInfo: {
                name: "mapai-postgres-server",
                version: "0.1.0"
              }
            };
            break;

          case 'notifications/initialized':
            console.log('Client initialized successfully');
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(200);
            res.end(JSON.stringify({status: 'initialized'}));
            return;

          case 'tools/list':
            response = {
              tools: [
                {
                  name: "query",
                  description: "Run a read-only SQL query",
                  inputSchema: {
                    type: "object",
                    properties: {
                      sql: { 
                        type: "string",
                        description: "The SQL query to execute (SELECT statements only)"
                      },
                    },
                    required: ["sql"],
                  },
                },
              ],
            };
            break;

          case 'tools/call':
            const { name, arguments: args } = requestData.params;

            if (name === "query") {
              const sql = args?.sql;
              
              if (!sql || typeof sql !== 'string') {
                throw new Error("SQL query is required");
              }

              // Basic SQL injection protection - only allow SELECT statements
              const trimmedSql = sql.trim().toLowerCase();
              if (!trimmedSql.startsWith('select')) {
                throw new Error("Only SELECT queries are allowed");
              }

              const client = await pool.connect();
              try {
                await client.query("SET TRANSACTION READ ONLY");
                const result = await client.query(sql);
                
                response = {
                  content: [
                    { 
                      type: "text", 
                      text: JSON.stringify({
                        rows: result.rows,
                        rowCount: result.rowCount,
                        fields: result.fields?.map(f => ({ name: f.name, dataTypeID: f.dataTypeID }))
                      }, null, 2) 
                    }
                  ],
                  isError: false,
                };
              } catch (error) {
                console.error('Query error:', error);
                response = {
                  content: [
                    { 
                      type: "text", 
                      text: `Error executing query: ${error instanceof Error ? error.message : 'Unknown error'}` 
                    }
                  ],
                  isError: true,
                };
              } finally {
                client.release();
              }
            } else {
              throw new Error(`Unknown tool: ${name}`);
            }
            break;

          default:
            throw new Error(`Unknown method: ${requestData.method}`);
        }

        const responseData = {
          jsonrpc: "2.0",
          id: requestData.id,
          result: response
        };

        // Send HTTP response
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify(responseData, null, 2));
        
      } catch (error) {
        console.error('Error processing request:', error);
        
        let requestId = null;
        try {
          const requestData = JSON.parse(body);
          requestId = requestData.id;
        } catch {}
        
        const errorResponse = {
          jsonrpc: "2.0",
          id: requestId,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Internal error',
            data: error instanceof Error ? error.stack : undefined
          }
        };
        
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(500);
        res.end(JSON.stringify(errorResponse, null, 2));
      }
    });
      
  } else if (parsedUrl.pathname === '/health' && req.method === 'GET') {
    try {
      // Test database connection
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ 
        status: 'healthy', 
        server: 'mcp-postgres-mapai',
        database: 'connected',
        protocol: 'HTTP',
        timestamp: new Date().toISOString()
      }));
    } catch (error) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(503);
      res.end(JSON.stringify({ 
        status: 'unhealthy', 
        server: 'mcp-postgres-mapai',
        database: 'disconnected',
        error: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString()
      }));
    }
  } else if (parsedUrl.pathname === '/' && req.method === 'GET') {
    // Simple info page
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({
      name: "MapAI PostgreSQL MCP Server",
      version: "0.1.0",
      protocol: "HTTP",
      endpoints: {
        mcp: "/mcp",
        health: "/health"
      },
      tools: ["query"],
      database: "mapai_app_db",
      timestamp: new Date().toISOString()
    }, null, 2));
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({error: 'Not Found', path: parsedUrl.pathname}));
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  await pool.end();
  httpServer.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('Shutting down server...');
  await pool.end();
  httpServer.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});

async function runServer() {
  let port = process.env.PORT ? parseInt(process.env.PORT) : 8833;
  
  try {
    // Test database connection on startup
    const client = await pool.connect();
    console.log('✅ Database connection successful');
    client.release();
    
    // Function to try starting server on a port
    const tryPort = (portToTry) => {
      return new Promise((resolve, reject) => {
        const server = httpServer.listen(portToTry, '0.0.0.0', () => {
          resolve(portToTry);
        });
        
        server.on('error', (err) => {
          if (err.code === 'EADDRINUSE') {
            console.log(`Port ${portToTry} is busy, trying ${portToTry + 1}...`);
            resolve(tryPort(portToTry + 1));
          } else {
            reject(err);
          }
        });
      });
    };
    
    const finalPort = await tryPort(port);
    
    console.log(`🚀 MCP PostgreSQL HTTP server running on port ${finalPort}`);
    console.log(`📡 MCP endpoint: http://localhost:${finalPort}/mcp`);
    console.log(`🏥 Health check: http://localhost:${finalPort}/health`);
    console.log(`ℹ️  Server info: http://localhost:${finalPort}/`);
    console.log(`🗄️  Connected to database: mapai_app_db`);
    console.log(`🔧 Available tools: query`);
    console.log(`📝 Protocol: Direct HTTP (no SSE)`);
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

runServer().catch(console.error);