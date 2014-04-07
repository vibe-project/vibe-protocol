//     Client 3.0.0.Alpha1-SNAPSHOT
//     http://atmosphere.github.io/react/protocol/
// 
//     Copyright 2014-2014, Donghwan Kim 
//     Licensed under the Apache License, Version 2.0
//     http://www.apache.org/licenses/LICENSE-2.0

// This is the client-side reference implementation of the 
// [React protocol](http://atmosphere.github.io/react/protocol/) written in
// easy-to-read JavaScript running on Node.js.
// 
// **Note**
// * For production use, see the [React JavaScript Client](http://atmosphere.github.io/react/javascript-client/).
// * Transports running only on browser are not implemented.
// 

var events      = require("events"),
    url         = require("url"), 
    uuid        = require("node-uuid"),
    crypto      = require("crypto"),
    WebSocket   = require("ws"),
    http        = require("http"),
    EventSource = require("eventsource");

http.globalAgent.maxSockets = Infinity;

// ## Exports
// ### open
// Opens a new socket and returns it. The react client works as standalone.
//
//     var client = require("../lib/client"),
//         socket = client.open("http://localhost:8080/react", {
//             transport: "ws"
//         });
// 
//     socket.on("open", function() {
//       socket.send("greetings", "Hi");
//     });
exports.open = socket;

// ## URI
// An URI is the complete path to the react server endpoint. The protocol uses
// the query string to pass information to interact with the server in `GET`
// request so be aware of reserved parameters.
// 
// ### Params
// The followings are always included to the query string:
// * `id`: a socket id in the form of UUID.
// * `when`: a goal of request.
// * `_`: a random string for anti-caching.
//
// The `when` can be one of the followings and according to that value,
// additional params are attached to query string.
// * `open`: to establish a connection.
//   * `transport`: a transport id being used. It can be one of the followings:
//     * `ws`: WebSocket.
//     * `sse`: Server-Sent Events.
//     * `streamxhr`: XMLHttpRequest Streaming.
//     * `streamxdr`: XDomainRequest Streaming. 
//     * `streamiframe`: Hidden Iframe Streaming. 
//     * `longpollajax`: AJAX Long Polling. 
//     * `longpollxdr`: XDomainRequest Long Polling. 
//     * `longpolljsonp`: JSONP Long Polling. 
//   * `heartbeat`: a heartbeat interval value in milliseconds. It have to be larger than `5000`.
//     * `20000`: a recommended value.
//     * `false`: no heartbeat.
//   * `callback`: a callback name used in `longpolljsonp` transport.
// * `poll`: to supply long polling transport with a new HTTP exchange.
//   * `lastEventIds`: a comma-separated value of an id of the client-received 
// events in the preceding response.
// * `abort`: to notify the server of disconnection of HTTP transports.
function uri(uri, params) {
    var urlObj = url.parse(uri, true);
    urlObj.query = urlObj.query || {};
    
    urlObj.query.id = params.id;
    urlObj.query.when = params.when;
    urlObj.query._ = crypto.randomBytes(3).toString("hex");
    
    switch (params.when) {
    case "open":
        urlObj.query.transport = params.transport;
        urlObj.query.heartbeat = params.heartbeat;
        if (params.callback) {
            urlObj.query.callback = params.callback;
        }
        break;
    case "poll":
        urlObj.query.lastEventIds = params.lastEventIds;
        break;
    case "abort":
        break;
    default:
        return;
    }
    
    delete urlObj.search;
    return url.format(urlObj);
}

