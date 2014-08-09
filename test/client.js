// A reusable test suite to verify the client implementation
var should = require("chai").should();
var url = require("url");
var http = require("http");
var querystring = require("querystring");
var vibe = require("../lib/index");
var sid = process.env.VIBE_TEST_SESSION_ID;

http.globalAgent.maxSockets = Infinity;

describe("client", function() {
    this.timeout(20 * 1000);
    
    before(function(done) {
        var self = this;
        // A container for active socket to close them after each test
        var sockets = [];
        var server = vibe.server().on("socket", function(socket) {
            sockets.push(socket);
            // Remove the closed one
            socket.on("close", function() {
                sockets.splice(sockets.indexOf(socket), 1);
            });
        });
        
        // A container for active net socket to destroy them after the whole suite
        var netSockets = [];
        var httpServer = http.createServer().on("connection", function(socket) {
            netSockets.push(socket);
            // Remove the closed one
            socket.on("close", function () {
                netSockets.splice(netSockets.indexOf(socket), 1);
            });
        });
        // Install a vibe server on a web server
        httpServer.on("request", function(req, res) {
            if (url.parse(req.url).pathname === "/vibe") {
                server.handleRequest(req, res);
            }
        })
        .on("upgrade", function(req, sock, head) {
            if (url.parse(req.url).pathname === "/vibe") {
                server.handleUpgrade(req, sock, head);
            }
        });
        // Start the web server
        httpServer.listen(0, function() {
            var port = this.address().port;
            // This method is to tell client to connect this server 
            self.order = function(params) {
                if (sid) {
                    params.sid = sid;
                }
                params.uri = "http://localhost:" + port + "/vibe";
                params.heartbeat = params.heartbeat || false;
                params._heartbeat = params._heartbeat || false;
                http.get("http://localhost:9000/open?" + querystring.stringify(params));
            };
            done();
        });
        
        self.sockets = sockets;
        self.server = server;
        self.netSockets = netSockets;
        self.httpServer = httpServer;
    });
    beforeEach(function() {
        // To restore the original stack
        this.socketListeners = this.server.listeners("socket");
    });
    afterEach(function() {
        // Disconnect sockets used in test
        this.sockets.forEach(function(socket) {
            socket.close();
        });
        // Remove the listener added by the test and restore the original stack
        this.server.removeAllListeners("socket");
        this.socketListeners.forEach(function(listener) {
            this.server.on("socket", listener);
        }.bind(this));
    });
    after(function(done) {
        // To shutdown the web server immediately
        setTimeout(function() {
            this.netSockets.forEach(function(socket) {
                socket.destroy();
            });
            this.httpServer.close(function() {
                done();
            });
        }.bind(this), 10);
    });
    
    describe("transport", function() {
        "ws sse streamxhr streamxdr streamiframe longpollajax longpollxdr longpolljsonp".split(" ").forEach(function(transport) {
            // Per transport
            describe(transport, function() {
                // Protocol part
                describe("protocol", function() {
                    describe("open", function() {
                        it("should open a new socket", function(done) {
                            this.order({transport: transport});
                            this.server.on("socket", function() {
                                done();
                            });
                        });
                    });
                    describe("close", function() {
                        it("should close the socket", function(done) {
                            this.order({transport: transport});
                            this.server.on("socket", function(socket) {
                                socket.on("close", function() {
                                    done();
                                })
                                .send("abort");
                            });
                        });
                        it("should detect the server's disconnection", function(done) {
                            var test = this.test;
                            // A client who can't detect disconnection will notice it by heartbeat
                            this.order({transport: transport, heartbeat: 10000, _heartbeat: 5000});
                            this.server.on("socket", function(socket) {
                                var id = socket.id;
                                socket.on("close", function check() {
                                    http.get("http://localhost:9000/alive?id=" + id, function(res) {
                                        var body = "";
                                        res.on("data", function(chunk) {
                                            body += chunk;
                                        })
                                        .on("end", function() {
                                            if (body === "false") {
                                                done();
                                            } else if (!test.timedOut) {
                                                setTimeout(check, 1000);
                                            }
                                        });
                                    });
                                })
                                .close();
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
                                    received.sort();
                                    clearTimeout(timer);
                                    timer = setTimeout(function() {
                                        received.should.be.deep.equal(sent);
                                        done();
                                    }, 1500);
                                });
                                for (var i = 0; i < 100; i++) {
                                    (function(i) {
                                        setTimeout(function() {
                                            sent.push(i);
                                            sent.sort();
                                            socket.send("echo", i);
                                        }, 10);
                                    })(i);
                                }
                            });
                        });
                    });
                    describe("heartbeat", function() {
                        it("should support heartbeat", function(done) { 
                            this.order({transport: transport, heartbeat: 2500, _heartbeat: 2400});
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
                            this.order({transport: transport, heartbeat: 2500, _heartbeat: 2400});
                            this.server.on("socket", function(socket) {
                                socket.send = function() { return this; };
                                socket.on("close", function() {
                                    done();
                                });
                            });
                        });
                    });
                });
                // Extension part
                describe("extension", function() {
                    describe("receiving replyable event", function() {
                        it("should be able to resolve", function(done) {
                            this.order({transport: transport});
                            this.server.on("socket", function(socket) {
                                socket.send("rre.resolve", Math.PI, function(value) {
                                    value.should.be.equal(Math.PI);
                                    done();
                                }, function() {
                                    true.should.be.false;
                                });
                            });
                        });
                        it("should be able to reject", function(done) {
                            this.order({transport: transport});
                            this.server.on("socket", function(socket) {
                                socket.send("rre.reject", Math.PI, function() {
                                    true.should.be.false;
                                }, function(value) {
                                    value.should.be.equal(Math.PI);
                                    done();
                                });
                            });
                        });
                    });
                    describe("sending replyable event", function() {
                        it("should be able to resolve", function(done) {
                            this.order({transport: transport});
                            this.server.on("socket", function(socket) {
                                socket.on("sre.resolve", function(data, reply) {
                                    reply.resolve(data);
                                })
                                .on("sre.done", function(value) {
                                    value.should.be.equal(Math.E);
                                    done();
                                })
                                .send("sre.resolve", Math.E);
                            });
                        });
                        it("should be able to reject", function(done) {
                            this.order({transport: transport});
                            this.server.on("socket", function(socket) {
                                socket.on("sre.reject", function(data, reply) {
                                    reply.reject(data);
                                })
                                .on("sre.done", function(value) {
                                    value.should.be.equal(Math.E);
                                    done();
                                })
                                .send("sre.reject", Math.E);
                            });
                        });
                    });
                });
            });
        });
    });
});