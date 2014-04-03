var should = require("chai").should(),
    url = require("url"),
    http = require("http"),
    querystring = require("querystring"),
    react = require("../lib/server.js");

http.globalAgent.maxSockets = Infinity;

describe("client", function() {
    var uri = "http://localhost:9000";
    
    before(function(done) {
        var self = this;
        self.sockets = [];
        self.server = react.server()
        .on("socket", function(socket) {
            self.sockets.push(socket);
            socket.on("close", function() {
                self.sockets.splice(self.sockets.indexOf(socket), 1);
            });
        });
        self.netSockets = [];
        self.httpServer = http.createServer()
        .on("connection", function(socket) {
            self.netSockets.push(socket);
            socket.on("close", function () {
                self.netSockets.splice(self.netSockets.indexOf(socket), 1);
            });
        })
        .on("request", function(req, res) {
            if (url.parse(req.url).pathname === "/react") {
                self.server.handleRequest(req, res);
            }
        })
        .on("upgrade", function(req, sock, head) {
            if (url.parse(req.url).pathname === "/react") {
                self.server.handleUpgrade(req, sock, head);
            }
        })
        .listen(0, function() {
            var port = this.address().port;
            self.order = function(params) {
                params.uri = "http://localhost:" + port + "/react";
                params.heartbeat = params.heartbeat || false;
                params._heartbeat = params._heartbeat || false;
                http.get(uri + "/open?" + querystring.stringify(params));
            };
            done();
        });
    });
    after(function(done) {
        var self = this;
        setTimeout(function() {
            self.netSockets.forEach(function(socket) {
                socket.destroy();
            });
            self.httpServer.close(function() {
                done();   
            });
        }, 10);
    });
    beforeEach(function() {
        this.socketListeners = this.server.listeners("socket");
    });
    afterEach(function() {
        var self = this;
        self.sockets.forEach(function(socket) {
            socket.close();
        });
        self.server.removeAllListeners("socket");
        self.socketListeners.forEach(function(listener) {
            self.server.on("socket", listener);
        });
    });
    
    describe("transport", function() {
        function suite(transport) {
            describe("open", function() {
                it("should open a new socket", function(done) {
                    this.order({transport: transport});
                    this.server.on("socket", function() {
                        done();
                    });
                });
            });
            describe("close", function() {
                it("should close the socket if the server requests it", function(done) {
                    this.order({transport: transport});
                    this.server.on("socket", function(socket) {
                        socket.on("close", function() {
                            done();
                        })
                        .close();
                    });
                });
                it("should close the socket if the client requests it", function(done) {
                    this.order({transport: transport});
                    this.server.on("socket", function(socket) {
                        socket.on("close", function() {
                            done();
                        });
                        http.get(uri + "/close?id=" + socket.id);
                    });
                });
            });
            describe("exchange", function() {
                it("should exchange an event", function(done) {
                    this.order({transport: transport});
                    this.server.on("socket", function(socket) {
                        socket.on("echo", function(data) {
                            data.should.be.equal("data");
                            done();
                        })
                        .send("echo", "data");
                    });
                });
                it("should exchange an event containing of multi-byte characters", function(done) {
                    this.order({transport: transport});
                    this.server.on("socket", function(socket) {
                        socket.on("echo", function(data) {
                            data.should.be.equal("라면");
                            done();
                        })
                        .send("echo", "라면");
                    });
                });
                it("should exchange an event of 2KB", function(done) {
                    var text2KB = Array(2048).join("K");
                    this.order({transport: transport});
                    this.server.on("socket", function(socket) {
                        socket.on("echo", function(data) {
                            data.should.be.equal(text2KB);
                            done();
                        })
                        .send("echo", text2KB);
                    });
                });
                it("should not lose any event in an exchange of one hundred of event", function(done) {
                    var timer, sent = [], received = [];
                    this.order({transport: transport});
                    this.server.on("socket", function(socket) {
                        socket.on("echo", function(i) {
                            received.push(i);
                            clearTimeout(timer);
                            timer = setTimeout(function() {
                                received.sort();
                                received.should.be.deep.equal(sent);
                                done();
                            }, 200);
                        });
                        for (var i = 0; i < 100; i++) {
                            sent.push(i);
                            socket.send("echo", i);
                        }
                        sent.sort();
                    });
                });
            });
            describe("reply", function() {
                it("should handle reply requested by the client", function(done) {
                    this.order({transport: transport});
                    this.server.on("socket", function(socket) {
                        function fail() { true.should.be.false; }
                        socket.send("reaction", true, function(value) {
                            value.should.be.true;
                            socket.send("reaction", false, fail, function(reason) {
                                reason.should.be.false;
                                done();
                            });
                        }, fail);
                    });
                });
            });
            describe("heartbeat", function() {
                it("should support heartbeat", function(done) { 
                    this.order({transport: transport, heartbeat: 400, _heartbeat: 200});
                    this.server.on("socket", function(socket) {
                        socket.once("heartbeat", function() {
                            this.once("heartbeat", function() {
                                this.once("heartbeat", function() {
                                    done();
                                }); 
                            });
                        });
                    });
                });
                it("should close the socket if heartbeat fails", function(done) {
                    this.order({transport: transport, heartbeat: 400, _heartbeat: 200});
                    this.server.on("socket", function(socket) {
                        socket.send = function() { return this; };
                        socket.on("close", function() {
                            done();
                        });
                    });
                });
            });
        }
        
        ["ws", "sse", "streamxhr", "streamxdr", "streamiframe", "longpollajax"].forEach(function(transport) {
            describe(transport, function() {
                suite(transport);
            });
        });
    });
});