// ## Socket
// A socket is a connectivity between the two react endpoints and an interface
// for developers creating react applications.
//
// **Options**
// * `transport:string`: a transport id.
// * `heartbeat:number`: a heartbeat interval value in milliseconds.
//  
// **Events**
// * `open()`: when the socket has been opened.
// * `close()`: when the socket has been closed.
// * Any event can be used and exchanged unless their name is `open`, `close`, 
// `reply` or `heartbeat` and can have `data:any` as a first arg and 
// `reply:reply` to handle the client's callback as a second arg.
//
// **Methods**
// * `send(event: string)`: sends an event.
// * `send(event: string, data: any)`: sends an event with data.
// * `send(event: string, data: any, resolved: function(arg: any), 
// rejected: function(arg: any))`: sends an event with data attaching 
// resolved and rejected callbacks to be called by the server.
// * `close()`: closes the socket.
function socket(u, options) {
    var socket = new events.EventEmitter();
    
    // Set default options
    options.heartbeat = options.heartbeat || false;
    options._heartbeat = options._heartbeat || 5000;
    
    // ### id
    // Generate an UUID as an identifier of this socket. It should be
    // universally unique literally.
    socket.id = uuid.v4();
    
    // ### Handling transport
    // The transport attempts to connect to the server.
    var params = {id: socket.id, transport: options.transport, heartbeat: options.heartbeat},
        transport = transports[options.transport](u, params);
    
    // Delegates transport's `open` and `close` events to socket.
    transport.on("open", function() {
        socket.emit("open");
    });
    transport.on("close", function() {
        socket.emit("close");
    });
    // Fires an event if the underlying transport has received a message 
    // from the server.
    transport.on("message", function(text) {
        // The latch prevents double reply.
        var latch,
            // Converts JSON text to an event object.
            event = JSON.parse(text);
        // #### An event sent by the server
        // It should have the following properties:
        // * `id: string`: an event identifier.
        // * `type: string`: an event type.
        // * `data: any`: an event data.
        // * `reply: boolean`: true if this event requires the reply.
        socket.emit(event.type, event.data, !event.reply ? null : {
            // Calls the server's resolved callback whose event id is `event.id` with `value`.
            resolve: function(value) {
                if (!latch) {
                    latch = true;
                    socket.send("reply", {id: event.id, data: value, exception: false});
                }
            },
            // Calls the server's rejected callback whose event id is `event.id` with `reason`.
            reject: function(reason) {
                if (!latch) {
                    latch = true;
                    socket.send("reply", {id: event.id, data: reason, exception: true});
                }
            }
        });
    });
    // A map for reply callbacks to be handled by the client.
    var callbacks = {};
    // ### send
    socket.send = function(type, data, resolved, rejected) {
        // #### An event to be sent to the server
        // It should have the following properties:
        // * `id: string`: an event identifier.
        // * `type: string`: an event type.
        // * `data: any`: an event data.
        // * `reply: boolean`: true if this event requires the reply.
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
        transport.send(JSON.stringify(event));
    };
    // ### close
    // By closing the transport.
    socket.close = function() {
        transport.close();
    };
    // ### reply
    // If the server sends the reply event, executes the stored reply
    // callbacks with data and deletes it.
    socket.on("reply", function(reply) {
        if (reply.id in callbacks) {
            var cbs = callbacks[reply.id],
                fn = reply.exception ? cbs.rejected : cbs.resolved;
            if (fn) {
                fn.call(this, reply.data);
            }
            delete callbacks[reply.id];
        }
    });
    // ### heartbeat
    // If `heartbeat` option is not `false` and is a number, starts
    // the heartbeat handshakes on `open` event. 
    socket.on("open", function() {
        // The option `_heartbeat` is just to speed up heartbeat test and do not
        // provide such option for production use. It means the time to wait
        // for the server's response. The default value is `5000`.
        if (options.heartbeat > options._heartbeat) {
            var heartbeatTimer;
            function setHeartbeatTimer() {
                // Sets a timer to send an heartbeat event after
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
            // If the server echoes back the sent heartbeat event, clear the timer
            // and set it again.
            socket.on("heartbeat", function() {
                clearTimeout(heartbeatTimer);
                setHeartbeatTimer();
            });
            // The heartbeat handshake should be stopped on close event.
            socket.on("close", function() {
                clearTimeout(heartbeatTimer);
            });
            // Starts the heartbeat.
            setHeartbeatTimer();
        }
    });
    
    return socket;
}

// ## Transport
// A transport hides internal techniques and policies for Comet 
// or WebSocket and provides a simple view of frame-based connection.
//
// **Events**
// * `open()`: when the transport has been opened. 
// * `close()`: when the transport has been closed. 
// * `message(data: string)`: when the transport has received data. 
// 
// **Methods**
// * `send(data: string)`: sends data.
// * `close()`: closes the transport.
var transports = {};

// ### WebSocket
// `ws`.
transports.ws = function(u, params) {
    // Builds an URI to open changing the protocol from http to ws and connects
    // to the server over WebSocket protocol.
    var ws = new WebSocket(uri(u, {id: params.id, when: "open", transport: "ws", heartbeat: params.heartbeat}).replace(/^http/, "ws")),
        transport = new events.EventEmitter();
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

// ### HTTP base
// A base transport for HTTP transports.
transports.httpbase = function(u, params) {
    var transport = new events.EventEmitter();
    // #### send
     // A persistent connection established by transport over HTTP protocol is
     // only for the server to send something to the client. For the client to
     // send something to the server, use a plain HTTP client.
    transport.send = function(data) {
        // Final data is prefixed with `data=`.
        data = "data=" + data;
        var urlObj = url.parse(u, true);
        urlObj.query = urlObj.query || {};
        // Adds a `id` param indicating this socket's id.
        urlObj.query.id = params.id;
        var reqOpts = url.parse(url.format(urlObj));
        // This channel should use `POST` method.
        reqOpts.method = "POST";
        // Writes data with `utf-8` encoding. It is default
        // one in Node.js wisely.
        http.request(reqOpts).end(data);
    };
    // #### close
    transport.close = function() {
        // Aborts the real connection. It should be implemented by others.
        transport.abort();
        // Notifies the server of disconnection of this connection.
        http.get(url.parse(uri(u, {id: params.id, when: "abort"})));
    };
    return transport;
};

// ### Streaming by Server-Sent Events
// `sse`.
// 
// The server-sent events introduced in HTML5 is just yet another HTTP streaming
// technique.
transports.sse = function(u, params) {
    // Builds an URI to open and connects to the server over HTTP protocol.
    // EventSource uses `GET` method.
    var es = new EventSource(uri(u, {id: params.id, when: "open", transport: "sse", heartbeat: params.heartbeat})),
        transport = transports.httpbase(u, params);
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
    // #### abort
    transport.abort = function() {
        // By aborting the EventSource.
        es.close();
        // EventSource doesn't notify of disconnection. So fires the
        // closes event immediately.
        transport.emit("close");
    };
    return transport;
};

// ### Streaming by XMLHttpRequest, XDomainRequest or Hidden iframe
// `streamxhr`, `streamxdr` and `streamiframe`.
//
// Their difference is which host object initiates and progresses a connection
// in browser. Therefore, client not running on browser like Java
// client don't have to implement them. `sse` is enough for streaming. To pass
// the test suite, just assign `sse` instead of them when they are requested.
["streamxhr", "streamxdr", "streamiframe"].forEach(function(tpName) {
    transports[tpName] = function(u, params) {
        var req,
            transport = transports.httpbase(u, params);
        
        // Performs a persistent HTTP connection via `GET` method.
        req = http.get(uri(u, {id: params.id, when: "open", transport: tpName, heartbeat: params.heartbeat}))
        // If any error is encountered, fires the close event.
        .on("error", function() {
            transport.emit("close");
        })
        // Technically the open event should be fired by the first chunk,
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
                // If the chunk consists of only whitespace characters, there is
                // nothing to do.
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
                // It looks not easy to handle. So let's concatenate buffer and chunk. 
                // Here the buffer is a string after last `\n\n` of the concatenation.
                // * `""` + `"data: {}\n\ndata: {}\n\n"`
                // * `""` + `"data: {}\n\ndata: {"`
                // * `"data: {"` + `"}\n\ndata:{"`
                // * `"data: {"` + `".."`
                // * `"data: {.."` + `".}"`
                // * `"data: {...}"` + `"\n\ndata: {}\n\n"`
                
                // Let's split the concatenation by `\n\n`. 
                var i, lines = (buffer + chunk).split("\n\n");
                // Lines except the last consist of a complete data starting 
                // with 'data: ' Unwraps 'data: ' and fires a message event.
                for (i = 0; i < lines.length - 1; i++) {
                    transport.emit("message", lines[i].substring("data: ".length));
                }
                // The last element is a fragment of a data. Assigns it to buffer.
                buffer = lines[lines.length - 1];
            })
            .on("end", function() {
                transport.emit("close");
            });
        });
        // #### abort
        transport.close = function() {
            // By aborting the current client.
            req.abort();
        };
        return transport;
    };
});

