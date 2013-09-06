/* global importScripts, BackboneEvents */
/* jshint unused:false */

importScripts('../vendor/backbone-events-standalone-0.1.5.js');

var Server = (function() {
  function Server(options) {
    this.options = options || {WSURL: ""};
    this._ws = undefined;
  }

  BackboneEvents.mixin(Server.prototype);

  Server.prototype._setupWebSocket = function(ws) {
    ws.onopen    = this.trigger.bind(this, "connected");
    ws.onmessage = this._onWebSocketMessage.bind(this);
    ws.onerror   = this.trigger.bind(this, "error");
    ws.onclose   = this.trigger.bind(this, "disconnected");
    return ws;
  };

  Server.prototype._tryWebSocket = function(ws) {
    ws.onopen = function(event) {
      this._setupWebSocket(ws);
      this.trigger("connected", event);
    }.bind(this);
    ws.onerror = function(event) {
      this.trigger("disconnected");
    }.bind(this);

    return ws;
  };

  Server.prototype._onWebSocketMessage = function(event) {
    var data = JSON.parse(event.data);
    for (var eventType in data) {
      this.trigger("message", eventType, data[eventType]);
      this.trigger("message:" + eventType, data[eventType]);
    }
  };

  Server.prototype.request = function(method, url, data, callback) {
    var xhr = new XMLHttpRequest();

    xhr.onload = function(event) {
      // sinon.js can call us with a null event a second time, so just
      // ignore it.
      if (!event)
        return;
      if (xhr.readyState === 4 && xhr.status === 200)
        return callback(null, xhr.responseText);
      callback(xhr.statusText, xhr.responseText);
    };

    xhr.onerror = function(event) {
      var target = event && event.target;
      if (target)
        callback(target.status ? target.statusText : "We are offline");
    };

    xhr.open(method || 'GET', url, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.send(JSON.stringify(data));
  };

  Server.prototype.post = function(url, data, callback) {
    this.request("POST", url, data, callback);
  };

  Server.prototype.signin = function(assertion, callback) {
    this.post("/signin", {assertion: assertion}, callback);
  };

  Server.prototype.signout = function(nick, callback) {
    this.post("/signout", {nick: nick}, callback);
  };

  Server.prototype.connect = function(nick) {
    var ws = new WebSocket(this.options.WSURL + "?nick=" + nick);
    this._ws = this._setupWebSocket(ws);
  };

  Server.prototype.autoconnect = function(nick) {
    var ws = new WebSocket(this.options.WSURL + "?nick=" + nick);
    this._ws = this._tryWebSocket(ws);
  };

  Server.prototype.send = function(data) {
    this._ws.send(JSON.stringify(data));
  };

  return Server;
}());

