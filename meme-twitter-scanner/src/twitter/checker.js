const { Scraper } = require('@the-convocation/twitter-scraper');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const Cache = require('../utils/cache');

const COOKIES_PATH = path.join(__dirname, '..', '..', 'twitter-cookies.json');

class TwitterChecker {
  constructor(options = {}) {
    this.scraper = new Scraper();
    this.loggedIn = false;
    this.username = options.username;
    this.password = options.password;
    this.email = options.email;
    this.checkInterval = options.checkInterval || 1000; // 1 second default
    this.maxTweets = options.maxTweets || 5;
    this.cache = new Cache(options.cacheTTL || 30); // 30 min default

    // Rate limiting state
    this.lastRequestTime = 0;
    this.consecutiveErrors = 0;
    this.rateLimitPauseUntil = 0;
    this.requestCount = 0;
    this.windowStart = Date.now();

    // Queue for pending checks
    this.queue = [];
    this.processing = false;
  }

  async init() {
    logger.info('Initializing Twitter checker...');

    // Try to restore cookies first
    if (await this.restoreCookies()) {
      logger.success('Twitter session restored from cookies');
      this.loggedIn = true;
      return;
    }

    // Login with credentials
    if (!this.username || !this.password) {
      logger.warn('No Twitter credentials provided - Twitter checking disabled');
      return;
    }

    try {
      logger.info(`Logging into Twitter as @${this.username}...`);
      await this.scraper.login(this.username, this.password, this.email);
      this.loggedIn = true;
      logger.success('Twitter login successful');

      // Cache cookies for future use
      await this.saveCookies();
    } catch (err) {
      logger.error('Twitter login failed:', err.message);
      logger.warn('Twitter checking will be disabled');
    }
  }

  async saveCookies() {
    try {
      const cookies = await this.scraper.getCookies();
      fs.writeFileSync(COOKIES_PATH, JSON.stringify(cookies, null, 2));
      logger.info('Twitter cookies saved');
    } catch (err) {
      logger.warn('Failed to save cookies:', err.message);
    }
  }

  async restoreCookies() {
    try {
      if (!fs.existsSync(COOKIES_PATH)) return false;
      const cookies = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
      await this.scraper.setCookies(cookies);

      // Verify the session is still valid
      const isLoggedIn = await this.scraper.isLoggedIn();
      if (isLoggedIn) {
        return true;
      }
      logger.warn('Saved cookies expired, need fresh login');
      return false;
    } catch (err) {
      logger.warn('Failed to restore cookies:', err.message);
      return false;
    }
  }

  /**
   * Check if a Twitter account has posted a specific contract address.
   * Returns { matched, tweets } where tweets contains matching tweet texts.
   */
  async checkContractAddress(twitterHandle, contractAddress) {
    if (!this.loggedIn) {
      return { matched: false, tweets: [], error: 'Not logged in' };
    }

    if (!twitterHandle || !contractAddress) {
      return { matched: false, tweets: [], error: 'Missing handle or address' };
    }

    // Clean the handle (remove @ prefix if present)
    const handle = twitterHandle.replace(/^@/, '');

    // Check cache first
    const cacheKey = `${handle}:${contractAddress}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    // Rate limit check
    await this.waitForRateLimit();

    try {
      logger.info(`Checking @${handle} for contract ${contractAddress.substring(0, 8)}...`);

      const matchingTweets = [];
      let tweetCount = 0;

      // Fetch recent tweets from the user
      const tweetIterator = this.scraper.getTweets(handle, this.maxTweets);
      for await (const tweet of tweetIterator) {
        tweetCount++;
        if (tweetCount > this.maxTweets) break;

        const tweetText = tweet.text || '';

        // Check if the tweet contains the contract address
        // Support both full address and partial matches
        if (this.addressMatchesTweet(contractAddress, tweetText)) {
          matchingTweets.push({
            text: tweetText,
            id: tweet.id,
            timestamp: tweet.timeParsed || tweet.timestamp,
          });
        }
      }

      this.consecutiveErrors = 0;
      this.recordRequest();

      const result = {
        matched: matchingTweets.length > 0,
        tweets: matchingTweets,
        checkedAt: Date.now(),
        tweetCount,
      };

      // Cache the result
      this.cache.set(cacheKey, result);

      if (result.matched) {
        logger.match(`@${handle} posted contract ${contractAddress.substring(0, 8)}!`);
      }

      return result;
    } catch (err) {
      this.handleError(err);
      return {
        matched: false,
        tweets: [],
        error: err.message,
      };
    }
  }

  /**
   * Also check the user's profile/bio for the contract address.
   */
  async checkProfileBio(twitterHandle, contractAddress) {
    if (!this.loggedIn) return { matched: false };

    const handle = twitterHandle.replace(/^@/, '');
    const cacheKey = `bio:${handle}:${contractAddress}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);

