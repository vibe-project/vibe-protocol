//     Server 3.0.0.Alpha1-SNAPSHOT
//     http://atmosphere.github.io/react/protocol/
// 
//     Copyright 2014-2014, Donghwan Kim 
//     Licensed under the Apache License, Version 2.0
//     http://www.apache.org/licenses/LICENSE-2.0

// This is the server-side reference implementation of the 
// [React protocol](http://atmosphere.github.io/react/protocol/) written in
// easy-to-read JavaScript running on Node.js.
// 
// **Note**
// * For production use, see the [React Java Server](http://atmosphere.github.io/react/java-server/).
// * JavaScript runs in a single thread, so mind thread-safety.
// 
var events  = require("events"), 
    url     = require("url"), 
    crypto  = require("crypto"), 
    ws      = require("ws");

// ## Exports
// ### server
// Returns a new react server. It is installed by passing request 
// and upgrade events dispatched by Node's HTTP/HTTPS server to the server.
//
//     var server = require("./server").server(),
//         httpServer = require("http").createServer();
//
//     server.on("socket", function(socket) {
//       socket.send("greetings", "Hi");
//     });
//
//     httpServer.listen(8080)
//     .on("request", server.handleRequest)
//     .on("upgrade", server.handleUpgrade);
exports.server = server;

