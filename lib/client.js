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
var crypto      = require("crypto");
var WebSocket   = require("ws");
var http        = require("http");
var EventSource = require("eventsource");

http.globalAgent.maxSockets = Infinity;

// This module is exposed to the parent module's `client` as a constructor of
// client.
module.exports = client;

// A client instance to be returned by this function is a factory to create
// socket to connect to the server. It is expected to use HTTP and WebSocket
// client implementation that are standardized in [RFC
// 2616](http://tools.ietf.org/html/rfc2616) and [RFC
// 6455](http://tools.ietf.org/html/rfc6455), respectively.
function client() {
    var client = {};
    client.open = function(uri, options) {
        return socket(uri, options);
    };
    return client;
}

// An URI specified in [RFC 3986](http://tools.ietf.org/html/rfc3986) is the
// complete path to the vibe server endpoint. The protocol uses only the query
// string to pass information to interact with the server so be aware of
// reserved parameters.
// 
// The followings parameters are always included to the query string:
// * `id`: a socket id in the form of UUID.
// * `_`: a random string for anti-caching.
// 
// Additionally if the method is `GET`, the followings are attached as well.  
// * `when`: a goal of request.
//
// The `when` can be one of the followings and according to that value,
// additional params are attached to query string.
// * `open`: to establish a connection.
//   * `transport`: a transport id being used. It can be one of the followings:
//    * `ws`: WebSocket.
//    * `sse`: Server-Sent Events.
//    * `streamxhr`: XMLHttpRequest Streaming.
//    * `streamxdr`: XDomainRequest Streaming. 
//    * `streamiframe`: Hidden Iframe Streaming. 
//    * `longpollajax`: AJAX Long Polling. 
//    * `longpollxdr`: XDomainRequest Long Polling. 
//    * `longpolljsonp`: JSONP Long Polling. 
//   * `callback`: a callback name used in `longpolljsonp` transport.
// * `poll`: to supply long polling transport with a new HTTP exchange.
//   * `lastEventIds`: a comma-separated value of an id of the client-received 
// events in the preceding response.
// * `abort`: to notify the server of disconnection of HTTP transports.
function buildURI(uri, params) {
    var urlObj = url.parse(uri, true);
    urlObj.query = urlObj.query || {};
    urlObj.query.id = params.id;
    urlObj.query._ = crypto.randomBytes(3).toString("hex");
    
    if (params.when) {
        urlObj.query.when = params.when;
        switch (params.when) {
        case "open":
            urlObj.query.transport = params.transport;
            if (params.callback) {
                urlObj.query.callback = params.callback;
            }
            break;
        case "poll":
            urlObj.query.lastEventIds = params.lastEventIds;
            break;
        }
    }
    
    delete urlObj.search;
    return url.format(urlObj);
}

