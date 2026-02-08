const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const logger = require('./utils/logger');

class Server {
  constructor(port = 3000) {
    this.port = port;
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.clients = new Set();
    this.matchHistory = []; // Store recent matches for new clients

    this.setupRoutes();
    this.setupWebSocket();
  }

  setupRoutes() {
    // Serve static files
    this.app.use(express.static(path.join(__dirname, '..', 'public')));

    // API endpoint to get match history
    this.app.get('/api/matches', (req, res) => {
      res.json(this.matchHistory.slice(-200)); // Last 200 matches
    });

    // API endpoint for status
    this.app.get('/api/status', (req, res) => {
      res.json({
        clients: this.clients.size,
        totalMatches: this.matchHistory.length,
        uptime: process.uptime(),
      });
    });
  }

  setupWebSocket() {
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      logger.info(`Client connected (total: ${this.clients.size})`);

      // Send recent matches to new client
      ws.send(
        JSON.stringify({
          type: 'history',
          data: this.matchHistory.slice(-50),
        })
      );

      ws.on('close', () => {
        this.clients.delete(ws);
        logger.info(`Client disconnected (total: ${this.clients.size})`);
      });

      ws.on('error', (err) => {
        logger.error('WebSocket error:', err.message);
        this.clients.delete(ws);
      });
    });
  }

  /**
   * Broadcast a matched token to all connected clients
   */
  broadcastMatch(matchData) {
    this.matchHistory.push(matchData);

    // Keep history size manageable
    if (this.matchHistory.length > 1000) {
      this.matchHistory = this.matchHistory.slice(-500);
    }

    const message = JSON.stringify({
      type: 'match',
      data: matchData,
    });

    for (const client of this.clients) {
      try {
        if (client.readyState === 1) {
          // OPEN
          client.send(message);
        }
      } catch (err) {
        logger.error('Broadcast error:', err.message);
      }
    }
  }

  /**
   * Broadcast a new token event (for live feed, even without match)
   */
  broadcastNewToken(tokenData) {
    const message = JSON.stringify({
      type: 'newToken',
      data: tokenData,
    });

    for (const client of this.clients) {
      try {
        if (client.readyState === 1) {
          client.send(message);
        }
      } catch (err) {
        // ignore
      }
    }
  }

  /**
   * Broadcast status updates
   */
  broadcastStatus(statusData) {
    const message = JSON.stringify({
      type: 'status',
      data: statusData,
    });

    for (const client of this.clients) {
      try {
        if (client.readyState === 1) {
          client.send(message);
        }
      } catch (err) {
        // ignore
      }
    }
  }

  start() {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        logger.success(`Server running at http://localhost:${this.port}`);
        resolve();
      });
    });
  }
}

module.exports = Server;
