#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as pg from "pg";
import * as http from "http";
import * as url from "url";
import { randomBytes } from "crypto";

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

// Generate session ID
function generateSessionId() {
  return randomBytes(32).toString('hex');
}

// Store active sessions
const activeSessions = new Map();

// HTTP Server for SSE endpoint
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
  
  // Handle SSE connection
  if (parsedUrl.pathname === '/sse' && req.method === 'GET') {
    const sessionId = generateSessionId();
    
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Cache-Control,Content-Type'
    });

    // Send initial endpoint event
    res.write(`event: endpoint\n`);
    res.write(`data: /sse/message?sessionId=${sessionId}\n\n`);

    // Store session
    activeSessions.set(sessionId, {
      response: res,
      created: Date.now()
    });

    // Handle client disconnect
    req.on('close', () => {
      activeSessions.delete(sessionId);
      console.log(`Session ${sessionId} disconnected`);
    });

    req.on('error', (err) => {
      console.error(`Session ${sessionId} error:`, err);
      activeSessions.delete(sessionId);
    });

    console.log(`New SSE connection established with session ${sessionId}`);
    return;
  }

  // Handle MCP messages
  if (parsedUrl.pathname === '/sse/message' && req.method === 'POST') {
    const sessionId = parsedUrl.query.sessionId;
    
    if (!sessionId || !activeSessions.has(sessionId)) {
      res.writeHead(400, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: 'Invalid session'}));
      return;
    }
    
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      const session = activeSessions.get(sessionId);
      if (!session) {
        res.writeHead(400, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'Session expired'}));
        return;
      }

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
            // This is a notification, no response needed via SSE
            console.log('Client initialized successfully');
            // Send acknowledgment via HTTP only
            res.setHeader('Content-Type', 'application/json');
            res.writeHead(200);
            res.end(JSON.stringify({status: 'ok'}));
            return;

          case 'tools/list':
            response = {
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

        // Send response via SSE only if session is still active
        if (activeSessions.has(sessionId)) {
          try {
            session.response.write(`event: message\n`);
            session.response.write(`data: ${JSON.stringify(responseData)}\n\n`);
          } catch (sseError) {
            console.error('Error writing to SSE:', sseError);
          }
        }
        
        // Send HTTP response - don't end the connection
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({status: 'sent'}));
        
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
        
        // Send error via SSE if session is still active
        if (sessionId && activeSessions.has(sessionId)) {
          try {
            const session = activeSessions.get(sessionId);
            session.response.write(`event: error\n`);
            session.response.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
          } catch (sseError) {
            console.error('Error writing error to SSE:', sseError);
          }
        }
        
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
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// Clean up expired sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of activeSessions.entries()) {
    if (now - session.created > 30 * 60 * 1000) { // 30 minutes
      try {
        session.response.end();
      } catch (error) {
        console.error('Error ending expired session:', error);
      }
      activeSessions.delete(sessionId);
      console.log(`Cleaned up expired session ${sessionId}`);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  
  // Close all SSE connections
  for (const [sessionId, session] of activeSessions.entries()) {
    try {
      session.response.write(`event: close\n`);
      session.response.write(`data: Server shutting down\n\n`);
      session.response.end();
    } catch (error) {
      console.error('Error closing session during shutdown:', error);
    }
  }
  activeSessions.clear();
  
  await pool.end();
  httpServer.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});

process.on('SIGTERM', async () => {
  console.log('Shutting down server...');
  
  // Close all SSE connections
  for (const [sessionId, session] of activeSessions.entries()) {
    try {
      session.response.write(`event: close\n`);
      session.response.write(`data: Server shutting down\n\n`);
      session.response.end();
    } catch (error) {
      console.error('Error closing session during shutdown:', error);
    }
  }
  activeSessions.clear();
  
  await pool.end();
  httpServer.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
});

async function runServer() {
  let port = process.env.PORT ? parseInt(process.env.PORT) : 8880;
  
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
    
    console.log(`🚀 MCP PostgreSQL server running on port ${finalPort}`);
    console.log(`📡 Server available at http://localhost:${finalPort}/sse`);
    console.log(`🏥 Health check available at http://localhost:${finalPort}/health`);
    console.log(`🗄️  Connected to database: mapai_app_db`);
    console.log(`🔧 Available tools: query`);
    
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

runServer().catch(console.error);