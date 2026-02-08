const puppeteer = require('puppeteer');
const { EventEmitter } = require('events');
const logger = require('../utils/logger');

class OKXScraper extends EventEmitter {
  constructor(options = {}) {
    super();
    this.scanInterval = options.scanInterval || 5000;
    this.chains = options.chains || ['sol', 'bsc'];
    this.browser = null;
    this.page = null;
    this.seenTokens = new Set();
    this.running = false;
    this.discoveredApiEndpoints = new Set();
  }

  async start() {
    logger.info('Starting OKX Meme Pump scraper...');

    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1920,1080',
      ],
    });

    this.page = await this.browser.newPage();
    await this.page.setViewport({ width: 1920, height: 1080 });
    await this.page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' });
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
    );

    // Setup network interception BEFORE loading the page
    await this.setupNetworkInterception();

    try {
      logger.info('Loading OKX Meme Pump page...');
      await this.page.goto('https://web3.okx.com/zh-hans/meme-pump', {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      await this.sleep(5000);
      logger.success('OKX Meme Pump page loaded');

      // Log what API endpoints we discovered
      if (this.discoveredApiEndpoints.size > 0) {
        logger.info(`Discovered ${this.discoveredApiEndpoints.size} API endpoints:`);
        for (const ep of this.discoveredApiEndpoints) {
          logger.info(`  -> ${ep}`);
        }
      }

      this.running = true;
      this.scanLoop();
    } catch (err) {
      logger.error('Failed to load OKX page:', err.message);
      throw err;
    }
  }

  /**
   * Intercept ALL network responses to:
   * 1. Discover internal API endpoints OKX uses
   * 2. Capture token data from API responses directly (most reliable)
   * 3. Capture WebSocket messages
   */
  async setupNetworkInterception() {
    // Intercept HTTP/HTTPS responses
    this.page.on('response', async (response) => {
      const url = response.url();
      const contentType = response.headers()['content-type'] || '';

      // Only process JSON API responses
      if (!contentType.includes('json') && !url.includes('/api/')) return;

      try {
        const text = await response.text();
        if (!text || text.length < 10) return;

        const data = JSON.parse(text);
        this.discoveredApiEndpoints.add(url.split('?')[0]);

        // Process responses that might contain token/pair data
        this.processApiResponse(url, data);
      } catch {
        // Not JSON or parse error, ignore
      }
    });

    // Intercept WebSocket frames by injecting into the page
    await this.page.evaluateOnNewDocument(() => {
      // Override WebSocket to capture messages
      const OriginalWebSocket = window.WebSocket;
      window.__capturedWsMessages = [];

      window.WebSocket = function (...args) {
        const ws = new OriginalWebSocket(...args);
        const originalOnMessage = ws.onmessage;

        ws.addEventListener('message', (event) => {
          try {
            const data = typeof event.data === 'string' ? event.data : null;
            if (data && data.length > 10) {
              window.__capturedWsMessages.push({
                url: args[0],
                data,
                timestamp: Date.now(),
              });
              // Keep buffer manageable
              if (window.__capturedWsMessages.length > 500) {
                window.__capturedWsMessages = window.__capturedWsMessages.slice(-250);
              }
            }
          } catch {}
        });

        return ws;
      };
      window.WebSocket.prototype = OriginalWebSocket.prototype;
      window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
      window.WebSocket.OPEN = OriginalWebSocket.OPEN;
      window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
      window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
    });
  }

  /**
   * Process intercepted API responses to extract token data
   */
  processApiResponse(url, data) {
    // Various possible response structures from OKX
    const tokenArrays = [];

    // Try to find arrays of token objects in the response
    if (Array.isArray(data)) {
      tokenArrays.push(data);
    } else if (data && typeof data === 'object') {
      // Common patterns: data.data, data.list, data.items, data.tokens, data.pairs
      for (const key of ['data', 'list', 'items', 'tokens', 'pairs', 'result']) {
        if (Array.isArray(data[key])) {
          tokenArrays.push(data[key]);
        } else if (data[key] && Array.isArray(data[key].list)) {
          tokenArrays.push(data[key].list);
        } else if (data[key] && Array.isArray(data[key].data)) {
          tokenArrays.push(data[key].data);
        }
      }
    }

    for (const arr of tokenArrays) {
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        this.tryExtractTokenFromApiItem(item, url);
      }
    }
  }

  /**
   * Try to extract token info from an API response item.
   * OKX API objects may use various field names.
   */
  tryExtractTokenFromApiItem(item, sourceUrl) {
    // Possible field names for contract address
    const addrFields = [
      'tokenAddress', 'contractAddress', 'mint', 'address',
      'tokenContractAddress', 'ca', 'contract', 'token_address',
      'pairAddress', 'baseTokenAddress', 'baseAddress',
    ];

    let contractAddress = null;
    for (const field of addrFields) {
      if (item[field] && typeof item[field] === 'string' && item[field].length >= 20) {
        contractAddress = item[field];
        break;
      }
    }
    if (!contractAddress) return;

    // Possible field names for twitter
    const twFields = [
      'twitter', 'twitterHandle', 'twitterUrl', 'twitterLink',
      'twitter_url', 'socialTwitter', 'twitterUsername',
    ];
    let twitter = null;
    for (const field of twFields) {
      if (item[field] && typeof item[field] === 'string') {
        // Extract handle from URL if needed
        const match = item[field].match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)/);
        twitter = match ? match[1] : item[field].replace(/^@/, '');
        break;
      }
    }

    // Also check nested social/links objects
    if (!twitter && item.social) {
      twitter = item.social.twitter || item.social.x;
    }
    if (!twitter && item.links) {
      const tw = item.links.twitter || item.links.x;
      if (tw) {
        const match = tw.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)/);
        twitter = match ? match[1] : tw;
      }
    }

    // Determine chain
    let chain = null;
    const chainFields = ['chainId', 'chain', 'chainName', 'network', 'chainIndex'];
    for (const field of chainFields) {
      const val = String(item[field] || '').toLowerCase();
      if (val === 'sol' || val === 'solana' || val === '501') {
        chain = 'sol';
        break;
      }
      if (val === 'bsc' || val === 'bnb' || val === '56') {
        chain = 'bsc';
        break;
      }
    }

    // Infer chain from address format
    if (!chain) {
      if (/^0x[a-fA-F0-9]{40}$/.test(contractAddress)) {
        chain = 'bsc';
      } else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(contractAddress)) {
        chain = 'sol';
      }
    }

    if (!chain || !this.chains.includes(chain)) return;

    // Token name
    const name = item.name || item.tokenName || item.symbol || item.tokenSymbol || 'Unknown';

    // Market cap
    const marketCap = item.marketCap || item.market_cap || item.fdv || null;

    // Emit if new
    if (!this.seenTokens.has(contractAddress)) {
      this.seenTokens.add(contractAddress);
      this.emit('newToken', {
        name,
        contractAddress,
        chain,
        twitter: twitter || null,
        marketCap: marketCap ? `$${Number(marketCap).toLocaleString()}` : null,
        timestamp: Date.now(),
        source: 'api',
      });
    }
  }

  /**
   * Main scan loop: combines API interception data + DOM scraping + WebSocket data
   */
  async scanLoop() {
    while (this.running) {
      try {
        // 1. Check for captured WebSocket messages
        await this.processWebSocketMessages();

        // 2. DOM scraping as supplementary method
        const tokens = await this.extractTokensFromDOM();
        for (const token of tokens) {
          if (!this.seenTokens.has(token.contractAddress)) {
            this.seenTokens.add(token.contractAddress);
            this.emit('newToken', { ...token, source: 'dom' });
          }
        }
      } catch (err) {
        logger.error('Scan error:', err.message);
        try {
          await this.page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
          await this.sleep(3000);
        } catch (reloadErr) {
          logger.error('Reload failed:', reloadErr.message);
        }
      }
      await this.sleep(this.scanInterval);
    }
  }

  /**
   * Process WebSocket messages captured from the page
   */
  async processWebSocketMessages() {
    try {
      const messages = await this.page.evaluate(() => {
        const msgs = window.__capturedWsMessages || [];
        window.__capturedWsMessages = [];
        return msgs;
      });

      for (const msg of messages) {
        try {
          const data = JSON.parse(msg.data);
          this.processApiResponse(msg.url, data);
        } catch {
          // Not JSON
        }
      }
    } catch {
      // Page might have navigated
    }
  }

  /**
   * Extract tokens from the DOM - parses the visible page content.
   * This is the fallback method; network interception is more reliable.
   */
  async extractTokensFromDOM() {
    const tokens = await this.page.evaluate((targetChains) => {
      const results = [];

      // Strategy: find all <a> links that point to token pages
      // OKX token page URLs follow: /zh-hans/token/{chain}/{address}
      // or /token/{chain}/{address}
      const links = document.querySelectorAll('a[href*="/token/"]');
      const processedAddresses = new Set();

      for (const link of links) {
        const href = link.getAttribute('href') || '';

        // Match token page URLs
        const solMatch = href.match(/\/token\/(?:sol|solana)\/([A-Za-z0-9]{20,50})/i);
        const bscMatch = href.match(/\/token\/(?:bsc|bnb)\/([a-fA-F0-9x]{40,42})/i);

        let contractAddress = null;
        let chain = null;

        if (solMatch && targetChains.includes('sol')) {
          contractAddress = solMatch[1];
          chain = 'sol';
        } else if (bscMatch && targetChains.includes('bsc')) {
          contractAddress = bscMatch[1];
          chain = 'bsc';
        }

        if (!contractAddress || processedAddresses.has(contractAddress)) continue;
        processedAddresses.add(contractAddress);

        // Try to extract more info from the surrounding card element
        // Walk up the DOM to find the card container
        let card = link;
        for (let i = 0; i < 10; i++) {
          if (!card.parentElement) break;
          card = card.parentElement;
          // A card typically has a reasonable amount of text
          if (card.innerText && card.innerText.length > 30 && card.innerText.length < 1500) {
            break;
          }
        }

        const cardText = card ? card.innerText || '' : '';

        // Extract twitter handle from @username pattern
        let twitter = null;
        const twMatches = cardText.match(/@([A-Za-z0-9_]{2,15})/g);
        if (twMatches) {
          for (const tw of twMatches) {
            const handle = tw.substring(1);
            // Skip generic handles
            if (!['pump', 'Pumpfun', 'solana', 'bsc', 'bnb'].includes(handle.toLowerCase())) {
              twitter = handle;
              break;
            }
          }
        }

        // Also look for twitter links in the card
        const twLinks = card ? card.querySelectorAll('a[href*="twitter.com"], a[href*="x.com"]') : [];
        for (const twLink of twLinks) {
          const twHref = twLink.getAttribute('href') || '';
          const twMatch = twHref.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{2,15})/);
          if (twMatch && !['intent', 'share', 'search', 'home'].includes(twMatch[1].toLowerCase())) {
            twitter = twMatch[1];
            break;
          }
        }

        // Extract token name - look for prominent text
        let name = 'Unknown';
        const lines = cardText.trim().split('\n').filter((l) => l.trim());
        if (lines.length > 0) {
          // First meaningful line is usually the name
          name = lines[0].trim().substring(0, 60);
        }

        // Market cap
        let marketCap = null;
        const mcMatch = cardText.match(/(?:市值|cap)\s*\$?([\d,.]+[KMB]?)/i);
        if (mcMatch) {
          marketCap = '$' + mcMatch[1];
        } else {
          const dollarMatch = cardText.match(/\$([\d,.]+[KMB])/);
          if (dollarMatch) marketCap = '$' + dollarMatch[1];
        }

        results.push({
          name,
          contractAddress,
          chain,
          twitter,
          marketCap,
          timestamp: Date.now(),
        });
      }

      // Strategy 2: Look for addresses in elements with copy functionality
      const copyElements = document.querySelectorAll(
        '[data-clipboard-text], [data-copy], [class*="copy"]'
      );
      for (const el of copyElements) {
        const addr =
          el.getAttribute('data-clipboard-text') ||
          el.getAttribute('data-copy') ||
          '';

        if (!addr || processedAddresses.has(addr)) continue;

        let chain = null;
        if (/^0x[a-fA-F0-9]{40}$/.test(addr) && targetChains.includes('bsc')) {
          chain = 'bsc';
        } else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr) && targetChains.includes('sol')) {
          chain = 'sol';
        }

        if (!chain) continue;
        processedAddresses.add(addr);

        // Walk up to find card context
        let parent = el;
        for (let i = 0; i < 8; i++) {
          if (!parent.parentElement) break;
          parent = parent.parentElement;
        }
        const parentText = parent.innerText || '';

        let twitter = null;
        const twMatch = parentText.match(/@([A-Za-z0-9_]{2,15})/);
        if (twMatch && twMatch[1].toLowerCase() !== 'pump') {
          twitter = twMatch[1];
        }

        let name = 'Unknown';
        const nameLines = parentText.trim().split('\n').filter((l) => l.trim());
        if (nameLines.length > 0) name = nameLines[0].trim().substring(0, 60);

        results.push({
          name,
          contractAddress: addr,
          chain,
          twitter,
          marketCap: null,
          timestamp: Date.now(),
        });
      }

      return results;
    }, this.chains);

    return tokens.filter((t) => t && t.contractAddress && !t.contractAddress.includes('...'));
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async stop() {
    this.running = false;
    if (this.browser) {
      await this.browser.close();
    }
    logger.info('OKX scraper stopped');
  }
}

module.exports = OKXScraper;
