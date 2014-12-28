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
module.exports = function(uris, options) {
    // A socket.
    var self = new events.EventEmitter();
    // If `uris` is a string, makes it array.
    if (!Array.isArray(uris)) {
        uris = [uris];
    }
    // Translates abbreviated URI into normal URIs. Then, the manipulated
    // `uris`'s each element corresponds to each transport.
    for (var i = 0; i < uris.length; i++) {
        var urlObj = url.parse(uris[i], true);
        delete urlObj.search;
        // URI whose scheme is `http` or `https` and `transport` param is absent
        // is an abbreviated one. No transport stands for `ws`, `stream` and
        // `longpoll` transport in order.
        if ((urlObj.protocol === "http:" || urlObj.protocol === "https:") && !urlObj.query.transport) {
            urlObj.query.transport = "ws";
            var uri1 = url.format(urlObj);
            urlObj.query.transport = "stream";
            var uri2 = url.format(urlObj);
            urlObj.query.transport = "longpoll";
            var uri3 = url.format(urlObj);
            // It means that replace `i+1`th element with `uri1`, `uri2` and
            // `uri3`. For example, `[1,2,3].splice(1, 1, 4, 5, 6)` results in
            // `[1,4,5,6,3]`.
            uris.splice(i, 1, uri1, uri2, uri3);
        }
    }
    // Prepares for `options` object.
    options = options || {};
    // A transport timeout in ms. It applies when a transport starts connection.
    options.timeout = options.timeout || 3000;
    // A reference of transport associated with this socket.
    var transport;
    // Initializes a transport.
    function initTransport(trans) {
        // Associates the transport with the socket.
        transport = trans;
        // When the transport has received a message from the server.
        transport.on("message", function(text) {
            // Converts JSON text to an event object.
            // 
            // It should have the following properties:
            // * `id: string`: an event identifier.
            // * `type: string`: an event type.
            // * `data: any`: an event data.
            // 
            // To implement `reply` extension, the following properties should
            // be considered as well.
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
                // Here, the controller is passed to the handler as 2nd argument
                // and calls the server's `resolved` or `rejected` callback by
                // sending `reply` event.
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
    }
    // A copy of `uris`.
    var candidates = [].slice.call(uris);
    // A temporary transport to find working transport.
    var trans;
    // Tries connection with next available transport.
    function open() {
        // If there is no remaining transport, fires `error` and `close` event
        // as it means that all available transports failed.
        if (candidates.length === 0) {
            self.emit("error", new Error());
            self.emit("close");
            return;
        }
        // Removes the first element and gets it. For example, `[1,2].shift()`
        // results in `[2]`.
        var uri = candidates.shift();
        var transportName;
        // Determines the transport name by URI.
        var urlObj = url.parse(uri, true);
        if (urlObj.protocol === "ws:" || urlObj.protocol === "wss:") {
            transportName = "ws";
        } else if (urlObj.protocol === "http:" || urlObj.protocol === "https:") {
            transportName = urlObj.query.transport;
        }
        // As an option, `timeout` should be passed.
        trans = transports[transportName](uri, {timeout: options.timeout});
        // If this transport has failed to establish a connection:
        trans.on("close", open);
        // At the socket level, the first message is used to handshake. `once`
        // registers one-time event handler.
        trans.once("message", function(text) {
            // The handshake output is in the form of URI and uses query part to
            // get/set header.
            var result = url.parse(text, true).query;
            // To maintain alive connection, heartbeat is used.
            options.heartbeat = +result.heartbeat;
            // `_heartbeat` is usually for testing so it may be not passed from
            // the server. The default value is `5000`.
            options._heartbeat = +result._heartbeat || 5000;
            // Now that handshaking is completed, removes `close` event's `open`
            // handler because it's only to do fallback within `transports`
            // option.
            trans.removeListener("close", open);
            // The working transport is found so initializes it.
            initTransport(trans);
            // And fires `open` event which is the first event user can handle.
            self.emit("open");
        });
        // The transport starts connection.
        trans.open();
    }
    // It is to stop the whole process to find a working transport when the
    // `close` method is called while doing that
    function stop() {
        // Because `open` tries a next connection.
        trans.removeListener("close", open);
        trans.close();
    }
    // Until socket is opened, `close` method triggers `stop` function.
    self.on("close", stop).on("open", function() {
        self.removeListener("close", stop);
    });
    // Finds a working transport from the given `transports` option.
    open();
    // An id for event. It should be unique among events to be sent to the
    // server and has nothing to do with one the server sent.
    var eventId = 0;
    // A map for reply callbacks for `reply` extension.
    var callbacks = {};
    self.send = function(type, data, resolved, rejected) {
        if (!transport) {
            self.emit("error", new Error("notopened"));
            return this;
        }
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
        if (transport) {
            // It finally fires close event to socket.
            transport.close();
        } else {
            // If this method is called while connecting to the server
            self.emit("close");
        }
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

// A base transport.
transports.base = function(uri, options) {
    // A transport.
    var self = new events.EventEmitter();
    self.open = function() {
        // Establishes the real connection. It should be implemented by others.
        self.connect(uri, options);
        // Sets a timeout timer.
        var timeoutTimer = setTimeout(function() {
            // Fires a timeout error.
            self.emit("error", new Error("timeout"));
            // It should ensure that `close` event is fired.
            self.close();
        }, options.timeout);
        // If it establishes a connection, cancels the timer.
        self.on("open", function() {
            clearTimeout(timeoutTimer);
        });
        // If it fails to establish a connection before the timer expires,
        // cancels the timer.
        self.on("close", function() {
            clearTimeout(timeoutTimer);
        });
    };
    return self;
};

// WebSocket is a protocol designed for a full-duplex communications over a TCP
// connection. However, it's not always available for various reason.
transports.ws = function(uri, options) {
    // A transport.
    var self = transports.base(uri, options);
    var ws;
    self.connect = function() {
        // URI's protocol part should be `ws`.
        ws = new WebSocket(uri.replace(/^http/, "ws"));
        // WebSocket doesn't use handshake unlike other transports because it
        // already meets requirements of transport.
        ws.onopen = function() {
            self.emit("open");
        };
        // Simply delegates WebSocket's events to transport and transport's
        // behaviors to WebSocket.
        ws.onmessage = function(event) {
            self.emit("message", event.data);
        };
        ws.onerror = function(error) {
            self.emit("error", error);
        };
        ws.onclose = function() {
            self.emit("close");
        };
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
transports.httpbase = function(uri, options) {
    // A transport.
    var self = transports.base(uri, options);
    // A flag to check if this transport is opened.
    var opened = false;
    self.on("open", function(uri) {
        opened = true;
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
transports.stream = function(uri, options) {
    // A transport.
    var self = transports.httpbase(uri, options);
    // Any error on request-response should propagate to transport.
    function onerror(error) {
        self.emit("error", error);
    }

    var req;
    self.connect = function() {
        // Performs a HTTP persistent connection through `GET` method. `when`
        // param should be `open` and `transport` param should be `stream`. In
        // case of Server-Sent Events, `sse` param should be `true`.
        req = http.get(buildURI(uri, {when: "open", transport: "stream"}))
        .on("error", onerror).on("response", function(res) {
            // When to fire `open` event is a first message which is an output
            // of handshaking not when the response is available.
            var handshaked = false;
            function onmessage(data) {
                if (!handshaked) {
                    handshaked = true;
                    // The handshake output is in the form of URI.
                    var result = url.parse(data, true).query;
                    // A newly issued id for HTTP transport. It is used to
                    // identify which HTTP transport is associated with which
                    // HTTP exchange.
                    self.id = result.id;
                    // And then fire `open` event.
                    self.emit("open");
                } else {
                    self.emit("message", data);
                }
            }
            // Every chunk may be a single message, multiple messages or a
            // fragment of a single message. This buffer helps handle fragments.
            var buffer = "";
            // Chunks are formatted according to the [event stream
            // format](http://www.w3.org/TR/eventsource/#event-stream-interpretation).
            // However, you don't need to know that. A single message starts
            // with 'data: ' and ends with `\n\n`. That's all you need to know.
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
                    // Except the last element, unwraps 'data: ' and fires a
                    // message event.
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
    };
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
transports.longpoll = function(uri, options) {
    // A transport.
    var self = transports.httpbase(uri, options);
    // Any error on request-response should propagate to transport.
    function onerror(error) {
        self.emit("error", error);
    }

    // The current holding request.
    var req;
    self.connect = function() {
        // Performs a HTTP persistent connection through `GET` method. The first
        // request's `when` param should be `open` and `transport` param should be
        // `longpoll`. In case of JSONP, `jsonp` param should be `true` and
        // `callback` param should be provided as well.
        req = http.get(buildURI(uri, {when: "open", transport: "longpoll"}))
        .on("error", onerror).on("response", function(res) {
            var rdata = /(\d+)\|(.*)/;
            // Aggregates chunks to make a complete response body.
            var body = "";
            res.on("error", onerror).on("data", function(chunk) {
                body += chunk;
            })
            .on("end", function() {
                // The response body of the `open` request contains a result of
                // handshake. The handshake output is in the form of URI.
                var result = url.parse(body, true).query;
                // A newly issued id for HTTP transport. It is used to identify
                // which HTTP transport is associated with which HTTP exchange.
                self.id = result.id;
                // Before giving a user opportunity to handle transport through
                // `open` event, polling must be started. Because, if a user closes
                // the transport on open event, the active `req` is required.
                poll();
                self.emit("open");
                
                // Then starts polling.
                function poll(lastMsgId) {
                    // From the second request, `when` param should be `poll` and
                    // `lastMsgId` should be provided for ACK that is a message id
                    // of the preceding request.
                    req = http.get(buildURI(uri, {id: self.id, when: "poll", lastMsgId: lastMsgId}))
                    // If the server responds to this request, determine whether the
                    // intention of response is to send event or to close by reading
                    // body.
                    .on("error", onerror).on("response", function(res) {
                        var body = "";
                        res.on("error", onerror).on("data", function(chunk) {
                            body += chunk;
                        })
                        .on("end", function() {
                            if (body) {
                                // The message format is `id|data`. For example, `45|Hi` tells `45`
                                // is message id and `Hi` is message data. Here `match[1]` is the
                                // message id and `match[2]` is the message data.
                                // This regexp parses body into [id, data].
                                var match = /(\d+)\|(.*)/.exec(body);
                                // Starts a poll request again before to fire `message`
                                // event. There must be no idle time between polling
                                // likewise.
                                poll(match[1]);
                                self.emit("message", match[2]);
                            // Absent body indicates the server closed the socket.
                            // Accordingly fires the `close` event.
                            } else {
                                self.emit("close");
                            }
                        });
                    });
                }
            });
        });
    };
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