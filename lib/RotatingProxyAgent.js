'use strict';
const { ProxyAgent } = require('undici');

class ProxyRotator {
  constructor(proxies) {
    this.proxies = proxies;
    this.currentIndex = 0;
  }

  getNextProxyAgent() {
    if (!this.proxies.length) return null;

    const proxy = this.proxies[this.currentIndex];
    this.currentIndex = (this.currentIndex + 1) % this.proxies.length;

    return new ProxyAgent(proxy);
  }
}

module.exports = ProxyRotator;
