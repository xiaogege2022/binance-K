/**
 * Simple colored logger
 */
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function timestamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

const logger = {
  info(msg, ...args) {
    console.log(`${colors.gray}[${timestamp()}]${colors.cyan} [INFO]${colors.reset} ${msg}`, ...args);
  },
  success(msg, ...args) {
    console.log(`${colors.gray}[${timestamp()}]${colors.green} [OK]${colors.reset} ${msg}`, ...args);
  },
  warn(msg, ...args) {
    console.log(`${colors.gray}[${timestamp()}]${colors.yellow} [WARN]${colors.reset} ${msg}`, ...args);
  },
  error(msg, ...args) {
    console.error(`${colors.gray}[${timestamp()}]${colors.red} [ERR]${colors.reset} ${msg}`, ...args);
  },
  match(msg, ...args) {
    console.log(`${colors.gray}[${timestamp()}]${colors.green} [MATCH]${colors.reset} ${msg}`, ...args);
  },
};

module.exports = logger;
