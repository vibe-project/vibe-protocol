/*
 * Vibe Client
 * http://vibe-project.github.io/projects/vibe-protocol/
 * 
 * Copyright 2014 The Vibe Project 
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
var events      = require("events");
var url         = require("url");
var WebSocket   = require("ws");
var http        = require("http");

http.globalAgent.maxSockets = Infinity;

// This function is exposed to the parent module's `open` as a function to
// create socket to connect to server.
module.exports = function(uri, options) {
    // A socket.
    var self = new events.EventEmitter();
    // To connect to the server and establish a full-duplex message channel,
    // creates a transport. `uri` is a kind of input for handshaking as well as
    // indicates an endpoint.
    var transport = transports[options.transport](uri);
    // When the transport has been established and handshaking has done.
    transport.on("open", function(uri) {
        // `uri` is a kind of output of handshaking.
        var result = url.parse(uri, true).query;
        // To maintain alive connection, heartbeat is used at the socket level.
        options.heartbeat = +result.heartbeat;
        // `_heartbeat` is usually for testing so it may be not passed from the
        // server. The default value is `5000`.
        options._heartbeat = +result._heartbeat || 5000;
        // Fires `open` event which is the first event user can handle.
        self.emit("open");
    });
    // When the transport has received a message from the server.
    transport.on("message", function(text) {
        // Converts JSON text to an event object.
        // 
        // It should have the following properties:
        // * `id: string`: an event identifier.
        // * `type: string`: an event type.
        // * `data: any`: an event data.
        // 
        // To implement `reply` extension, the following properties should be
        // considered as well.
        // * `reply: boolean`: true if this event requires the reply.
        var event = JSON.parse(text);
        // If the server sends a plain event, dispatch it.
        if (!event.reply) {
            self.emit(event.type, event.data);
        // To implement `reply` extension, provides a reply controller to an
        // event handler.
        } else {
            var latch;
            // A function to create a function. 
            function reply(success) {
                return function(value) {
                    // The latch prevents double reply.
                    if (!latch) {
                        latch = true;
                        self.send("reply", {id: event.id, data: value, exception: !success});
                    }
                };
            }
            // Here, the controller is passed to the handler as 2nd argument and
            // calls the server's `resolved` or `rejected` callback by sending
            // `reply` event.
            self.emit(event.type, event.data, {resolve: reply(true), reject: reply(false)});
        }
    });
    // When any error has occurred.
    transport.on("error", function(error) {
        self.emit("error", error);
    });
    // When the transport has been closed for any reason.
    transport.on("close", function() {
        self.emit("close");
    });
    // An id for event. It should be unique among events to be sent to the
    // server and has nothing to do with one the server sent.
    var eventId = 0;
    // A map for reply callbacks for `reply` extension.
    var callbacks = {};
    self.send = function(type, data, resolved, rejected) {
        // It should have the following properties:
        // * `id: string`: an event identifier.
        // * `type: string`: an event type.
        // * `data: any`: an event data.
        // 
        // To implement `reply` extension, the following properties should be
        // available as well.
        // * `reply: boolean`: true if this event requires the reply.
        var event = {
            id: "" + eventId++, 
            type: type, 
            data: data, 
            reply: resolved != null || rejected != null
        };
        // For `reply` extension, stores resolved and rejected callbacks if they
        // are given.
        if (event.reply) {
            callbacks[event.id] = {resolved: resolved, rejected: rejected};
        }
        // Convert the event to a JSON message and sends it through the
        // transport.
        transport.send(JSON.stringify(event));
        return this;
    };
    // For `reply` extension, on the `reply` event, executes the stored reply
    // callbacks with data.
    self.on("reply", function(reply) {
        if (reply.id in callbacks) {
            var cbs = callbacks[reply.id];
            var fn = reply.exception ? cbs.rejected : cbs.resolved;
            if (fn) {
                fn.call(this, reply.data);
            }
            delete callbacks[reply.id];
        }
    });
    // Delegate closing to the transport.
    self.close = function() {
        transport.close();
    };
    // Starts heartbeat on `open` event.
    self.on("open", function() {
        var heartbeatTimer;
        function setHeartbeatTimer() {
            // Sets a timer to send an `heartbeat` event after `heartbeat -
            // _heartbeat` miliseconds.
            heartbeatTimer = setTimeout(function() {
                self.send("heartbeat");
                // Sets a timer to fire heartbeat error and close the socket if
                // the server doesn't respond in the `_heartbeat` interval.
                heartbeatTimer = setTimeout(function() {
                    self.emit("error", new Error("heartbeat"));
                    self.close();
                }, options._heartbeat);
            }, options.heartbeat - options._heartbeat);
        }
        // If the server echoes back the sent `heartbeat` event, clears the
        // timer and set it again.
        self.on("heartbeat", function() {
            clearTimeout(heartbeatTimer);
            setHeartbeatTimer();
        });
        // The timer should be canceled on `close` event.
        self.on("close", function() {
            clearTimeout(heartbeatTimer);
        });
        setHeartbeatTimer();
    });
    return self;
};

// A transport provides full-duplex message channel which ensures no message
// loss and detecting disconnection.
var transports = {};

// WebSocket is a protocol designed for a full-duplex communications over a TCP
// connection. However, it's not always available for various reason.
transports.ws = function(uri) {
    // A transport.
    var self = new events.EventEmitter();
    // URI's protocol part should be `ws`.
    var ws = new WebSocket(uri.replace(/^http/, "ws"));
    // Simply delegates WebSocket's events to transport and transport's
    // behaviors to WebSocket.
    var handshaked = false;
    ws.onmessage = function(event) {
        // When to fire `open` event is a first message which is an output of
        // handshaking not WebSocket's `open` event.
        if (!handshaked) {
            handshaked = true;
            self.emit("open", event.data);
        } else {
            self.emit("message", event.data);
        }
    };
    ws.onerror = function(error) {
        self.emit("error", error);
    };
    ws.onclose = function() {
        self.emit("close");
    };
    self.send = function(data) {
        ws.send(data);
    };
    self.close = function() {
        ws.close();
    };
    return self;
};

// A helper function to make URI to be used in HTTP transports. Only the query
// string part is used and be aware of reserved parameters.
function buildURI(uri, params) {
    var urlObj = url.parse(uri, true);
    urlObj.query = urlObj.query || {};
    for (var i in params || {}) {
        urlObj.query[i] = params[i];
    }
    delete urlObj.search;
    return url.format(urlObj);
}

// A base transport for the following HTTP transports.
transports.httpbase = function(uri) {
    // A transport.
    var self = new events.EventEmitter();
    // A flag to check if this transport is opened.
    var opened = false;
    self.on("open", function(uri) {
        opened = true;
        var result = url.parse(uri, true).query;
        // A newly issued id for HTTP transport. It is used to identify which
        // HTTP transport is associated with which HTTP exchange.
        self.id = result.id;
    });
    self.on("close", function() {
        opened = false;
    });
    // For the client to send something to the server 
    self.send = function(data) {
        var reqOpts = url.parse(buildURI(uri, {id: self.id}));
        // Performs a request through `POST` method. 
        reqOpts.method = "POST";
        // The request's content type header should be `text/plain; charset=utf-8`. 
        reqOpts.headers = {"content-type": "text/plain; charset=utf-8"};
        http.request(reqOpts).on("error", function(error) {
            // Try again as long as this transport is available if sending event
            // to the server fails for some reason.
            if (opened) {
                self.send(data);
            }
        })
        // The final body should be prefixed with `data=`. 
        .end("data=" + data);
    };
    self.close = function() {
        // Aborts the real connection. It should be implemented by others.
        self.abort();
        // Server may not detect disconnection for some reason. To prevent idle
        // connections, notifies the server of disconnection of this connection.
        http.get(buildURI(uri, {id: self.id, when: "abort"}));
    };
    return self;
};

// It performs a HTTP persistent connection and watches changes in response and
// the server prints chunk as data to response.
transports.stream = function(uri) {
    // A transport.
    var self = transports.httpbase(uri);
    // Any error on request-response should propagate to transport.
    function onerror(error) {
        self.emit("error", error);
    }

    // Performs a HTTP persistent connection through `GET` method. `when` param
    // should be `open` and `transport` param should be `stream`. In case of
    // Server-Sent Events, `sse` param should be `true`.
    var req = http.get(buildURI(uri, {when: "open", transport: "stream"}))
    .on("error", onerror).on("response", function(res) {
        // When to fire `open` event is a first message which is an output of
        // handshaking not when the response is available.
        var handshaked = false;
        function onmessage(data) {
            if (!handshaked) {
                handshaked = true;
                self.emit("open", data);
            } else {
                self.emit("message", data);
            }
        }
        // Every chunk may be a single message, multiple messages or a fragment
        // of a single message. This buffer helps handle fragments.
        var buffer = "";
        // Chunks are formatted according to the [event stream
        // format](http://www.w3.org/TR/eventsource/#event-stream-interpretation).
        // However, you don't need to know that. A single message starts with
        // 'data: ' and ends with `\n\n`. That's all you need to know.
        res.on("error", onerror).on("data", function(chunk) {
            // Strips off the left padding of the chunk that appears in the
            // first chunk.
            chunk = chunk.toString().replace(/^\s+/, "");
            // If the chunk consists of only whitespace characters that is 
            // the first chunk padding in the above, there is nothing to do.
            if (!chunk) {
                return;
            }
            // Let's think of a series of the following chunks:
            // * `"data: {}\n\ndata: {}\n\n"`
            // * `"data: {}\n\ndata: {"`
            // * `"}\n\ndata:{"`
            // * `".."`
            // * `".}"`
            // * `"\n\ndata: {}\n\n"`
            // 
            // It looks not easy to handle. So let's concatenate buffer 
            // and chunk. Here the buffer is a string after last `\n\n` 
            // of the concatenation.
            // * `""` + `"data: {}\n\ndata: {}\n\n"`
            // * `""` + `"data: {}\n\ndata: {"`
            // * `"data: {"` + `"}\n\ndata:{"`
            // * `"data: {"` + `".."`
            // * `"data: {.."` + `".}"`
            // * `"data: {...}"` + `"\n\ndata: {}\n\n"`
            
            // Let's split the concatenation by `\n\n`.
            (buffer + chunk).split("\n\n").forEach(function(line, i, lines) {
                // Except the last element, unwraps 'data: ' and fires a message
                // event.
                if (i < lines.length - 1) {
                    onmessage(line.substring("data: ".length));
                } else {
                    // The last element is a fragment of a data which is an
                    // incomplete message. Assigns it to buffer.
                    buffer = line;
                }
            });
        })
        // The end of response corresponds to the close of transport.
        .on("end", function() {
            self.emit("close");
        });
    });
    self.abort = function() {
        // Aborts the current request. The rest of work, firing the `close`
        // event, will be done by `res`'s `end` event handler.
        req.abort();
    };
    return self;
};

// It performs a HTTP persistent connection and the server ends the response
// with data. Then, the client receives it and performs a request again and
// again.
transports.longpoll = function(uri) {
    // A transport.
    var self = transports.httpbase(uri);
    // The current holding request.
    var req;
    // Any error on request-response should propagate to transport.
    function onerror(error) {
        self.emit("error", error);
    }

    // Performs a HTTP persistent connection through `GET` method. The first
    // request's `when` param should be `open` and `transport` param should be
    // `longpoll`. In case of JSONP, `jsonp` param should be `true` and
    // `callback` param should be provided as well.
    req = http.get(buildURI(uri, {when: "open", transport: "longpoll"}))
    .on("error", onerror).on("response", function(res) {
        // A regexp to parse message into [id, data]
        var rdata = /(\d+)\|(.*)/;
        // Aggregates chunks to make a complete response body.
        var body = "";
        res.on("error", onerror).on("data", function(chunk) {
            body += chunk;
        })
        .on("end", function() {
            // The message format is `id|data`. For example, `45|Hi` tells `45`
            // is message id and `Hi` is message data. Here `match[1]` is the
            // message id and `match[2]` is the message data.
            var match = rdata.exec(body);
            // The first message to complete handshake contains an id of this
            // transport. Therefore, exceptionally `open` event should dispatch
            // before starting polling.
            self.emit("open", match[2]);
            // Then starts polling.
            (function poll(lastMsgId) {
                // From the second request, `when` param should be `poll` and
                // `lastMsgId` should be provided for ACK that is a message id
                // of the preceding request.
                req = http.get(buildURI(uri, {id: self.id, when: "poll", lastMsgId: lastMsgId}))
                // If the server responds to this request, determine whether the
                // intention of response is to send event or to close by reading
                // body.
                .on("error", onerror).on("response", function onresponse(res) {
                    var body = "";
                    res.on("error", onerror).on("data", function(chunk) {
                        body += chunk;
                    })
                    .on("end", function() {
                        if (body) {
                            var match = rdata.exec(body);
                            // Starts a poll request again before to fire `message`
                            // event. There must be no idle time between polling.
                            poll(match[1]);
                            self.emit("message", match[2]);
                        // Absent body indicates the server closed the socket.
                        // Accordingly fires the `close` event.
                        } else {
                            self.emit("close");
                        }
                    });
                });
            })(match[1]);
        });
    });
    self.abort = function() {
        // Node.js fires a 'socket hang up' error if there was no response from
        // the server. But, that is a normal case of close in long polling,
        // hence removes all error handlers.
        req.removeAllListeners("error");
        // However, it means `res`'s `end` handler may not exist. Therefore,
        // fires the `close` event on `req`'s `error` event.
        req.on("error", function() {
            self.emit("close");
        });
        req.abort();
    };
    return self;
};