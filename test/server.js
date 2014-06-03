// A reusable test suite to verify the server implementation
var should = require("chai").should();
var http = require("http");
var vibe = require("../lib/index");

http.globalAgent.maxSockets = Infinity;

describe("server", function() {
    // Endpoint of the vibe server to be tested
    var uri = "http://localhost:8000/vibe";

    this.timeout(20 * 1000);
    
    before(function() {
        var self = this;
        // A container for active socket to close them after each test
        var sockets = [];
        // Override vibe.open to capture socket
        self.open = vibe.open;
        vibe.open = function open() {
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
        vibe.open = this.open;
    });
    
    describe("transport", function() {
        function suite(transport) {
            describe("open", function() {
                it("should open a new socket", function(done) {
                    vibe.open(uri, {transport: transport})
                    .on("open", function() {
                        done();
                    });
                });
            });
            describe("close", function() {
                it("should close the socket if the client requests it", function(done) {
                    vibe.open(uri, {transport: transport})
                    .on("open", function() {
                        this.close();
                    })
                    .on("close", function() {
                        done();
                    });
                });
                it("should close the socket if the server requests it", function(done) {
                    vibe.open(uri, {transport: transport})
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
                    vibe.open(uri, {transport: transport})
                    .on("open", function() {
                        this.send("echo", "data");
                    })
                    .on("echo", function(data) {
                        data.should.be.equal("data");
                        done();
                    });
                });
                it("should exchange an event containing of multi-byte characters", function(done) {
                    vibe.open(uri, {transport: transport})
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
                    vibe.open(uri, {transport: transport})
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
                    vibe.open(uri, {transport: transport})
                    .on("open", function() {
                        var self = this;
                        for (var i = 0; i < 100; i++) {
                            (function(i) {
                                setTimeout(function() {
                                    sent.push(i);
                                    sent.sort();
                                    self.send("echo", i);
                                }, 10);
                            })(i);
                        }
                    })
                    .on("echo", function(i) {
                        received.push(i);
                        received.sort();
                        clearTimeout(timer);
                        timer = setTimeout(function() {
                            received.should.be.deep.equal(sent);
                            done();
                        }, 1500);
                    });
                });
            });
            describe("reply", function() {
                it("should handle reply requested by the client", function(done) {
                    vibe.open(uri, {transport: transport})
                    .on("open", function() {
                        function fail() { true.should.be.false; }
                        this.send("replyable", true, function(value) {
                            value.should.be.true;
                            this.send("replyable", false, fail, function(reason) {
                                reason.should.be.false;
                                done();
                            });
                        }, fail);
                    });
                });
            });
            describe("heartbeat", function() {
                it("should support heartbeat", function(done) {
                    vibe.open(uri, {transport: transport, heartbeat: 2500, _heartbeat: 2400})
                    .once("heartbeat", function() {
                        this.once("heartbeat", function() {
                            this.once("heartbeat", function() {
                                done();
                            }); 
                        });
                    });
                });
                it("should close the socket if heartbeat fails", function(done) {
                    vibe.open(uri, {transport: transport, heartbeat: 2500, _heartbeat: 2400})
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