    await this.waitForRateLimit();

    try {
      const profile = await this.scraper.getProfile(handle);
      this.recordRequest();
      this.consecutiveErrors = 0;

      const bio = profile.biography || '';
      const matched = this.addressMatchesTweet(contractAddress, bio);

      const result = { matched, bio, checkedAt: Date.now() };
      this.cache.set(cacheKey, result);
      return result;
    } catch (err) {
      this.handleError(err);
      return { matched: false, error: err.message };
    }
  }

  /**
   * Check if a contract address appears in a tweet text.
   * Supports full and partial address matching.
   */
  addressMatchesTweet(contractAddress, text) {
    if (!text || !contractAddress) return false;

    // Direct full match
    if (text.includes(contractAddress)) return true;

    // For SOL addresses (base58, 32-44 chars), also check lowercase
    if (text.toLowerCase().includes(contractAddress.toLowerCase())) return true;

    // If we only have a partial address (e.g., "G4mX...HBC3"), skip matching
    if (contractAddress.includes('...')) return false;

    // Check for address with surrounding spaces/newlines (avoid partial matches within URLs)
    const escaped = contractAddress.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(?:^|\\s|\\n)${escaped}(?:$|\\s|\\n)`, 'i');
    return regex.test(text);
  }

  /**
   * Enforce rate limiting: wait at least checkInterval ms between requests.
   * If we're in a rate-limit pause, wait until it expires.
   */
  async waitForRateLimit() {
    // If we hit a rate limit, pause
    const now = Date.now();
    if (now < this.rateLimitPauseUntil) {
      const waitTime = this.rateLimitPauseUntil - now;
      logger.warn(`Rate limit pause: waiting ${Math.round(waitTime / 1000)}s`);
      await this.sleep(waitTime);
    }

    // Enforce minimum interval between requests
    const elapsed = Date.now() - this.lastRequestTime;
    if (elapsed < this.checkInterval) {
      await this.sleep(this.checkInterval - elapsed);
    }

    this.lastRequestTime = Date.now();
  }

  recordRequest() {
    this.requestCount++;

    // Reset counter every 15 minutes
    if (Date.now() - this.windowStart > 15 * 60 * 1000) {
      logger.info(`Twitter requests in last 15min: ${this.requestCount}`);
      this.requestCount = 0;
      this.windowStart = Date.now();
    }
  }

  handleError(err) {
    this.consecutiveErrors++;
    const msg = err.message || '';

    if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
      // Rate limited! Pause for 15 minutes
      logger.warn('Twitter rate limit hit! Pausing for 15 minutes...');
      this.rateLimitPauseUntil = Date.now() + 15 * 60 * 1000;
    } else if (this.consecutiveErrors >= 3) {
      // 3 consecutive errors - back off for 2 minutes
      logger.warn(`${this.consecutiveErrors} consecutive errors, pausing 2 minutes`);
      this.rateLimitPauseUntil = Date.now() + 2 * 60 * 1000;
      this.consecutiveErrors = 0;
    } else {
      logger.error(`Twitter error: ${msg}`);
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

module.exports = TwitterChecker;