// ## Server
// A react server.
//
// **Events**
// * `socket(socket)`: when the socket has been opened. 
//
// **Methods**
// * `handleRequest(request, response)`: HTTP request handler.
// * `handleUpgrade(request, socket, head)`: HTTP upgrade handler.
function server() {
    var sockets = {}, 
        server = new events.EventEmitter();
    
    // ### Handling HTTP request
    // An HTTP exchange is used for HTTP transports. 
    // If you are going to use only WebSocket, skip this part.
    server.handleRequest = function(req, res) {
        switch (req.method) {
        // ### GET
        // `GET` method is used to establish and manage transports
        // as a channel for the server to push something to the client.
        case "GET":
            // This HTTP persistent connection must not be cached.
            nocache(req, res);
            // A client using transport based on XDomainRequest needs CORS
            // headers even in same-origin connection.
            cors(req, res);
            // Stores a map of all the parameters to the request for future use.
            req.params = url.parse(req.url, true).query;
            // `when` param indicates a goal of `GET` request.
            switch (req.params.when) {
            // #### open
            // Open a new socket establishing required transport and fires the
            // `socket` event. `transport` param is an id of transport the client uses.
            case "open":
                switch (req.params.transport) {
                case "sse": case "streamxhr": case "streamxdr": case "streamiframe":
                    server.emit("socket", socket(req.params, transports.stream(req, res)));
                    break;
                case "longpollajax": case "longpollxdr": case "longpolljsonp":
                    server.emit("socket", socket(req.params, transports.longpoll(req, res)));
                    break;
                // If the server doesn't support the required transport,
                // responds with `501 Not Implemented`.
                default:
                    res.statusCode = 501;
                    res.end();
                }
                break;
            // #### poll
            // Inject a new exchange of request and response to the long polling
            // transport of the socket whose id is `id` param. In long polling,
            // a pseudo-connection consisting of disposable exchanges pretends to
            // be a persistent connection.
            case "poll":
                if (req.params.id in sockets) {
                    sockets[req.params.id].transport.refresh(req, res);
                } else {
                    // If there is no socket using the required transport,
                    // responds with `500 Internal Server Error`.
                    res.statusCode = 500;
                    res.end();
                }
                break;
            // #### abort
            // This notification means the client considers the socket whose id
            // is `id` param as closed so abort the socket if the server
            // couldn't detect it. This is essential when a browser can't close
            // the socket (script tag used in longpolljsonp can't be cancelled 
            // unless the server ends it.). In that case, the browser may not be
            // able to perform any further request due to restriction in the
            // number of simultaneous connections.
            case "abort": 
                if (req.params.id in sockets) {
                    sockets[req.params.id].close();
                }
                // In case of browser, the abort request is performed by script
                // tag so set content-type header to `text/javascript` to avoid
                // warning.
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
        // ### POST
        // `POST` method is used to supply HTTP transports with message
        // as a channel for the client to push something to the server.
        case "POST":
            // Old browsers like Internet Explorer 7 caches `POST` request.
            nocache(req, res);
            // A client using transport based on XDomainRequest needs CORS
            // headers even in same-origin connection.
            cors(req, res);
            // Reads body to retrieve message. Only text payload is allowed now.
            var body = "";
            req.on("data", function(chunk) {
                body += chunk;
            });
            req.on("end", function() {
                // Make JSON string by stripping off leading `data=` 
                // and find a socket id.
                var text = /^data=(.+)/.exec(body)[1],
                    id = /"socket":"([^\"]+)"/.exec(text)[1];
                // Fires a message event to the socket's transport 
                // whose id is `id` with the JSON string.
                if (id in sockets) {
                    sockets[id].transport.emit("message", text);
                // If the specified socket is not found, 
                // responds with `500 Internal Server Error`.
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
        
        function nocache(req, res) {
            res.setHeader("cache-control", "no-cache, no-store, must-revalidate");
            res.setHeader("pragma", "no-cache");
            res.setHeader("expires", "0");
        }
        
        function cors(req, res) {
            res.setHeader("access-control-allow-origin", req.headers.origin || "*");
            res.setHeader("access-control-allow-credentials", "true");
            if (req.headers["access-control-request-headers"]) {
                res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"]);
            }
        }
    };

    // ### Handling HTTP upgrade
    // An HTTP upgrade is used to upgrade an HTTP request to the WebSocket
    // protocol and open a new socket establishing the WebSocket transport.
    var wsServer = new ws.Server({noServer: true});
    server.handleUpgrade = function(req, sock, head) {
        wsServer.handleUpgrade(req, sock, head, function(ws) {
            server.emit("socket", socket(url.parse(req.url, true).query, transports.ws(ws)));
        });
    };
    
    // ### Initializing a socket
    server.on("socket", function(socket) {
        // Registers a new socket to the repository, `sockets`, and deletes it
        // when it's been closed to make the repository have only opened sockets. 
        sockets[socket.id] = socket;
        socket.on("close", function() {
            delete sockets[socket.id];
        })
    });
    
    return server;
};

// ## Transport
// A transport hides internal techniques and policies for Comet 
// or WebSocket and provides a simple view of frame-based connection.
//
// **Events**
// * `close()`: when the transport has been closed. 
// * `message(data: string)`: when the transport has received data. 
// 
// **Methods**
// * `send(data: string)`: sends data.
// * `close()`: closes the transport.
var transports = {};

// ### WebSocket
// Covers `ws`.
transports.ws = function(ws) {
    // Simply delegates WebSocket's events to transport and transport's behaviors to WebSocket.
    var transport = new events.EventEmitter();
    ws.onclose = function() {
        transport.emit("close");
    };
    ws.onmessage = function(event) {
        transport.emit("message", event.data);
    };
    transport.send = function(data) {
        ws.send(data);
    };
    transport.close = function() {
        ws.close();
    };
    return transport;
};

// ### HTTP Streaming
// Covers `sse`, `streamxhr`, `streamxdr`, `streamiframe`.
transports.stream = function(req, res) {
    var text2KB = Array(2048).join(" "),
        isAndroidLowerThan3 = /Android [23]./.test(req.headers["user-agent"]),
        transport = new events.EventEmitter();
    
    // #### Handling HTTP exchange
    // The content-type headers should be `text/event-stream` for `sse` and
    // `text/plain` for others. `text/plain` prevents `streamiframe` from
    // parsing the response as HTML. Also the response should be encoded in 
    // `utf-8` format for `sse`.
    res.setHeader("content-type", "text/" + (req.params.transport === "sse" ? "event-stream" : "plain") + "; charset=utf-8");

    // The padding is required, which makes the client-side transport be aware
    // of change of the response and the client-side socket fire open event.
    // It should be greater than 1KB (4KB for Android browser lower than 3), be
    // composed of white space character and end with `\r`, `\n` or `\r\n`.
    // It applies to `streamxdr`, `streamiframe`, `streamxhr` in Android browser
    // lower than 3.
    res.write((isAndroidLowerThan3 ? text2KB : "") + text2KB + "\n");

    // When either client or server closes the transport, fires a close event.
    function onclose() {
        transport.emit("close");
    }
    res.on("close", onclose);
    res.on("finish", onclose);
    
    // #### send
    transport.send = function(data) {
        // The response text should be formatted in the event stream format.
        // This is a requirement of `sse` but the rest also accept that format
        // for convenience.
        var payload =
            // Android browser lower than 3 needs 4KB padding at the top of each
            // event.
            (isAndroidLowerThan3 ? text2KB + text2KB : "") +
            // Breaks data up by `\r`, `\n`, or `\r\n`, and append `data: ` to the
            // beginning of each line.
            data.split(/\r\n|[\r\n]/).map(function(chunk) {
                return "data: " + chunk + "\n";
            })
            .join("") +
            // Prints `\n` to mark the end of a single data.
            "\n";
        
        // Just to be sure, don't be confused with the chunked transfer encoding.
        // It's the web server's business.
        res.write(payload);
    };
    // #### close
    transport.close = function() {
        // By ending the response.
        res.end();
    };
    return transport;
};

// ### HTTP Long polling
// Covers `longpollajax`, `longpollxdr`, `longpolljsonp`.
transports.longpoll = function(req, res) {
    // Current response.
    var response,
        // Whether the current response has ended or not.
        ended,
        // Whether data is written on the current response or not.
        // if this is true, then `ended` is also true but not vice versa.
        written,
        // A timer to prevent from being idle connection.
        closeTimer,
        // The parameters of the first request. That of subsequent requests are not used.
        params = req.params,
        // A queue containing data needed to be sent again.
        queue = [],
        transport = new events.EventEmitter();

    // #### Refreshing HTTP exchange
    // In long polling, an exchange of request and response is disposable
    // so expose this method to supply with subsequent exchanges.
    transport.refresh = function(req, res) {
        // The content-type header should be `text/javascript` for `longpolljsonp`
        // and `text/plain` for the others.
        res.setHeader("content-type", "text/" + (params.transport === "longpolljsonp" ? "javascript" : "plain") + "; charset=utf-8");
        
        // When either client or server closes the current exchange. 
        function onclose() {
            // The current exchange's life ends but this has nothing to do with
            // `written`.
            ended = true;
            // If the request is to `poll` and the server didn't write anything,
            // completion of this response is the end of the transport.
            if (req.params.when === "poll" && !written) {
                transport.emit("close");
            }
            // Sets a timer to fire close event between polls.
            // Without the timer, if the client disconnects connection during
            // dispatching event, this connection will remain in limbo.
            closeTimer = setTimeout(function() {
                transport.emit("close");
            }, 500);
        }
        res.on("finish", onclose);
        res.on("close", onclose);
        
        // ##### Request to open
        // If the request is to `open`, end it. 
        // The purpose of this is to tell the client that the server is alive.
        if (req.params.when === "open") {
            res.end();
        // ##### Request to poll
        // If the request is to `poll`, remove the client-received data from queue 
        // and flush the rest in queue if they exsits or wait the next data.
        } else {
            // Resets the response, flags, timers as new exchange is supplied.
            response = res;
            ended = written = false;
            clearTimeout(closeTimer);
            // Removes client-received events from the queue. `lastEventIds` param 
            // is a comma-separated values of id of client-received events.
            if (req.params.lastEventIds) {
                req.params.lastEventIds.split(",").forEach(function(lastEventId) {
                    queue.forEach(function(data) {
                        if (lastEventId === /"id":"([^\"]+)"/.exec(data)[1]) {
                            queue.splice(queue.indexOf(data), 1);
                        }
                    });
                });
            }
            // If cached data remain in the queue, flushes them in the form of
            // JSON array. This is not the same with `JSON.stringify(queue)` because
            // elements in queue are already JSON string.
            if (queue.length) {
                transport.send("[" + queue.join(",") + "]", true);
            }
        }
    };
    // Refreshes with the first exchange.
    transport.refresh(req, res);
    // #### send
    transport.send = function(data, fromQueue) {
        // If data is not from the queue, caches it.
        if (!fromQueue) {
            queue.push(data);
        }
        // Only when the current response is not ended it's possible to send.
        // If it is ended, the cached data will be sent in next poll.
        if (!ended) {
            // Flags the current response is written.
            written = true;
            var payload =
                // In case of `longpolljsonp`, the response text should be a
                // JavaScript code snippet executing a callback with data.
                // The callback name is passed as the first request's `callback`
                // param so the data have to be escaped to a JavaScript string literal.
                params.transport === "longpolljsonp" ? params.callback + "(" + JSON.stringify(data) + ");" :
                // For others, no formatting is needed.
                data;
            // All the long polling transports has to finish the request after
            // processing. The `ended` will be true after this.
            response.end(payload);
        }
    };
    // #### close
    transport.close = function() {
        // By ending response if possible.
        if (!ended) {
            response.end();
        }
    };        
    return transport;
};

// ## Socket
// A socket is a connectivity between the two react endpoints and an interface
// for developers creating react applications.
//
// **Events**
// * `close()`: when the socket has been closed.
// * Any event can be used and exchanged unless their name is `open`, `close`, 
// `reply` or `heartbeat` and can have `data:any` as a first arg and 
// `reply:reply` to handle the client's callback as a second arg.
// 
// **Properties**
// * `id`: an identifier of the socket.
//
// **Methods**
// * `send(event: string)`: sends an event.
// * `send(event: string, data: any)`: sends an event with data.
// * `send(event: string, data: any, resolved: function(arg: any), 
// rejected: function(arg: any))`: sends an event with data attaching 
// resolved and rejected callbacks to be called by the client.
// * `close()`: closes the socket.
function socket(params, transport) {
    var socket = new events.EventEmitter();
    
    // ### Handling transport
    
    // I don't recommend to expose transport but it's needed here for HTTP transports. 
    socket.transport = transport;
    // Fires the close event if the underlying transport has been closed.
    transport.on("close", function() {
        socket.emit("close");
    });
    // Fires an event if the underlying transport has received a message 
    // from the client.
    transport.on("message", function(text) {
        // The latch prevents double reply.
        var latch,
            // Converts JSON text to an event object.
            event = JSON.parse(text);
        // #### An event sent by the client
        // It should have the following properties:
        // * `socket: string`: a target socket for HTTP transports.
        // * `id: string`: an event identifier.
        // * `type: string`: an event type.
        // * `data: any`: an event data.
        // * `reply: boolean`: whehter to handle reply or not.
        socket.emit(event.type, event.data, !event.reply ? null : {
            // Calls the client's resolved callback whose event id is `event.id` with `value`.
            resolve: function(value) {
                if (!latch) {
                    latch = true;
                    socket.send("reply", {id: event.id, data: value, exception: false});
                }
            },
            // Calls the client's rejected callback whose event id is `event.id` with `reason`.
            reject: function(reason) {
                if (!latch) {
                    latch = true;
                    socket.send("reply", {id: event.id, data: reason, exception: true});
                }
            }
        });
    });
    // ### id
    // Assign an id that is UUID generated by client.
    // 
    // **TODO** id should be generated by the server.
    socket.id = params.id;
    // A map for reply callbacks to be handled by the client.
    var callbacks = {};
    // ### send
    socket.send = function(type, data, resolved, rejected) {
        // #### An event to be sent to the client
        // It should have the following properties:
        // * `id: string`: an event identifier.
        // * `type: string`: an event type.
        // * `data: any`: an event data.
        // * `reply: boolean`: whehter to handle reply or not.
        var event = {
                id: crypto.randomBytes(3).toString("hex"), 
                type: type, 
                data: data, 
                reply: !!(resolved || rejected)
            };
        
        // Stores resolved and rejected callbacks if they are given.
        if (event.reply) {
            callbacks[event.id] = {resolved: resolved, rejected: rejected};
        }
        
        // Convert event object to JSON string and sends it through the transport.
        // It will be formatted properly according to which the transport is used.
        transport.send(JSON.stringify(event));
    };
    // ### close
    // By closing the transport.
    socket.close = function() {
        transport.close();
    };
    // ### reply
    // If the client sends the reply event, executes the stored reply
    // callbacks with data and deletes it.
    socket.on("reply", function(reply) {
        if (reply.id in callbacks) {
            var cbs = callbacks[reply.id],
                fn = cbs.exception ? cbs.rejected : cbs.resolved;
            if (fn) {
                fn(reply.data);
            }
            delete callbacks[reply.id];
        }
    });
    // ### heartbeat
    // If `heartbeat` param is not `false` and is a number, prepares 
    // the heartbeat handshakes. FYI `+false` gives `NaN` equal to `false` 
    // and `+5000` gives `5000` equal to `true` in JavaScript.
    if (+params.heartbeat) {
        // Sets a timer to close the socket after the heartbeat interval.
        var heartbeatTimer;
        function setHeartbeatTimer() {
            heartbeatTimer = setTimeout(function() {
                socket.close();
            }, +params.heartbeat);
        }
        setHeartbeatTimer();
        // The client will start to heartbeat on its open event and send the
        // heartbaet event periodically. Then, cancels the timer, sets it up
        // again and sends the heartbeat event as a response.
        socket.on("heartbeat", function() {
            clearTimeout(heartbeatTimer);
            setHeartbeatTimer();
            socket.send("heartbeat");
        });
    }
    return socket;
}