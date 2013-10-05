/* global indexedDB, importScripts, SPA, HTTP, CollectedContacts,
   loadConfig  */
/* jshint unused:false */

importScripts('../vendor/backbone-events-standalone-0.1.5.js',
              '/config.js',               // exposes loadConfig
              'addressbook/collected.js', // exposes CollectedContacts
              'worker/http.js',           // exposes HTTP
              'worker/spa.js');           // exposes SPA

var gConfig = loadConfig();
var _currentUserData;
var _loginPending = false;
var _autologinPending = false;
var ports;
var browserPort;
var currentConversation;
var currentUsers = {};
var contactsDb = new CollectedContacts({
  dbname: "TalkillaContacts",
  storename: "contacts",
  version: 1
});
var spa;
// XXX Initialised at end of file whilst we move everything
// into it.
var tkWorker;

// XXX we use this to map to what the sidebar wants, really
// the sidebar should change so that we can just send the object.
function getCurrentUsersArray() {
  if (Object.keys(currentUsers).length === 0)
    return [];

  return Object.keys(currentUsers).map(function(userId) {
    return {nick: userId, presence: currentUsers[userId].presence};
  });
}

/**
 * Conversation data storage.
 *
 * This is designed to contain information about open conversation
 * windows, and to route appropraite information to those windows,
 *
 * Some aspects of the design are more relevant to only allowing
 * a single conversation window, and these will need to be changed
 * at the appropriate time.
 *
 * @param {Object|undefined}  data  Initial data
 *
 * data properties:
 *
 * peer: The id of the peer this conversation window is for.
 * offer: optional data for incoming calls.
 */
function Conversation(data) {
  this.data = data;
  this.port = undefined;

  browserPort.postEvent('social.request-chat', 'chat.html');
}

Conversation.prototype = {
  /**
   * Call to tell the conversation that a window has been opened
   * for it, so it can set the window up with the required info.
   *
   * @param {AbstractPort}  port  The Port instance associated with the window
   */
  windowOpened: function(port) {
    this.port = port;

    if (_currentUserData.userName) {
      // If there's currenty a logged in user,
      port.postEvent('talkilla.login-success', {
        username: _currentUserData.userName
      });
      this.data.user = _currentUserData.userName;
    }

    this._sendCall();
  },

  /**
   * Returns true if this conversation window is for the specified
   * peer and the incoming call data is passed to that window.
   *
   * @param peer The id of the peer to compare with.
   */
  handleIncomingCall: function(data) {
    ports.broadcastDebug('handle incoming call', data);

    if (this.data.peer !== data.peer)
      return false;

    if (_currentUserData)
      data.user = _currentUserData.userName;

    this.data = data;

    this._sendCall();
    return true;
  },

  /**
   * Sends call information to the conversation window.
   */
  _sendCall: function() {
    contactsDb.add(this.data.peer, function(err) {
      if (err)
        ports.broadcastError(err);
    });

    // retrieve peer presence information
    // There's a small chance we've not received the currentUsers
    // information yet, so check that we have data for this user.
    if (this.data.peer in currentUsers)
      this.data.peerPresence = currentUsers[this.data.peer].presence;

    var topic = this.data.offer ?
      "talkilla.conversation-incoming" :
      "talkilla.conversation-open";

    this.port.postEvent(topic, this.data);
  },

  /**
   * Call to tell the conversation that the call has been accepted
   * by the peer.
   *
   * @param data The data associated with the call. Consisting of:
   *
   * - peer   the id of the other user
   * - offer  the sdp offer for the connection
   */
  callAccepted: function(data) {
    ports.broadcastDebug('conversation accepted', data);
    this.port.postEvent('talkilla.call-establishment', data);
  },

  /**
   * Call to tell the conversation window that the call has been
   * hungup by the peer.
   *
   * @param data The data associated with the call. Consisting of:
   *
   * - peer   the id of the other user
   */
  callHangup: function(data) {
    ports.broadcastDebug('conversation hangup', data);
    this.port.postEvent('talkilla.call-hangup', data);
  }
};

