require('dotenv').config();

const OKXScraper = require('./monitors/okx-scraper');
const TwitterChecker = require('./twitter/checker');
const Server = require('./server');
const logger = require('./utils/logger');

async function main() {
  logger.info('=== Meme Coin Twitter Scanner ===');
  logger.info('Starting up...');

  const port = parseInt(process.env.PORT) || 3000;
  const chains = (process.env.MONITOR_CHAINS || 'sol,bsc').split(',').map((c) => c.trim());

  // 1. Start the web server
  const server = new Server(port);
  await server.start();

  // 2. Initialize Twitter checker
  const twitter = new TwitterChecker({
    username: process.env.TWITTER_USERNAME,
    password: process.env.TWITTER_PASSWORD,
    email: process.env.TWITTER_EMAIL,
    checkInterval: parseInt(process.env.TWITTER_CHECK_INTERVAL) || 1000,
    maxTweets: parseInt(process.env.MAX_TWEETS_PER_USER) || 5,
    cacheTTL: parseInt(process.env.CACHE_TTL_MINUTES) || 30,
  });

  await twitter.init();

  // 3. Start OKX scraper
  const scraper = new OKXScraper({
    scanInterval: parseInt(process.env.OKX_SCAN_INTERVAL) || 5000,
    chains,
  });

  // Stats
  let totalScanned = 0;
  let pendingChecks = 0;

  // Handle new token events
  scraper.on('newToken', async (token) => {
    totalScanned++;
    logger.info(
      `New token: ${token.name} | ${token.chain.toUpperCase()} | ` +
        `${token.contractAddress.substring(0, 8)}... | ` +
        `Twitter: ${token.twitter ? '@' + token.twitter : 'none'}`
    );

    // Broadcast to frontend feed
    server.broadcastNewToken(token);
    server.broadcastStatus({ scanCount: totalScanned, checkingCount: pendingChecks });

    // If no twitter, skip checking
    if (!token.twitter) {
      logger.info(`  -> No Twitter linked, skipping`);
      return;
    }

    // If contract address is partial (contains ...), skip
    if (token.contractAddress.includes('...')) {
      logger.warn(`  -> Partial address only: ${token.contractAddress}, skipping`);
      return;
    }

    // Queue Twitter check
    pendingChecks++;
    server.broadcastStatus({ scanCount: totalScanned, checkingCount: pendingChecks });

    try {
      // Check tweets for contract address
      const tweetResult = await twitter.checkContractAddress(token.twitter, token.contractAddress);

      // Also check profile bio
      const bioResult = await twitter.checkProfileBio(token.twitter, token.contractAddress);

      const matched = tweetResult.matched || bioResult.matched;

      if (matched) {
        const matchData = {
          name: token.name,
          contractAddress: token.contractAddress,
          chain: token.chain,
          twitter: token.twitter,
          marketCap: token.marketCap,
          matchedTweets: tweetResult.tweets || [],
          matchedInBio: bioResult.matched || false,
          timestamp: Date.now(),
        };

        logger.match(
          `MATCH FOUND! ${token.name} (@${token.twitter}) ` +
            `contract ${token.contractAddress.substring(0, 12)}... ` +
            `on ${token.chain.toUpperCase()}`
        );

        server.broadcastMatch(matchData);
      }
    } catch (err) {
      logger.error(`Twitter check failed for @${token.twitter}: ${err.message}`);
    } finally {
      pendingChecks--;
      server.broadcastStatus({ scanCount: totalScanned, checkingCount: pendingChecks });
    }
  });

  // Handle intercepted API data (bonus: capture OKX internal API responses)
  scraper.on('apiData', ({ url, data }) => {
    logger.info(`Captured OKX API data from: ${url}`);
    // Process any useful token data from intercepted API calls
    if (data && Array.isArray(data.data)) {
      for (const item of data.data) {
        if (item.tokenAddress || item.contractAddress || item.mint) {
          const addr = item.tokenAddress || item.contractAddress || item.mint;
          const twitterHandle = item.twitter || item.twitterHandle;
          if (addr && twitterHandle) {
            scraper.emit('newToken', {
              name: item.name || item.tokenName || 'Unknown',
              contractAddress: addr,
              chain: item.chainId === '56' || item.chain === 'bsc' ? 'bsc' : 'sol',
              twitter: twitterHandle,
              marketCap: item.marketCap,
              timestamp: Date.now(),
            });
          }
        }
      }
    }
  });

  try {
    await scraper.start();
  } catch (err) {
    logger.error('Failed to start OKX scraper:', err.message);
    logger.warn('The scraper requires a Chrome/Chromium browser.');
    logger.warn('Make sure to run: npx puppeteer browsers install chrome');
    process.exit(1);
  }

  // Periodic cache cleanup
  setInterval(() => {
    twitter.cache.cleanup();
  }, 5 * 60 * 1000);

  // Periodic status broadcast
  setInterval(() => {
    server.broadcastStatus({
      scanCount: totalScanned,
      checkingCount: pendingChecks,
    });
  }, 10000);

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await scraper.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    await scraper.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal error:', err);
  process.exit(1);
});
