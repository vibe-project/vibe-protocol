var should = require("chai").should(),
    http = require("http"),
    client = require("../lib/client.js");

http.globalAgent.maxSockets = Infinity;

describe("server", function() {
    var uri = "http://localhost:8000/react";

    before(function() {
        var self = this;
        self.sockets = [];
        self.open = client.open;
        client.open = function() {
            return self.open.apply(this, arguments)
            .on("open", function() {
                self.sockets.push(this);
            })
            .on("close", function() {
                self.sockets.splice(self.sockets.indexOf(this), 1);
            });
        };
    });
    after(function() {
        client.open = this.open;
    });
    afterEach(function() {
        this.sockets.forEach(function(socket) {
            socket.close();
        });
    });
    
    describe("transport", function() {
        function suite(transport) {
            describe("open", function() {
                it("should open a new socket", function(done) {
                    client.open(uri, {transport: transport})
                    .on("open", function() {
                        done();
                    });
                });
            });
            describe("close", function() {
                it("should close the socket if the client requests it", function(done) {
                    client.open(uri, {transport: transport})
                    .on("open", function() {
                        this.close();
                    })
                    .on("close", function() {
                        done();
                    });
                });
                it("should close the socket if the server requests it", function(done) {
                    client.open(uri, {transport: transport})
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
                    client.open(uri, {transport: transport})
                    .on("open", function() {
                        this.send("echo", "data");
                    })
                    .on("echo", function(data) {
                        data.should.be.equal("data");
                        done();
                    });
                });
                it("should exchange an event containing of multi-byte characters", function(done) {
                    client.open(uri, {transport: transport})
                    .on("open", function() {
                        this.send("echo", "진행 중인 초고");
                    })
                    .on("echo", function(data) {
                        data.should.be.equal("진행 중인 초고");
                        done();
                    });
                });
                it("should exchange an event of 2KB", function(done) {
                    var text2KB = Array(2048).join("K");
                    client.open(uri, {transport: transport})
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
                    client.open(uri, {transport: transport})
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
                    client.open(uri, {transport: transport})
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
                    client.open(uri, {transport: transport, heartbeat: 400, _heartbeat: 200})
                    .once("heartbeat", function() {
                        this.once("heartbeat", function() {
                            this.once("heartbeat", function() {
                                done();
                            }); 
                        });
                    });
                });
                it("should close the socket if heartbeat fails", function(done) {
                    client.open(uri, {transport: transport, heartbeat: 400, _heartbeat: 200})
                    .on("open", function() {
                        this.send = function() { return this; };
                    })
                    .on("close", function() {
                        done();
                    });
                });
            });
        }
        
        ["ws", "sse", "longpollajax"].forEach(function(transport) {
            describe(transport, function() {
                suite(transport);
            });
        });
    });
});