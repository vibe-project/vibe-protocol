/*
 * Vibe Server
 * http://atmosphere.github.io/vibe/projects/vibe-protocol/
 * 
 * Copyright 2014 The Vibe Project 
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
// ---
// 
// **Table of Contents**
// 
// * [Handling HTTP request](#handling-http-request)
//     * [GET](#get)
//     * [POST](#post)
// * [Handling HTTP upgrade](#handling-http-upgrade)
// * [Transport](#transport)
//     * [WebSocket](#websocket)
//     * [HTTP Streaming](#http-streaming)
//     * [HTTP Long Polling](#http-long-polling)
// * [Socket](#socket)
// 
// ---
var events     = require("events"); 
var url        = require("url"); 
var WebSocket  = require("ws");

// This module is exposed to the parent module's `server` as a constructor of
// server.
module.exports = server;

// A server instance to be returned by this function is expected to consume
// exchange of HTTP request and response and WebSocket and produce socket. HTTP
// protocol and WebSocket protocol are standardized in [RFC
// 2616](http://tools.ietf.org/html/rfc2616) and [RFC
// 6455](http://tools.ietf.org/html/rfc6455), respectively.
function server() {
    var sockets = {};
    var server = new events.EventEmitter();
    
    // ## Handling HTTP request
    server.handleRequest = function(req, res) {
        req.params = url.parse(req.url, true).query;
        // Any request must not be cached.
        res.setHeader("cache-control", "no-cache, no-store, must-revalidate");
        res.setHeader("pragma", "no-cache");
        res.setHeader("expires", "0");
        // `streamxdr` or `longpollxdr` transport requires CORS headers even in
        // same-origin connection.
        res.setHeader("access-control-allow-origin", req.headers.origin || "*");
        res.setHeader("access-control-allow-credentials", "true");
        switch (req.method) {
        // ### GET
        // `GET` method is used to establish a channel for the server to push
        // something to the client and manage transports.
        case "GET":
            // `when` param indicates a specific goal of `GET` request.
            switch (req.params.when) {
            // #### open
            // Open a new socket establishing required transport and fires the
            // `socket` event. `transport` param is an id of transport the client uses.
            case "open":
                switch (req.params.transport) {
                case "sse": case "streamxhr": case "streamxdr": case "streamiframe":
                    server.emit("socket", socket(req.params, streamTransport(req, res)));
                    break;
                case "longpollajax": case "longpollxdr": case "longpolljsonp":
                    server.emit("socket", socket(req.params, longpollTransport(req, res)));
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
                    // If there is no corresponding socket, responds with `500
                    // Internal Server Error`.
                    res.statusCode = 500;
                    res.end();
                }
                break;
            // #### abort
            // It means the client considers the socket whose id is `id` param
            // as closed so abort the socket if the server couldn't detect it.
            case "abort": 
                if (req.params.id in sockets) {
                    sockets[req.params.id].close();
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
        // ### POST
        // `POST` method is used to supply HTTP transport with message
        // as a channel for the client to push something to the server.
        case "POST":
            // Reads body to retrieve message. Only text data is allowed now.
            var body = "";
            req.on("data", function(chunk) {
                body += chunk;
            });
            req.on("end", function() {
                // Make JSON string by stripping off leading `data=`.
                var text = body.substring("data=".length);
                // Fires a message event to the socket's transport 
                // whose id is `id` param with the JSON string.
                if (req.params.id in sockets) {
                    sockets[req.params.id].transport.emit("message", text);
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
    };

    // ## Handling HTTP upgrade
    // An HTTP upgrade is used for WebSocket transport.
    var webSocketFactory = new WebSocket.Server({noServer: true});
    server.handleUpgrade = function(req, sock, head) {
        req.params = url.parse(req.url, true).query;
        webSocketFactory.handleUpgrade(req, sock, head, function(ws) {
            // Once a given request is upgraded to WebSocket, open a new socket
            // using it.
            server.emit("socket", socket(req.params, wsTransport(ws)));
        });
    };
    
    // ## Transport
    // A transport is used to establish a persistent connection, send data, receive
    // data and close the connection and is expected to be private for user not
    // to access.
    
    // ### WebSocket
    // Covers `ws`.
    // WebSocket is a protocol designed for a full-duplex communications over a
    // TCP connection. However, it's not always available for various reason.
    function wsTransport(ws) {
        // It delegates WebSocket's events to transport and transport's
        // behaviors to WebSocket.
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
    }
    
    // ### HTTP Streaming
    // Covers `sse`, `streamxhr`, `streamxdr`, `streamiframe`.
    // HTTP Streaming is the way that the client performs a HTTP persistent
    // connection and watches changes in response text and the server prints
    // chunk as data to the connection.
    // 
    // `sse` stands for [Server-Sent Events](http://www.w3.org/TR/eventsource/)
    // specified by W3C.
    function streamTransport(req, res) {
        var text2KB = Array(2048).join(" ");
        var transport = new events.EventEmitter();
        
        // #### Handling HTTP exchange
        // The content-type headers should be `text/event-stream` for `sse` and
        // `text/plain` for others. Also the response should be encoded in
        // `utf-8` format for `sse`.
        res.setHeader("content-type", "text/" + 
            (req.params.transport === "sse" ? "event-stream" : "plain") + "; charset=utf-8");
    
        // The padding is required, which makes the client-side transport be aware
        // of change of the response and the client-side socket fire open event.
        // It should be greater than 1KB, be composed of white space character and 
        // end with `\r`, `\n` or `\r\n`. It applies to `streamxdr`, `streamiframe`.
        res.write(text2KB + "\n");
    
        // When either client or server closes the transport, fires a close event.
        function onclose() {
            if (onclose.done) {
                return;
            }
            onclose.done = true;
            transport.emit("close");
        }
        res.on("close", onclose);
        res.on("finish", onclose);
        
        // #### Sending data
        // The response text should be formatted in the [event stream
        // format](http://www.w3.org/TR/eventsource/#parsing-an-event-stream).
        // This is specified in `sse` spec but the rest also accept that format
        // for convenience. According to the format, data should be broken up by
        // `\r`, `\n`, or `\r\n` but because data is JSON, it's not needed. So
        // prepend 'data: ' and append `\n\n` to the data.
        transport.send = function(data) {
            res.write("data: " + data + "\n\n");
        };
        // #### Closing the transport
        // Ends the response. Accordingly, `onclose` will be executed and the close
        // event will be fired. Don't do that by yourself.
        transport.close = function() {
            res.end();
        };
        return transport;
    }
    
    // ### HTTP Long polling
    // Covers `longpollajax`, `longpollxdr`, `longpolljsonp`.
    // HTTP Long Polling is the way that the client performs a HTTP persistent
    // connection and the server ends the connection with data. Then, the client
    // receives it and performs a request again and again.
    function longpollTransport(req, res) {
        // Current holding response.
        var response;
        // Whether the transport is aborted or not.
        var aborted;
        // Whether the current response has ended or not.
        var ended;
        // Whether data is written on the current response or not.
        // if this is true, then `ended` is also true but not vice versa.
        var written;
        // A timer to prevent from being idle connection.
        var closeTimer;
        // The parameters of the first request. That of subsequent requests are not used.
        var params = req.params;
        // A queue containing events that the client couldn't receive.
        var queue = [];
        var transport = new events.EventEmitter();
    
        // #### Refreshing HTTP exchange
        // In long polling, an exchange of request and response is disposable
        // so expose this method to supply with subsequent exchanges.
        transport.refresh = function(req, res) {
            // The content-type header should be `text/javascript` for `longpolljsonp`
            // and `text/plain` for the others.
            res.setHeader("content-type", "text/" + 
                (params.transport === "longpolljsonp" ? "javascript" : "plain") + "; charset=utf-8");
            
            // When either client or server closes the current exchange,
            function onclose() {
                if (onclose.done) {
                    return;
                }
                onclose.done = true;
                // The current exchange's life ends but this has nothing to do with
                // `written`.
                ended = true;
                // If the request is to `poll` and the server didn't write anything,
                // completion of this response is the end of the transport.
                // Hence, fires the close event.
                if (req.params.when === "poll" && !written) {
                  transport.emit("close");
                // Otherwise client will issue `poll` request again so it sets 
                // a timer to fire close event to prevent this connection from 
                // remaining in limbo. 2s is enough.
                } else {
                    closeTimer = setTimeout(function() {
                        transport.emit("close");
                    }, 2000);
                }
            }
            res.on("close", onclose);
            res.on("finish", onclose);
            
            // ##### Request to open
            // If the request is to `open`, end the response. The purpose of this is
            // to tell the client that the server is alive. Therefore, the client
            // will fire the open event.
            if (req.params.when === "open") {
                res.end();
            // ##### Request to poll
            // If the request is to `poll`, remove the client-received data from queue 
            // and flush the rest in queue if they exist.
            } else {
                // Resets the response, flags, timers as new exchange is supplied.
                response = res;
                ended = written = false;
                clearTimeout(closeTimer);
                // If aborted is true, it means the user aborted the connection but
                // it couldn't be done because the current response is already
                // ended for other reason. So end the new exchange.
                if (aborted) {
                    res.end();
                    return;
                }
                // Removes client-received events from the queue. `lastEventIds` param 
                // is a comma-separated values of id of client-received events.
                // FYI, `a.splice(b, 1)` in JavaScript is equal to `a.remove(b)`.
                if (req.params.lastEventIds) {
                    req.params.lastEventIds.split(",").forEach(function(lastEventId) {
                        queue.forEach(function(data) {
                            if (lastEventId === /"id":"([^\"]+)"/.exec(data)[1]) {
                                queue.splice(queue.indexOf(data), 1);
                            }
                        });
                    });
                }
                // If cached data remain in the queue, it indicates the client
                // couldn't receive them. So flushes them in the form of
                // JSON array. This is not the same with `JSON.stringify(queue)`
                // because elements in queue are already JSON string.
                if (queue.length) {
                    transport.send("[" + queue.join(",") + "]", true);
                }
            }
        };
        // Refreshes with the first exchange.
        transport.refresh(req, res);
        // #### Sending data
        transport.send = function(data, fromQueue) {
            // If data is not from the queue, caches it.
            if (!fromQueue) {
                queue.push(data);
            }
            // Only when the current response is not ended it's possible to send.
            // If it is ended, the cached data will be sent in next poll through
            // `refresh` method.
            if (!ended) {
                // Flags the current response is written.
                written = true;
                // In case of `longpolljsonp`, the response text is supposed to be a
                // JavaScript code executing a callback with data. The callback name
                // is passed as the first request's `callback` param and the data to
                // be returned have to be escaped to a JavaScript string literal.
                // For others, no formatting is needed. All the long polling
                // transports has to finish the request after processing. The
                // `onclose` will be executed after this.
                response.end(params.transport === "longpolljsonp" ? 
                    params.callback + "(" + JSON.stringify(data) + ");" : data);
            }
        };
        // #### Closing the transport
        transport.close = function() {
            // Marks the transport is aborted.
            aborted = true;
            // Ends response if possible. If it's not possible, a next poll request
            // will be ended immediately by `aborted` flag so it will fire the close
            // event. So you don't need to manually dispatch the close event here.
            if (!ended) {
                response.end();
            }
        };        
        return transport;
    }
    
    // ## Socket
    // A socket is an interface to exchange event between the two endpoints and
    // expected to be public for developers to create vibe application. The event
    // is serialized to and deseriazlied from JSON specified in
    // [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf).
    function socket(params, transport) {
        var socket = new events.EventEmitter();
        
        // Assigns an id that is UUID generated by client.
        socket.id = params.id;
        // I don't recommend to expose transport but it's needed here for HTTP
        // transports.
        socket.transport = transport;
        // On the transport's close event, removes the socket from the
        // repository to make it have only opened sockets and fires the close
        // event.
        transport.on("close", function() {
            delete sockets[socket.id];
            socket.emit("close");
        });
        // ### Receiving an event
        // When the underlying transport has received a message from the client.
        transport.on("message", function(text) {
            // Converts JSON to an event object.
            // 
            // #### An event sent by the client
            // It should have the following properties:
            // * `id: string`: an event identifier.
            // * `type: string`: an event type.
            // * `data: any`: an event data.
            // 
            // If the server implements `receiving replyable event` extension, the
            // following properties should be considered as well.
            // * `reply: boolean`: true if this event requires the reply.
            var event = JSON.parse(text);
            // If the client sends a plain event not replyable event, dispatch it.
            if (!event.reply) {
                socket.emit(event.type, event.data);
            // This is how to implement `receiving replyable event` extension. 
            // An event handler for the corresponding event will receive reply 
            // controller as 2nd argument. It calls the client's resolved or 
            // rejected callback by sending `reply` event.
            } else {
                // The latch prevents double reply.
                var latch;
                socket.emit(event.type, event.data, {
                    resolve: function(value) {
                        if (!latch) {
                            latch = true;
                            socket.send("reply", {id: event.id, data: value, exception: false});
                        }
                    },
                    reject: function(reason) {
                        if (!latch) {
                            latch = true;
                            socket.send("reply", {id: event.id, data: reason, exception: true});
                        }
                    }
                });
            }
        });
        // ### Sending an event
        // An auto-increment id for event. In case of long polling, these ids are
        // echoed back as a query string to the URL in GET. To avoid `414
        // Request-URI Too Long` error, though it is not that important, it
        // would be better to use small sized id.
        var eventId = 0;
        // A map for reply callbacks for `sending replyable event` extension.
        var callbacks = {};
        socket.send = function(type, data, resolved, rejected) {
            // #### An event to be sent to the client
            // It should have the following properties:
            // * `id: string`: an event identifier.
            // * `type: string`: an event type.
            // * `data: any`: an event data.
            // 
            // If the server implements `sending replyable event` extension, the
            // following properties should be available as well.
            // * `reply: boolean`: true if this event requires the reply.
            var event = {
                id: "" + eventId++, 
                type: type, 
                data: data, 
                reply: resolved != null || rejected != null
            };
            
            // For `sending replyable event` extension, stores resolved and rejected
            // callbacks if they are given.
            if (event.reply) {
                callbacks[event.id] = {resolved: resolved, rejected: rejected};
            }
            // Convert the event to JSON and sends it through the transport.
            transport.send(JSON.stringify(event));
        };
        // For `sending replyable event` extension, on the reply
        // event, executes the stored reply callbacks with data.
        socket.on("reply", function(reply) {
            if (reply.id in callbacks) {
                var cbs = callbacks[reply.id];
                var fn = reply.exception ? cbs.rejected : cbs.resolved;
                if (fn) {
                    fn.call(this, reply.data);
                }
                delete callbacks[reply.id];
            }
        });
        // ### Closing the socket
        // By closing the transport.
        socket.close = function() {
            transport.close();
        };
        // ### Supporting heartbeat
        // If `heartbeat` param is not `false` and is a number, prepares 
        // the heartbeat handshakes. FYI `+"false"` gives `NaN` equal to `false` 
        // and `+"5000"` gives `5000` equal to `true` in JavaScript.
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
            })
            // To prevent a side effect of the timer, clears it on the close event.
            .on("close", function() {
                clearTimeout(heartbeatTimer);
            });
        }
        // Finally registers the newly created socket to the repository,
        // `sockets`, by id.
        sockets[socket.id] = socket;
        return socket;
    }
    
    return server;
}