// A socket is an interface to exchange event between the two endpoints and
// expected to be public for developers to create vibe application. The event
// is serialized to and deseriazlied from JSON specified in
// [ECMA-404](http://www.ecma-international.org/publications/files/ECMA-ST/ECMA-404.pdf).
function socket(uri, options) {
    var socket = new events.EventEmitter();
    var transport;

    // Most options to establish a connection come from handshaking.
    options = options || {};

    // Perform a handshake request to negotiate the protocol
    http.get(buildURI(uri, {when: "handshake"}))
    // If any error is encountered, fires the `close` event.
    .on("error", function() {
        socket.emit("close");
    })
    .on("response", function(res) {
        var body = "";
        res.on("data", function(chunk) {
            body += chunk;
        });
        res.on("end", function() {
            // The result of handshaking is a form of JSON and contains
            // information to establish a connection.
            var result = JSON.parse(body);
            // A newly issued id for this socket.
            socket.id = result.id;
            // `transport` a user assigned explicitly is prioritized than the
            // result of handshaking, but it's usually for testing so not
            // desired.
            if (!options.transport) {
                // Picks out the supported ones by this client.
                var candidates = result.transports.filter(function(name) {
                    return name in transports;
                });
                // If nothing is available, it's not possible to connect to the
                // server. Fire the `close` event.
                if (candidates.length === 0) {
                    socket.emit("close");
                    return;
                }
                // Choose the first one among transport both client and server
                // support.
                options.transport = candidates[0];
            }
            // `heartbeat` and `_heartbeat` should be set through only
            // handshaking. However, `_heartbeat` is usually for testing so it
            // may be not passed from the server. The default value is `5000`.
            options.heartbeat = result.heartbeat;
            options._heartbeat = result._heartbeat || 5000;
            // According to the transport option, create the transport and
            // connect to the server.
            transport = transports[options.transport](uri, {id: socket.id});
            // For testing, assigns a real uri used in establishing a connection
            // to socket
            socket.uri = transport.uri;
            // Delegates transport's `open` and `close` events to socket.
            transport.on("open", function() {
                socket.emit("open");
            });
            transport.on("close", function() {
                socket.emit("close");
            });
            // When the underlying transport has received a message from the
            // server.
            transport.on("message", function(text) {
                // Converts JSON to an event object.
                // 
                // It should have the following properties:
                // * `id: string`: an event identifier.
                // * `type: string`: an event type.
                // * `data: any`: an event data.
                // 
                // If the client implements `reply` extension, the following
                // properties should be considered as well.
                // * `reply: boolean`: true if this event requires the reply.
                var event = JSON.parse(text);
                // If the server sends a plain event, dispatch it.
                if (!event.reply) {
                    socket.emit(event.type, event.data);
                // This is how to implement `reply` extension. An event handler
                // for the corresponding event will receive reply controller as
                // 2nd argument. It calls the server's resolved or rejected
                // callback by sending `reply` event.
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
        });
    });
    
    // An id for event. It should be unique among events to be sent to the
    // server and has nothing to do with one the server sent.
    var eventId = 0;
    // A map for reply callbacks for `reply` extension.
    var callbacks = {};
    socket.send = function(type, data, resolved, rejected) {
        // It should have the following properties:
        // * `id: string`: an event identifier.
        // * `type: string`: an event type.
        // * `data: any`: an event data.
        // 
        // If the client implements `reply` extension, the following properties
        // should be available as well.
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
        // Convert the event to JSON and sends it through the transport.
        transport.send(JSON.stringify(event));
    };
    // For `reply` extension, on the `reply` event, executes the stored reply
    // callbacks with data.
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
    socket.close = function() {
        // If a user closes a socket before finishing handshaking, the transport
        // would be `null`. Then, fire the `close` event. If not, the transport
        // will fire the `close` event and it will propagate to this socket.
        if (transport) {
            transport.close();
        } else {
            socket.emit("close");
        }
    };
    // Starts the heartbeat handshakes on `open` event.
    socket.on("open", function() {
        var heartbeatTimer;
        function setHeartbeatTimer() {
            // Sets a timer to send an `heartbeat` event after
            // `heartbeat - _heartbeat` miliseconds.
            heartbeatTimer = setTimeout(function() {
                socket.send("heartbeat");
                // Sets a timer to close the socket if the server doesn't
                // respond in the `_heartbeat` interval.
                heartbeatTimer = setTimeout(function() {
                    socket.close();
                }, options._heartbeat);
            }, options.heartbeat - options._heartbeat);
        }
        // If the server echoes back the sent `heartbeat` event, clears the
        // timer and set it again.
        socket.on("heartbeat", function() {
            clearTimeout(heartbeatTimer);
            setHeartbeatTimer();
        });
        // The heartbeat handshake should be stopped on `close` event.
        socket.on("close", function() {
            clearTimeout(heartbeatTimer);
        });
        // Starts the heartbeat.
        setHeartbeatTimer();
    });
    return socket;
}

// A transport is used to establish a persistent connection, send data, receive
// data and close the connection and is expected to be private for user not to
// access.
var transports = {};

// WebSocket is a protocol designed for a full-duplex communications over a TCP
// connection. However, it's not always available for various reason.
transports.ws = function(uri, params) {
    // Builds an URI to open changing the protocol from http to ws and connects
    // to the server over WebSocket protocol.
    var u = buildURI(uri, {id: params.id, when: "open", transport: "ws"}).replace(/^http/, "ws");
    var ws = new WebSocket(u);
    var transport = new events.EventEmitter();
    transport.uri = u;
    // Simply delegates WebSocket's events to transport and transport's
    // behaviors to WebSocket.
    ws.onopen = function() {
        transport.emit("open");
    };
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

// A base transport for the following HTTP transports.
// * **HTTP Streaming**: the client performs a HTTP persistent
// connection and watches changes in response text and the server prints chunk
// as data to the connection.
// * ** HTTP Long Polling**: the client performs a HTTP persistent connection
// and the server ends the connection with data. Then, the client receives it
// and performs a request again and again.
transports.httpbase = function(uri, params) {
    var transport = new events.EventEmitter();
    // A persistent connection established by transport over HTTP protocol is
    // only for the server to send something to the client. For the client to
    // send something to the server, issues a request through `POST` method.
    // And its content type header should be `text/plain; charset=utf-8` and the
    // final data should be prefixed with `data=`.
    transport.send = function(data) {
        var reqOpts = url.parse(buildURI(uri, {id: params.id}));
        reqOpts.method = "POST";
        reqOpts.headers = {"content-type": "text/plain; charset=utf-8"};
        http.request(reqOpts).end("data=" + data);
    };
    transport.close = function() {
        // Aborts the real connection. It should be implemented by others.
        transport.abort();
        // Some servers can't detect disconnection. To prevent idle connections,
        // notifies the server of disconnection of this connection.
        http.get(buildURI(uri, {id: params.id, when: "abort"}));
    };
    return transport;
};

// The [Server-Sent Events](http://www.w3.org/TR/eventsource/)
// specified by W3C is yet another HTTP streaming technique.
transports.sse = function(uri, params) {
    // Builds an URI to open and connects to the server over HTTP protocol.
    // EventSource uses `GET` method.
    var u = buildURI(uri, {id: params.id, when: "open", transport: "sse"});
    var es = new EventSource(u);
    var transport = transports.httpbase(uri, params);
    transport.uri = u;
    // Simply delegates EventSource's events to transport and transport's
    // behaviors to EventSource.
    es.onopen = function(event) {
        transport.emit("open");
    };
    es.onmessage = function(event) {
        transport.emit("message", event.data);
    };
    es.onerror = function(event) {
        es.close();
        transport.emit("close");
    };
    transport.abort = function() {
        // Closes the EventSource.
        es.close();
        // EventSource doesn't notify of disconnection. Therefore fires the
        // `close` event immediately.
        transport.emit("close");
    };
    return transport;
};

// Their difference is which host object initiates and progresses a connection
// in browser. Therefore, client not running on browser like Java
// client don't have to implement them. (If there is no reliable `sse`
// implementation, you can implement `streamxhr` using a plain HTTP client)
["streamxhr", "streamxdr", "streamiframe"].forEach(function(tpName) {
    transports[tpName] = function(uri, params) {
        var req;
        var transport = transports.httpbase(uri, params);
        
        // Performs a persistent HTTP connection via `GET` method.
        var u = buildURI(uri, {id: params.id, when: "open", transport: tpName});
        transport.uri = u;
        req = http.get(u)
        // If any error is encountered, fires the `close` event.
        .on("error", function() {
            transport.emit("close");
        })
        // Technically the `open` event should be fired by the first chunk,
        // padding, but non-browser client doesn't need to do that because
        // it can detect when the response headers have been received.
        .on("response", function(res) {
            transport.emit("open");
            // Every chunk may be a single event, multiple events or a fragment
            // of a single event. This buffer helps handle fragments.
            var buffer = "";
            // Chunks are formatted according to the [event stream
            // format](http://www.w3.org/TR/eventsource/#event-stream-interpretation).
            // However, you don't need to know that. A single event starts with
            // 'data: ' and ends with `\n\n`. That's all you need to know.
            res.on("data", function(chunk) {
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
                var i;
                var lines = (buffer + chunk).split("\n\n");
                // Lines except the last consist of a complete data starting 
                // with 'data: ' Unwraps 'data: ' and fires a message event.
                for (i = 0; i < lines.length - 1; i++) {
                    transport.emit("message", lines[i].substring("data: ".length));
                }
                // The last element is a fragment of a data. Assigns it to
                // buffer.
                buffer = lines[lines.length - 1];
            })
            .on("end", function() {
                transport.emit("close");
            });
        });
        transport.abort = function() {
            // Aborts the current request. The rest of work, firing the `close`
            // event, will be done by `end` event handler.
            req.abort();
        };
        return transport;
    };
});

// Their difference is which host object initiates and progresses a connection
// in browser. Therefore, client not running on browser like Java client don't
// have to implement `longpollxdr`.
["longpollajax", "longpollxdr"].forEach(function(tpName) {
    // In long polling, a pseudo-connection consisting of disposable HTTP 
    // exchanges pretends to be a persistent connection.
    transports[tpName] = function(uri, params) {
        // The current holding request.
        var req;
        var transport = transports.httpbase(uri, params);
        // The first request is to open and subsequent requests are to poll. 
        // All they use `GET` method.
        var u = buildURI(uri, {id: params.id, when: "open", transport: tpName});
        transport.uri = u;
        req = http.get(u)
        // If any error is encountered during the request, that means the
        // server is not available. So fires the `close` event.
        .on("error", function() {
            transport.emit("close");
        })
        // If the first request is completed normally since the server is 
        // available, start to poll and fire the open event. There must be 
        // no idle time between the poll. Starting poll request is always
        // prior to dispatching events.
        .on("response", function() {
            // For the first time, starts with empty array.
            poll([]);
            // The poll request is just started so fires the `open` event.
            transport.emit("open");
            // From the second request, `when` is `poll` and `lastEventIds`
            // is needed that is comma-separated values of event ids in the 
            // preceding request's response.
            function poll(lastEventIds) {
                // FYI, `["x", "y", "z"].join(",")` gives `"x,y,z"`.
                req = http.get(buildURI(uri, {id: params.id, when: "poll", lastEventIds: lastEventIds.join(",")}))
                .on("error", function() {
                    transport.emit("close");
                })
                // If the server responds to this request, determine whether 
                // the intention of response is to send event or to close by 
                // reading body.
                .on("response", function(res) {
                    var body = "";
                    res.on("data", function(chunk) {
                        body += chunk;
                    });
                    res.on("end", function() {
                        if (body) {
                            // To prepare the next request, identify events in 
                            // the response and collect their ids.
                            var eventIds = [];
                            var obj = JSON.parse(body);
                            // If the parsed object is an array, it contains 
                            // events that the client couldn't receive before, 
                            // which may happen within only long polling. FYI,
                            // `[{id:1},{id:2},{id:3}].map(function(e) {return
                            // e.id;})` gives `[1,2,3]`.
                            if (Array.isArray(obj)) {
                                eventIds = obj.map(function(event) {
                                     return event.id;
                                });
                            // Otherwise, it's a single event.
                            } else {
                                eventIds = [obj.id];
                            }
                            // Sends a poll request again before to fire events.
                            // Again this order is important.
                            poll(eventIds);
                            // Fires those event one by one. A transport is 
                            // supposed to receive a single stringified event.
                            if (Array.isArray(obj)) {
                                obj.forEach(function(event) {
                                     transport.emit("message", JSON.stringify(event));
                                });
                            } else {
                                transport.emit("message", body);
                            }
                        // Absent body indicates the server closed the socket.
                        // Accordingly fires the `close` event.
                        } else {
                            transport.emit("close");
                        }
                    });
                });
            }
        });
        // Aborts the current request. The rest of work, firing the close
        // event, will be done by `error` event handler.
        transport.abort = function() {
            req.abort();
        };
        return transport;
    };
});

// Except request's callback param, response's content-type header and how to
// parse its body, `longpolljsonp` and `longpollajax` are all the same.
transports.longpolljsonp = function(uri, params) {
    var req;
    var transport = transports.httpbase(uri, params);
    // Adds the callback param. In browser response body can't be controlled so
    // it should be unique in the document.
    var u = buildURI(uri, {id: params.id, when: "open", transport: "longpolljsonp", callback: "dayoff"});
    transport.uri = u
    req = http.get(u)
    .on("error", function() {
        transport.emit("close");
    })
    .on("response", function() {
        poll([]);
        transport.emit("open");
        function poll(lastEventIds) {
            req = http.get(buildURI(uri, {id: params.id, when: "poll", lastEventIds: lastEventIds.join(",")}))
            .on("error", function() {
                transport.emit("close");
            })
            .on("response", function(res) {
                var body = "";
                res.on("data", function(chunk) {
                    body += chunk;
                });
                res.on("end", function() {
                    if (body) {
                        // The returned body is a JavaScript code executing 
                        // the callback with data. In browser, it will be 
                        // executed immediately. Here we can manipulate the 
                        // body so retrieve the real data by stripping 
                        // function call experession and unescpaing it as JSON.
                        body = JSON.parse(body.match(/^dayoff\((.*)\);$/)[1]);
                        var eventIds = [];
                        var obj = JSON.parse(body);
                        if (Array.isArray(obj)) {
                            eventIds = obj.map(function(event) {
                                return event.id;
                            });
                        } else {
                            eventIds = [obj.id];
                        }
                        poll(eventIds);
                        if (Array.isArray(obj)) {
                            obj.forEach(function(event) {
                                transport.emit("message", JSON.stringify(event));
                            });
                        } else {
                            transport.emit("message", body);
                        }
                    } else {
                        transport.emit("close");
                    }
                });
            });
        }
    });
    transport.abort = function() {
        req.abort();
    };
    return transport;
};