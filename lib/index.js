/*
 * Vibe
 * http://vibe-project.github.io/projects/vibe-protocol/
 * 
 * Copyright 2014 The Vibe Project 
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
// Defines the module
module.exports = {
    // Creates a vibe socket and establishes a connection to the server.
    open: require("./socket"),
    // Creates a vibe server.
    createServer: require("./server"),
    // Defines Transport module.
    transport: {
        // Creates a HTTP transport server.
        createHttpServer: require("./transport-http-server"),
        // Creates a HTTP streaming transport.
        createHttpStreamTransport: require("./transport-http-stream-transport"),
        // Creates a HTTP long polling transport.
        createHttpLongpollTransport: require("./transport-http-longpoll-transport"),
        // Creates a WebSocket transport server.
        createWebSocketServer: require("./transport-websocket-server"),
        // Creates a WebSocket transport.
        createWebSocketTransport: require("./transport-websocket-transport"),
    }
};