/**
 * User data and Social API profile data storage.
 *
 * This is designed to contain the majority of the user's status and
 * their current presence.
 *
 * When setting an attribute, it will automatically send a message to
 * the social API giving the new details.
 *
 * @param {Object|undefined}  initial  Initial data
 * @param {Object|undefined}  config   Environment configuration
 *
 * UserData properties:
 *
 * userName: The name of the currently signed-in user.
 * connected: Whether or not the websocket to the server is connected.
 */
function UserData(initial, config) {
  this._rootURL = config ? config.ROOTURL : '';

  this.defaults = {
    _userName: undefined,
    _connected: false
  };

  this.reset(true);

  if (initial) {
    for (var key in initial)
      this[key] = initial[key];
  }
  // We don't send the social api message here, as we should be
  // constructed before we get the port set up.
}

UserData.prototype = {

  get userName() {
    return this._userName;
  },

  set userName(userName) {
    this._userName = userName;
    this.send();
  },

  get connected() {
    return this._connected;
  },

  set connected(connected) {
    this._connected = connected;
    this.send();
  },

  /**
   * Resets current properties to default ones.
   */
  reset: function(skipSend) {
    for (var key in this.defaults)
      this[key] = this.defaults[key];

    if (!skipSend)
      this.send();
  },

  /**
   * Returns the appropriate image object for our status.
   */
  get statusIcon() {
    // If we're not connected, then always show the standard
    // icon, regardless of the user setting.
    if (!this._connected)
      return "talkilla16.png";

    return "talkilla16-online.png";
  },

  /**
   * Sends the current user data to Social
   */
  send: function() {
    var userData = {
      iconURL: this._rootURL + "/img/" + this.statusIcon,
      // XXX for now, we just hard-code the default avatar image.
      portrait: this._rootURL + "/img/default-avatar.png",
      userName: this._userName,
      displayName: this._userName,
      profileURL: this._rootURL + "/user.html"
    };

    browserPort.postEvent('social.user-profile', userData);
  }
};

function _setupSPA(spa) {
  spa.on("connected", function() {
    _autologinPending = false;
    _currentUserData.connected = true;
    // XXX: we should differentiate login and presence
    ports.broadcastEvent('talkilla.login-success', {
      username: _currentUserData.userName
    });

    // XXX Now we're connected, load the contacts database.
    // Really we should do this after successful sign-in or re-connect
    // but we don't have enough info for the worker for that yet
    tkWorker.loadContacts();
  });

  spa.on("message", function(label, data) {
    ports.broadcastDebug("spa event: " + label, data);
  });

  spa.on("message:users", function(data) {
    data.forEach(function(user) {
      currentUsers[user.nick] = {presence: "connected"};
    });

    ports.broadcastEvent("talkilla.users", getCurrentUsersArray());
  });

  spa.on("message:userJoined", function(userId) {
    if (Object.prototype.hasOwnProperty.call(currentUsers, userId))
      currentUsers[userId].presence = "connected";
    else
      currentUsers[userId] = {presence: "connected"};

    ports.broadcastEvent("talkilla.users", getCurrentUsersArray());
    ports.broadcastEvent("talkilla.user-joined", userId);
  });

  spa.on("message:userLeft", function(userId) {
    // Show the user as disconnected
    if (!Object.prototype.hasOwnProperty.call(currentUsers, userId))
      return;

    currentUsers[userId].presence = "disconnected";

    ports.broadcastEvent("talkilla.users", getCurrentUsersArray());
    ports.broadcastEvent("talkilla.user-left", userId);
  });

  spa.on("message:incoming_call", function(data) {
    // If we're in a conversation, and it is not with the peer,
    // then ignore it
    if (currentConversation) {
      // If the currentConversation window can handle the incoming call
      // data (e.g. peer matches) then just handle it.
      if (currentConversation.handleIncomingCall(data))
        return;

      // XXX currently, we can't handle more than one conversation
      // window open, so just ignore it.
      return;
    }

    currentConversation = new Conversation(data);
  });

  spa.on("message:call_accepted", function(data) {
    currentConversation.callAccepted(data);
  });

  spa.on("message:call_hangup", function(data) {
    if (currentConversation)
      currentConversation.callHangup(data);
  });

  spa.on("error", function(event) {
    ports.broadcastEvent("talkilla.websocket-error", event);
  });

  spa.on("disconnected", function(event) {
    _autologinPending = false;
    _currentUserData.userName = undefined;
    _currentUserData.connected = false;

    // XXX: this will need future work to handle retrying presence connections
    ports.broadcastEvent('talkilla.presence-unavailable', event.code);
    ports.broadcastEvent("talkilla.logout-success", {});
    currentUsers = {};
    // XXX: really these should be reset on signout, not disconnect.
    // Unload the database
    contactsDb.close();
  });
}

