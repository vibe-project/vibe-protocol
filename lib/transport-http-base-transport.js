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
    // For the client to send message to the server,
    self.send = function(data) {
        var reqOpts = url.parse(uri);
        // Prepares for the request headers.
        reqOpts.headers = {};
        // `id` param should be added to query. As it has already `transport`
        // param, `&` can be preceded safely.
        reqOpts.path += "&id=" + encodeURIComponent(self.id);
        // The request's method should be `POST`.
        reqOpts.method = "POST";
        // Any error occurred when performing a request should propagate to
        // transport.
        function onerror(error) {
            self.emit("error", error);
        }
        // If it fails to perform a request, the connection should be closed.
        function onclose() {
            // It will fire `close` event finally.
            self.close();
        }

        // `data` should be either a `Buffer` or a string.
        if (typeof data === "string") {
            // The content type header should be `text/plain; charset=utf-8` for
            // text message.
            reqOpts.headers["content-type"] = "text/plain; charset=utf-8";
            // The final body should be prefixed with `data=` and encoded in
            // `utf-8`.
            http.request(reqOpts).on("error", onerror).on("close", onclose).end("data=" + data, "utf-8");
        } else {
            // The content type header should be `application/octet-stream` for
            // binary message.
            reqOpts.headers["content-type"] = "application/octet-stream";
            http.request(reqOpts).on("error", onerror).on("close", onclose).end(data);
        }
        return this;
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
        return this;
    };
    return self;
};