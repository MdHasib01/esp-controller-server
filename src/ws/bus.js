const { EventEmitter } = require('events');

// Decouples device-state changes (REST controllers, device WS, heartbeat sweep)
// from the dashboard WS broadcaster, which is the only subscriber.
const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