function _signinCallback(err, responseText) {
  _loginPending = false;
  var data = JSON.parse(responseText);
  if (err)
    return this.postEvent('talkilla.login-failure', data.error);
  var username = data.nick;
  if (username) {
    _currentUserData.userName = username;

    spa.connect(username);
    ports.broadcastEvent("talkilla.presence-pending", {});
  }
}

function _signoutCallback(err, responseText) {
  _loginPending = false;
  if (err)
    return this.postEvent('talkilla.error', 'Bad signout:' + err);

  _currentUserData.reset();
  currentUsers = {};
  ports.broadcastEvent('talkilla.logout-success');
}

var handlers = {
  // SocialAPI events
  'social.port-closing': function() {
    ports.remove(this);
    if (browserPort === this)
      browserPort = undefined;
    if (currentConversation && currentConversation.port === this)
      currentConversation = undefined;
  },

  'social.initialize': function() {
    // Save the browserPort
    browserPort = this;

    // Now we're connected request any cookies that we've got saved.
    browserPort.postEvent('social.cookies-get');

    // Don't have it in the main list of ports, as we don't need
    // to broadcast all our talkilla.* messages to the social api.
    ports.remove(this);
  },

  'social.cookies-get-response': function(event) {
    var cookies = event.data;
    cookies.forEach(function(cookie) {
      if (cookie.name === "nick") {
        _autologinPending = true;
        _currentUserData.userName = cookie.value;
        // If we've received the configuration info, then go
        // ahead and log in.
        spa.autoconnect(cookie.value);
      }
    });
  },

  // Talkilla events
  'talkilla.login': function(msg) {
    if (!msg.data || !msg.data.assertion) {
      return this.postEvent('talkilla.login-failure', 'no assertion given');
    }
    if (_loginPending || _autologinPending)
      return;

    _loginPending = true;
    this.postEvent('talkilla.login-pending', null);

    spa.signin(msg.data.assertion, _signinCallback.bind(this));
  },

  'talkilla.logout': function() {
    if (!_currentUserData.userName)
      return;

    spa.signout(_currentUserData.userName, _signoutCallback.bind(this));
  },

  'talkilla.conversation-open': function(event) {
    // XXX Temporarily work around to only allow one call at a time.
    if (!currentConversation) {
      currentConversation = new Conversation(event.data);
    }
  },

  'talkilla.chat-window-ready': function() {
    currentConversation.windowOpened(this);
  },

  /**
   * Called when the sidebar is ready.
   * The data for talkilla.sidebar-ready is:
   *
   * - nick: an optional previous nickname
   */
  'talkilla.sidebar-ready': function(event) {
    this.postEvent('talkilla.worker-ready');
    if (_currentUserData.userName) {
      // If there's currently a logged in user,
      this.postEvent('talkilla.login-success', {
        username: _currentUserData.userName
      });
    }
  },

  /**
   * Called when the sidebar request the initial presence state.
   */
  'talkilla.presence-request': function(event) {
    var users = getCurrentUsersArray();
    spa.presenceRequest(_currentUserData.userName);
    this.postEvent('talkilla.users', users);
  },

  /**
   * The data for talkilla.call-offer is:
   *
   * - peer:     the person you are calling
   * - textChat: is this a text chat offer?
   * - offer:    an RTCSessionDescription containing the sdp data for the call.
   */
  'talkilla.call-offer': function(event) {
    spa.callOffer(event.data, _currentUserData.userName);
  },

  /**
   * The data for talkilla.call-answer is:
   *
   * - peer:     the person who is calling you
   * - textChat: is this a text chat offer?
   * - offer:    an RTCSessionDescription containing the sdp data for the call.
   */
  'talkilla.call-answer': function(event) {
    spa.callAccepted(event.data, _currentUserData.userName);
  },

  /**
   * Ends a call. The expected data is:
   *
   * - peer: the person you are talking to.
   */
  'talkilla.call-hangup': function (event) {
    spa.callHangup(event.data, _currentUserData.userName);
  }
};

