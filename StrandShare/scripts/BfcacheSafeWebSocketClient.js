class BfcacheSafeWebSocketClient {
  constructor(url) {
    this.client = new WebSocket(url);
    this.handlePageHide = () => {
      if (this.client.readyState === WebSocket.OPEN) {
        this.client.close(1000, 'page hidden');
      }
    };
    window.addEventListener('pagehide', this.handlePageHide);
  }

  onOpen(callback) {
    this.client.onopen = callback;
  }

  onClose(callback) {
    this.client.onclose = (event) => {
      window.removeEventListener('pagehide', this.handlePageHide);
      callback(event);
    };
  }

  onMessage(callback) {
    this.client.onmessage = (event) => callback(event.data);
  }
}

module.exports = BfcacheSafeWebSocketClient;
