/*
 * Vibe
 * http://vibe-project.github.io/projects/vibe-protocol/
 * 
 * Copyright 2014 The Vibe Project 
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
var events = require("events");

// It creates a base transport.
module.exports = function(uri, options) {
    // A transport object.
    var self = new events.EventEmitter();
    self.open = function() {
        // Establishes the real connection. `connect should be implemented by
        // others.
        self.connect(uri, options);
        // Sets a timeout timer.
        var timeoutTimer = setTimeout(function() {
            // Fires a timeout error.
            self.emit("error", new Error("timeout"));
            // `close` should ensure that `close` event is fired.
            self.close();
        }, options.timeout);
        // If it establishes a connection, cancels the timer.
        self.on("open", function() {
            clearTimeout(timeoutTimer);
        });
        // If it fails to establish a connection before the timer expires,
        // cancels the timer.
        self.on("close", function() {
            clearTimeout(timeoutTimer);
        });
    };
    return self;
};