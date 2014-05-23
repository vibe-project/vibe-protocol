// A reusable test suite to verify the server implementation
var should = require("chai").should();
var http = require("http");
var react = require("../lib/index");

http.globalAgent.maxSockets = Infinity;

describe("server", function() {
    // Endpoint of the react server to be tested
    var uri = "http://localhost:8000/react";

    this.timeout(10000);
    
    before(function() {
        var self = this;
        // A container for active socket to close them after each test
        var sockets = [];
        // Override react.open to capture socket
        self.open = react.open;
        react.open = function open() {
            return self.open.apply(this, arguments)
            .on("open", function() {
                sockets.push(this);
            })
            .on("close", function() {
                // Remove the closed one
                sockets.splice(sockets.indexOf(this), 1);
            });
        };
        
        self.sockets = sockets;
    });
    afterEach(function() {
        // Disconnect sockets used in test
        this.sockets.forEach(function(socket) {
            socket.close();
        });
    });
    after(function() {
        // Restore the original method
        react.open = this.open;
    });
    
    describe("transport", function() {
        function suite(transport) {
            describe("open", function() {
                it("should open a new socket", function(done) {
                    react.open(uri, {transport: transport})
                    .on("open", function() {
                        done();
                    });
                });
            });
            describe("close", function() {
                it("should close the socket if the client requests it", function(done) {
                    react.open(uri, {transport: transport})
                    .on("open", function() {
                        this.close();
                    })
                    .on("close", function() {
                        done();
                    });
                });
                it("should close the socket if the server requests it", function(done) {
                    react.open(uri, {transport: transport})
                    .on("open", function() {
                        http.get(uri + "?id=" + this.id + "&when=abort");
                    })
                    .on("close", function() {
                        done();
                    });
                });
            });
            describe("exchange", function() {
                it("should exchange an event", function(done) {
                    react.open(uri, {transport: transport})
                    .on("open", function() {
                        this.send("echo", "data");
                    })
                    .on("echo", function(data) {
                        data.should.be.equal("data");
                        done();
                    });
                });
                it("should exchange an event containing of multi-byte characters", function(done) {
                    react.open(uri, {transport: transport})
                    .on("open", function() {
                        this.send("echo", "라면");
                    })
                    .on("echo", function(data) {
                        data.should.be.equal("라면");
                        done();
                    });
                });
                it("should exchange an event of 2KB", function(done) {
                    var text2KB = Array(2048).join("K");
                    react.open(uri, {transport: transport})
                    .on("open", function() {
                        this.send("echo", text2KB);
                    })
                    .on("echo", function(data) {
                        data.should.be.equal(text2KB);
                        done();
                    });
                });
                it("should not lose any event in an exchange of one hundred of event", function(done) {
                    var timer, sent = [], received = [];
                    react.open(uri, {transport: transport})
                    .on("open", function() {
                        for (var i = 0; i < 100; i++) {
                            sent.push(i);
                            this.send("echo", i);
                        }
                        sent.sort();
                    })
                    .on("echo", function(i) {
                        received.push(i);
                        clearTimeout(timer);
                        timer = setTimeout(function() {
                            received.sort();
                            received.should.be.deep.equal(sent);
                            done();
                        }, 200);
                    });
                });
            });
            describe("reply", function() {
                it("should handle reply requested by the client", function(done) {
                    react.open(uri, {transport: transport})
                    .on("open", function() {
                        function fail() { true.should.be.false; }
                        this.send("reaction", true, function(value) {
                            value.should.be.true;
                            this.send("reaction", false, fail, function(reason) {
                                reason.should.be.false;
                                done();
                            });
                        }, fail);
                    });
                });
            });
            describe("heartbeat", function() {
                it("should support heartbeat", function(done) {
                    react.open(uri, {transport: transport, heartbeat: 400, _heartbeat: 200})
                    .once("heartbeat", function() {
                        this.once("heartbeat", function() {
                            this.once("heartbeat", function() {
                                done();
                            }); 
                        });
                    });
                });
                it("should close the socket if heartbeat fails", function(done) {
                    react.open(uri, {transport: transport, heartbeat: 400, _heartbeat: 200})
                    .on("open", function() {
                        this.send = function() { return this; };
                    })
                    .on("close", function() {
                        done();
                    });
                });
            });
        }
        
        "ws sse streamxhr streamxdr streamiframe longpollajax longpollxdr longpolljsonp".split(" ").forEach(function(transport) {
            describe(transport, function() {
                suite(transport);
            });
        });
    });
});