function Port(port) {
  this.port = port;
  this.id = port._portid;
  // configures this port
  port.onmessage = this.onmessage.bind(this);
}

Port.prototype = {
  /**
   * Posts an error event.
   * @param  {String} error
   */
  error: function(error) {
    this.postEvent("talkilla.error", error);
  },

  /**
   * Port message listener.
   * @param  {Event} event
   */
  onmessage: function(event) {
    var msg = event.data;
    if (msg && msg.topic && (msg.topic in handlers))
      handlers[msg.topic].call(this, msg);
    else
      this.error('Topic is missing or unknown');
  },

  /**
   * Posts a message event.
   * @param  {String} topic
   * @param  {Mixed}  data
   */
  postEvent: function(topic, data) {
    // FIXME: for no obvious reason, this may eventually fail if the port is
    //        closed, while it should never be the case
    this.port.postMessage({topic: topic, data: data});
  }
};

function PortCollection() {
  this.ports = {};
}

PortCollection.prototype = {
  /**
   * Configures and add a port to the stack.
   * @param  {Port} port
   */
  add: function(port) {
    if (port.id in this.ports)
      return;
    this.ports[port.id] = port;
  },

  /**
   * Removes a port from this collection.
   * @param  {Port} port
   */
  remove: function(port) {
    if (port && port.id)
      delete this.ports[port.id];
  },

  /**
   * Retrieves a port from the collection by its id.
   * @param  {String} id
   * @return {Port}
   */
  find: function(id) {
    return this.ports[id];
  },

  /**
   * Broadcasts a message to all ports.
   * @param  {String} topic
   * @param  {Mixed}  data
   */
  broadcastEvent: function(topic, data) {
    for (var id in this.ports)
      this.ports[id].postEvent(topic, data);
  },

  /**
   * Broadcast debug informations to all ports.
   */
  broadcastDebug: function(label, data) {
    if (!gConfig.DEBUG)
      return;
    for (var id in this.ports)
      this.ports[id].postEvent("talkilla.debug", {label: label, data: data});
  },

  /**
   * Broadcasts an error message to all ports.
   * @param  {String} message
   */
  broadcastError: function(message) {
    for (var id in this.ports)
      this.ports[id].error(message);
  }
};

/**
 * The main worker, which controls all the parts of the app.
 *
 * This keeps track of whether or not we're initialised, as it may be
 * that the sidebar or other panels are ready before the worker, and need
 * to know that the worker is actually ready to receive messages.
 */
function TkWorker(options) {
  // XXX Move all globals into this constructor and create them here.
  this.contactsDb = options.contactsDb;
  this.currentUsers = options.currentUsers;
  this.ports = options.ports;
}

TkWorker.prototype = {
  loadContacts: function(cb) {
    this.contactsDb.all(function(err, records) {
      if (err) {
        this.ports.broadcastError(err);
        return;
      }

      records.forEach(function(userId) {
        if (!Object.prototype.hasOwnProperty.call(this.currentUsers, userId))
          this.currentUsers[userId] = {presence: "disconnected"};
      });

      // We need to broadcast the list in case we've been slow loading
      // the database and the initial presence list has already been
      // broadcast.
      this.ports.broadcastEvent('talkilla.users', getCurrentUsersArray());

      // callback is mostly useful for tests
      if (typeof cb === "function")
        cb();
    }.bind(this));
  }
};

// Main Initialisations

ports = new PortCollection();

function onconnect(event) {
  ports.add(new Port(event.ports[0]));
}

_currentUserData = new UserData({}, gConfig);
// XXX: remplace the src by a valid JS file url
spa = new SPA({src: "example.com"});

_setupSPA(spa);

tkWorker = new TkWorker({
  ports: ports,
  contactsDb: contactsDb,
  currentUsers: currentUsers
});
