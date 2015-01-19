/*
 * Vibe
 * http://vibe-project.github.io/projects/vibe-protocol/
 * 
 * Copyright 2014 The Vibe Project 
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
var events = require("events");
var WebSocket = require("ws");

// This function is exposed to the module's `transport.createWebSocketServer` as
// a constructor of transport server which consumes WebSocket connection and
// produces transport.
module.exports = function() {
    // A transport server object.
    var self = new events.EventEmitter();
    // A factory to upgrade HTTP exchange to WebSocket.
    var webSocketUpgrader = new WebSocket.Server({noServer: true});
    // A link between Vibe WebSocket transport protocol and Node.js. `req`,
    // `sock` and `head` are expected to be passed from Node.js's `http/https`
    // module' server' `upgrade` event.
    self.handle = function(req, sock, head) {
        webSocketUpgrader.handleUpgrade(req, sock, head, function(ws) {
            self.emit("transport", createWebSocketTransport(ws));
        });
    };
    return self;
};

// WebSocket is a protocol designed for a full-duplex communications over a TCP
// connection.
function createWebSocketTransport(ws) {
    // A transport object.
    var self = new events.EventEmitter();
    // Simply delegates WebSocket's events to transport and transport's
    // behaviors to WebSocket.
    ws.onmessage = function(event) {
        // For now only text message is used.
        if (typeof event.data === "string") {
            self.emit("text", event.data);
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
}