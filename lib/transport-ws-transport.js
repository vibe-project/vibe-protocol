/*
 * Vibe
 * http://vibe-project.github.io/projects/vibe-protocol/
 * 
 * Copyright 2014 The Vibe Project 
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
var events = require("events");
var url = require("url");
var WebSocket = require("ws");
var createBaseTransport = require("./transport-base-transport");

// This function is exposed to the module's `transport` module's
// `createWebSocketTransport` as a factory to create a WebSocket transport.
// WebSocket is a protocol designed for a full-duplex communications over a TCP
// connection.
module.exports = function(uri, options) {
    var urlObj = url.parse(uri, true);
    // URI's protocol should be either `ws` or `wss`.
    if (urlObj.protocol === "ws:" || urlObj.protocol === "wss:") {
        // A transport object.
        var self = createBaseTransport(uri, options);
        var ws;
        self.connect = function() {
            // Simply delegates WebSocket's events to transport and transport's
            // behaviors to WebSocket.
            ws = new WebSocket(uri);
            ws.onopen = function() {
                self.emit("open");
            };
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
        };
        self.send = function(data) {
            ws.send(data);
        };
        self.close = function() {
            ws.close();
        };
        return self;
    }
};