// ### Long polling by AJAX, XDomainRequest
// `longpollajax` and `longpollxdr`.
//
// Their difference is which host object initiates and progresses a connection
// in browser. Therefore, client not running on browser like Java client don't
// have to implement `longpollxdr`. `longpollajax` is enough for long polling.
// To pass the test suite, just assign `longpollajax` instead of `longpollxdr`
// when it is requested.
["longpollajax", "longpollxdr"].forEach(function(tpName) {
    // In long polling, a pseudo-connection consisting of disposable HTTP exchanges
    // pretends to be a persistent connection.
    transports[tpName] = function(u, params) {
        // The current HTTP client.
        var req,
            transport = transports.httpbase(u, params);
        // #### open
        // The first request is to open and subsequent requests are to poll. All
        // they use `GET` method.
        req = http.get(uri(u, {id: params.id, when: "open", transport: tpName, heartbeat: params.heartbeat}))
        // If any error is encountered during the request, that means the
        // server is not available. So fires the close event.
        .on("error", function() {
            transport.emit("close");
        })
        // If the server is available so the first request is completed normally,
        // start to poll and fire the open event. To pretend a persistent connection
        // properly, there must be no idle time between the poll.
        // Therefore, always starting poll request is prior to dispatching events.
        // Otherwise, the user might see the connection is not operational
        // occasionally.
        .on("response", function() {
            // For the first time, starts with empty array.
            poll([]);
            // The poll request is started so fire the open event.
            transport.emit("open");
            // #### poll
            // From the second request, `when` is `poll` and `lastEventIds` is
            // needed that is a CSV of event ids in the preceding request's response
            // is needed.
            function poll(lastEventIds) {
                // FYI, `["x", "y", "z"].join(",")` gives `"x,y,z"`.
                req = http.get(uri(u, {id: params.id, when: "poll", lastEventIds: lastEventIds.join(",")}))
                // This is the same with the open request's error event.
                .on("error", function() {
                    transport.emit("close");
                })
                // If the server responds to the request, determine whether the
                // intention of response is to send event or to close.
                .on("response", function(res) {
                    // Reads body.
                    var body = "";
                    res.on("data", function(chunk) {
                        body += chunk;
                    });
                    res.on("end", function() {
                        // If body exists, it is a JSON string representing the
                        // server-sent events.
                        if (body) {
                            // To prepare the next request, identify events in the
                            // response and collect their ids.
                            var eventIds = [], obj = JSON.parse(body);
                            // If the parsed object is an array, it contains events
                            // that the client couldn't receive before.
                            if (Array.isArray(obj)) {
                                // An array of multiple event ids. FYI,
                                // `[{id:1},{id:2},{id:3}].map(function(e) {return
                                // e.id;})` gives `[1,2,3]`.
                                eventIds = obj.map(function(event) {
                                    return event.id;
                                });
                            // Otherwise, it's a plain event object.
                            } else {
                                // An array of a single event id.
                                eventIds = [obj.id];
                            }
                            // Sends a poll request again before to fire events.
                            // Again call order is important.
                            poll(eventIds);
                            if (Array.isArray(obj)) {
                                // It's uncomfortable to stringify parsed object
                                // again but anyway fire a message event to the
                                // socket with stringified event.
                                obj.forEach(function(event) {
                                    transport.emit("message", JSON.stringify(event));
                                });
                            } else {
                                // Fires a message event with that string body.
                                transport.emit("message", body);
                            }
                        // If the server closed the socket, body becomes absent.
                        // Accordingly fires the close event.
                        } else {
                            transport.emit("close");
                        }
                    });
                });
            }
        });
        // #### abort
         transport.close = function() {
            // By aborting the current client.
            req.abort();
        };
        return transport;
    };
});


