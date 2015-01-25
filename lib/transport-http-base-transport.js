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
var http = require("http");
var createBaseTransport = require("./transport-base-transport");

http.globalAgent.maxSockets = Infinity;

// It creates a base transport which provides common functionalities of HTTP
// transport.
module.exports = function(uri, options) {
    // A transport object.
    var self = createBaseTransport(uri, options);
    // A flag to check if this transport is opened.
    var opened = false;
    self.on("open", function() {
        opened = true;
    });
    self.on("close", function() {
        opened = false;
    });
    // For the client to send message to the server,
    self.send = function(data) {
        var reqOpts = url.parse(uri);
        // `id` param should be added to query. As it has already `transport`
        // param, `&` can be preceded safely.
        reqOpts.path += "&id=" + encodeURIComponent(self.id);
        // The request's method should be `POST`.
        reqOpts.method = "POST";
        // The request's content type header should be `text/plain;
        // charset=utf-8`.
        reqOpts.headers = {"content-type": "text/plain; charset=utf-8"};
        http.request(reqOpts).on("error", function(error) {
            // Try again as long as the connection is opened if sending event to
            // the server fails for some reason.
            if (opened) {
                self.send(data);
            }
        })
        // The final body should be prefixed with `data=`.
        .end("data=" + data);
    };
    self.close = function() {
        // Aborts the real connection. `abort` should be implemented by others
        // and ensure that `close` event is fired.
        self.abort();
        // Server may not detect disconnection for some reason. Notifies the
        // server of disconnection of this connection to make sure. In this
        // request, `id` param should be added to query and `when` param should
        // be set to `abort`.
        http.get(uri + "&when=abort&id=" + encodeURIComponent(self.id));
    };
    return self;
};