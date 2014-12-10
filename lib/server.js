/*
 * Vibe Server
 * http://vibe-project.github.io/projects/vibe-protocol/
 * 
 * Copyright 2014 The Vibe Project 
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
var events      = require("events");
var url         = require("url");
var uuid        = require("node-uuid");
var WebSocket   = require("ws");

// This function is exposed to the parent module's `server` as a constructor of
// server which consumes HTTP request-response exchange and WebSocket and
// produces socket.
module.exports = function() {
    // A server.
    var self = new events.EventEmitter();
    // Options to configure server and client.
    var options = {
        // A heartbeat interval in milliseconds.
        heartbeat: 20000,
        // This is just to speed up heartbeat test and not required generally.
        // It means the time to wait for the server's response. The default
        // value is `5000`.
        _heartbeat: 5000
    };
    self.setHeartbeat = function(heartbeat) {
        options.heartbeat = heartbeat;
    };
    self.set_heartbeat = function(_heartbeat) {
        options._heartbeat = _heartbeat
    };
    // A set for opened sockets.
    var sockets = [];
    // When a socket is opened.
    self.on("socket", function(socket) {
        // Adds a socket to the set.
        sockets.push(socket);
        // And removes it from the set if it's closed. FYI, `a.splice(b, 1)`
        // means remove `b` from `a`.
        socket.on("close", function() {
            sockets.splice(sockets.indexOf(this), 1);
        });
    });

    // Consumes HTTP request-response exchange and produces HTTP transport.
    // Since HTTP transport consists of multiple HTTP exchanges, HTTP transport
    // is needed to be retrieved using identifier.
    var httpTransports = {};
    // `req` and `res` are expected to be passed from Node.js's `http` and
    // `https` module' Server' `request` event.
    self.handleRequest = function(req, res) {
        req.params = url.parse(req.url, true).query;
        // Any request must not be cached.
        res.setHeader("cache-control", "no-cache, no-store, must-revalidate");
        res.setHeader("pragma", "no-cache");
        res.setHeader("expires", "0");
        // Transports using `XDomainRequest` require CORS headers even in
        // same-origin connection.
        res.setHeader("access-control-allow-origin", req.headers.origin || "*");
        res.setHeader("access-control-allow-credentials", "true");
        switch (req.method) {
        // `GET` method is used to establish a channel for the server to write
        // message to the client and manage transports.
        case "GET":
            // `when` param indicates a specific goal of `GET` request.
            switch (req.params.when) {
            // To establish a new channel.
            case "open":
                // `transport` param is a transport id the client uses which is
                // either `stream` or `longpoll`.
                var transport = transports[req.params.transport];
                if (transport) {
                    // Creates a transport and passes it to socket.
                    var t = transport(req, res);
                    // Adds it to the set by id.
                    httpTransports[t.id] = t;
                    // And removes it from the set by id if it's closed.
                    t.on("close", function() {
                        delete httpTransports[t.id];
                    });
                    // Fires the `socket` event.
                    self.emit("socket", socket(t, options));
                // If the server doesn't support the required transport,
                // responds with `501 Not Implemented`.
                } else {
                    res.statusCode = 501;
                    res.end();
                }
                break;
            // To inject a new HTTP request-response exchange to `longpoll`
            // transport
            case "poll":
                // Finds the corresponding transport by `id` param.
                var transport = httpTransports[req.params.id];
                if (transport) {
                    transport.refresh(req, res);
                } else {
                    // If there is no corresponding socket, responds with `500
                    // Internal Server Error`.
                    res.statusCode = 500;
                    res.end();
                }
                break;
            // To notify server of disconnection by client.
            case "abort":
                // Finds the corresponding transport by `id` param.
                var transport = httpTransports[req.params.id];
                // It will work only when the server couldn't detect
                // disconnection.
                if (transport) {
                    transport.close();
                }
                // In case of browser, it is performed by script tag so set
                // content-type header to `text/javascript` to avoid warning.
                res.setHeader("content-type", "text/javascript; charset=utf-8");
                res.end();
                break;
            // If the given `when` param is unsupported, responds with `501 Not
            // Implemented`.
            default:
                res.statusCode = 501;
                res.end();
            }
            break;
        // `POST` method is used to establish a channel for the client to write
        // message to the server.
        case "POST":
            // Reads the request body.
            var body = "";
            req.on("data", function(chunk) {
                body += chunk;
            });
            req.on("end", function() {
                // Retrieve a message by stripping off leading `data=`.
                var message = body.substring("data=".length);
                // Finds the corresponding transport by `id` param.
                var transport = httpTransports[req.params.id];
                if (transport) {
                    transport.emit("message", message);
                // If the specified transport is not found, responds with `500
                // Internal Server Error`. It might happen if the transport is
                // closed while reading request body.
                } else {
                    res.statusCode = 500;
                }
                res.end();
            });
            break;
        // If the method is neither `GET` nor `POST`, responds with `405 Method
        // Not Allowed`.
        default:
            res.statusCode = 405;
            res.end();
        }
    };

    // Consumes HTTP upgrade and produces WebSocket transport.
    // A factory to upgrade HTTP exchange to WebSocket.
    var webSocketUpgrader = new WebSocket.Server({noServer: true});
    // `req`, `sock` and `head` are expected to be passed from Node.js's `http`
    // and `https` module' Server' `upgrade` event.
    self.handleUpgrade = function(req, sock, head) {
        webSocketUpgrader.handleUpgrade(req, sock, head, function(ws) {
            // Once a given exchange is upgraded to WebSocket, creates a
            // transport and a socket and fires the `socket` event.
            self.emit("socket", socket(transports.ws(ws), options));
        });
    };
    
    return self;
};

// Consumes Transport and produces Socket
function socket(transport, options) {
    // A socket.
    var self = new events.EventEmitter();
    // Starts handshake adding params at the socket level. These params will be
    // handled by client-side socket, and client-side socket will fire `open`
    // event.
    transport.handshake({
        heartbeat: options.heartbeat,
        _heartbeat: options._heartbeat
    });
    // When the transport has received a message from the client.
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
        // If the client sends a plain event, dispatch it.
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
    // client and has nothing to do with one the client sent.
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
    // Sets a timer to close the socket after the heartbeat interval.
    var heartbeatTimer;
    function setHeartbeatTimer() {
        heartbeatTimer = setTimeout(function() {
            self.emit("error", new Error("heartbeat"));
            self.close();
        }, options.heartbeat);
    }
    setHeartbeatTimer();
    // The client will start to heartbeat on its `open` event and send the
    // heartbaet event periodically. Then, cancels the timer, sets it up
    // again and sends the heartbeat event as a response.
    self.on("heartbeat", function() {
        clearTimeout(heartbeatTimer);
        setHeartbeatTimer();
        self.send("heartbeat");
    })
    // To prevent a side effect of the timer, clears it on the close event.
    .on("close", function() {
        clearTimeout(heartbeatTimer);
    });
    return self;
}

//A transport provides full-duplex message channel which ensures no message
//loss and detecting disconnection.
var transports = {};

// WebSocket is a protocol designed for a full-duplex communications over a TCP
// connection. However, it's not always available for various reason.
transports.ws = function(ws) {
    // A transport.
    var self = new events.EventEmitter();
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
    self.send = function(data) {
        ws.send(data);
    };
    self.close = function() {
        ws.close();
    };
    // Though WebSocket connection is established, it is not regarded as opened
    // before completing handshake.
    self.handshake = function(map) {
        // A handshake result is URI.
        var uri = url.format({query: map});
        // The first message is the handshake result.
        self.send(uri);
    };
    return self;
};

//A base transport for the following HTTP transports.
transports.httpbase = function() {
    // A transport.
    var self = new events.EventEmitter();
    // Because HTTP transport consists of multiple exchanges, an identifier is
    // required. UUID is recommended as the identifier format.
    self.id = uuid.v4();
    // Though HTTP connection is established, it is not regarded as opened
    // before completing handshake.
    self.handshake = function(map) {
        map = map || {};
        // Transport id should be added as `id` param. 
        map.id = self.id;
        // A handshake result is URI.
        var uri = url.format({query: map});
        // The first message is the handshake result.
        self.send(uri);
    };
    return self;
};

// It performs a HTTP persistent connection and watches changes in response and
// the server prints chunk as data to response.
transports.stream = function(req, res) {
    // A transport.
    var self = transports.httpbase();

    // Any error on request-response should propagate to transport.
    function onerror(error) {
        self.emit("error", error);
    }
    req.on("error", onerror);
    res.on("error", onerror);
    
    function onclose() {
        self.emit("close");
    }
    // Emitted when the underlying connection was terminated abnormally.
    res.on("close", onclose);
    // Emitted when the complete response has been sent.
    res.on("finish", onclose);
    
    // The content-type headers should be `text/event-stream` for Server-Sent
    // Events and `text/plain` for others. Also the response should be encoded in `utf-8`.
    res.setHeader("content-type", "text/" + 
        // If it's Server-Sent Events, `sse` param is `true`.
        (req.params.sse === "true" ? "event-stream" : "plain") + "; charset=utf-8");
    // The padding is required, which makes the client-side transport on old
    // browsers be aware of change of the response. It should be greater
    // than 1KB, be composed of white space character and end with `\r`,
    // `\n` or `\r\n`.
    var text2KB = Array(2048).join(" ");
    res.write(text2KB + "\n");

    // The response body should be formatted in the [event stream
    // format](http://www.w3.org/TR/eventsource/#parsing-an-event-stream).
    self.send = function(data) {
        // According to the format, data should be broken up by `\r`, `\n`, or
        // `\r\n`.
        var payload = data.split(/\r\n|[\r\n]/).map(function(line) {
            // Each line should be prefixed with 'data: ' and postfixed with
            // `\n`.
            return "data: " + line + "\n";
        })
        // Prints `\n` as the last character of a message.
        .join("") + "\n";
        res.write(payload);
    };
    // Ends the response. Accordingly, `onclose` will be executed by `res`'s
    // `finish` event.
    self.close = function() {
        res.end();
    };
    return self;
};

// It performs a HTTP persistent connection and the server ends the response
// with data. Then, the client receives it and performs a request again and
// again.
transports.longpoll = function(req, res) {
    // The current holding response.
    var response;
    // Whether the transport is aborted or not.
    var aborted;
    // Whether the current response is completed or not.
    var completed;
    // Whether any data is written on the current response body or not. if this
    // is true, then `completed` is also true but not vice versa.
    var written;
    // A timer to prevent from being idle connection.
    var closeTimer;
    // The parameters of the first request. That of subsequent requests are not
    // used.
    var params = req.params;
    // A message id.
    var msgId = 0;
    // A queue containing messages that the client couldn't receive.
    var queue = {};
    // A transport.
    var self = transports.httpbase();

    // In long polling, multiple HTTP exchanges are used to establish a channel
    // for the server to write message to client. This function will be called
    // every time the client starts new poll request.
    self.refresh = function(req, res) {
        // Any error on request-response should propagate to transport.
        function onerror(error) {
            self.emit("error", error);
        }
        req.on("error", onerror);
        res.on("error", onerror);
        
        function onclose() {
            // The current exchange's life ends but this has nothing to do with
            // `written`.
            completed = true;
            // If this request was to `poll` and the server didn't write
            // anything, completion of this response is the end of the
            // transport. Hence, fires the `close` event.
            if (req.params.when === "poll" && !written) {
                self.emit("close");
            // Otherwise client will issue `poll` request again so it sets a
            // timer to fire close event to prevent this connection from
            // remaining in limbo. 2s is enough.
            } else {
                closeTimer = setTimeout(function() {
                    self.emit("close");
                }, 2000);
            }
        }
        // Emitted when the underlying connection was terminated abnormally.
        res.on("close", onclose);
        // Emitted when the response has been sent.
        res.on("finish", onclose);

        // The content-type header should be `text/javascript` for JSONP and
        // `text/plain` for the others.
        res.setHeader("content-type", "text/" + 
            // If it's JSONP, `jsonp` param is `true`.
            (params.jsonp === "true" ? "javascript" : "plain") + "; charset=utf-8");
        // Sets the response.
        response = res;
        // If the request is to `poll` after handshake.
        if (req.params.when === "poll") {
            // Resets flags, timers as new exchange is supplied.
            completed = written = false;
            clearTimeout(closeTimer);
            // If aborted is `true` here, it means the user tried to abort the
            // connection but it couldn't be done because the current response
            // was already completed for other reason. So ends the new exchange.
            if (aborted) {
                res.end();
                return;
            }
            // `lastMsgId` param is a last message client-received. Removes it
            // from the queue.
            delete queue[req.params.lastMsgId];
            // If the queue is not empty, it indicates there are still messages
            // client should receive.
            for (var mId in queue) {
                // Sends it one by one preventing it from being added to the
                // queue again.
                self.send(queue[mId], true);
                break;
            }
        }
    };
    // Refreshes with the first exchange.
    self.refresh(req, res);
    self.send = function(data, noQueue) {
        // If data is needed to be cached.
        if (!noQueue) {
            // Increases a message id.
            msgId++;
            // This is a final form of message. For example, if message id is
            // `45` and message data is `Hi`, then `45|Hi` is a final payload.
            data = msgId + "|" + data;
            // Adds it to the queue.
            queue[msgId] = data;
        }
        // Only when the current response is not completed, it's possible to
        // send a message. If not, because the data is cached, it will be sent
        // in next poll through `refresh` method.
        if (!completed) {
            // Flags the current response is written.
            written = true;
            // In case of JSONP, the response text is supposed to be a
            // JavaScript code executing a callback with data. The callback name
            // is passed as the first request's `callback` param and the data to
            // be returned have to be escaped to a JavaScript string literal.
            // For others, no formatting is needed. All the long polling
            // transports has to finish the request after processing. The
            // `onclose` will be executed after this.
            response.end(params.jsonp === "true" ? 
                params.callback + "(" + JSON.stringify(data) + ");" : data);
        }
    };
    self.close = function() {
        // Marks the transport is aborted.
        aborted = true;
        // Ends response if possible. If not, a next poll request will be ended
        // immediately by `aborted` flag and will fire the `finish` event.
        if (!completed) {
            response.end();
        }
    };
    return self;
};