// ### Long polling by JSONP
// `longpolljsonp`.
//
// Except request's callback param, response's content-type header and its body,
// `longpolljsonp` and `longpollajax` are all the same. So duplicated comments
// are removed.
transports.longpolljsonp = function(u, params) {
    var req,
        transport = transports.httpbase(u, params);
    // Adds the callback param. In browser response body can't be controlled so
    // it should be unique.
    req = http.get(uri(u, {id: params.id, when: "open", transport: "longpolljsonp", callback: "dayoff", heartbeat: params.heartbeat}))
    .on("error", function() {
        transport.emit("close");
    })
    .on("response", function() {
        poll([]);
        transport.emit("open");
        function poll(lastEventIds) {
            req = http.get(uri(u, {id: params.id, when: "poll", lastEventIds: lastEventIds.join(",")}))
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
                        // The returned body is a JavaScript code snippet executing 
                        // the callback with data. In browser it will be executed 
                        // immediately. Here we can manipulate the body so retrieve 
                        // the real data by stripping function call experession 
                        // and unescpaing it as JSON.
                        body = JSON.parse(body.match(/^dayoff\((.*)\);$/)[1]);
                        var eventIds = [], obj = JSON.parse(body);
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
     transport.close = function() {
        req.abort();
    };
    return transport;
};