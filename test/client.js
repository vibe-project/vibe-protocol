var parseArgs = require("minimist");
var should = require("chai").should();
var url = require("url");
var http = require("http");
var querystring = require("querystring");
var crypto = require("crypto");
var vibe = require("../lib/index");

http.globalAgent.maxSockets = Infinity;

// A factory to create a group of test
var factory = {
    args: parseArgs(process.argv, {
        default: {
            "vibe.transports": "",
            "vibe.extension": "",
        }
    })
    .vibe,
    create: function(title, fn) {
        describe(title, function() {
            // Per transport
            factory.args.transports.split(",").forEach(function(transport) {
                var args = {transport: transport};
                it(transport, function(done) {
                    this.args = args;
                    fn.apply(this, arguments);
                });
            });
        });
    }
};

describe("client", function() {
    this.timeout(15 * 1000);

    var origin = "http://localhost:9000";
    // To be destroyed
    var sockets = [];
    var netSockets = [];
    // A Vibe server
    var server = vibe.server();
    server.on("socket", function(socket) {
        sockets.push(socket);
        socket.on("close", function() {
            sockets.splice(sockets.indexOf(socket), 1);
        });
    });
    // An HTTP server to install Vibe server
    var httpServer = http.createServer();
    httpServer.on("connection", function(socket) {
        netSockets.push(socket);
        socket.on("close", function () {
            netSockets.splice(netSockets.indexOf(socket), 1);
        });
    })
    .on("request", function(req, res) {
        if (url.parse(req.url).pathname === "/vibe") {
            server.handleRequest(req, res);
        }
    })
    .on("upgrade", function(req, sock, head) {
        if (url.parse(req.url).pathname === "/vibe") {
            server.handleUpgrade(req, sock, head);
        }
    });

    function run(options) {
        if (options.heartbeat) {
            server.setHeartbeat(options.heartbeat);
        }
        if (options._heartbeat) {
            server.set_heartbeat(options._heartbeat);
        }
        var params = {
            uri: "http://localhost:" + httpServer.address().port + "/vibe",
            transport: options.transport
        };
        // To test multiple clients concurrently
        if (factory.args.session) {
            params.session = factory.args.session;
        }
        http.get(origin + "/open?" + querystring.stringify(params));
    }
    
    before(function(done) {
        httpServer.listen(0, function() {
            done();
        });
    });
    after(function(done) {
        // To shutdown the web server immediately
        netSockets.forEach(function(socket) {
            socket.destroy();
        });
        httpServer.close(function() {
            done();
        });
    });
    beforeEach(function() {
        // To restore the original stack
        this.socketListeners = server.listeners("socket");
    });
    afterEach(function() {
        // Remove the listener added by the test and restore the original stack
        server.removeAllListeners("socket");
        this.socketListeners.forEach(server.on.bind(server, "socket"));
        // To release stress of browsers, clean sockets
        sockets.forEach(function(socket) {
            socket.close();
        });
    });
    
    factory.create("should open a new socket", function(done) {
        server.on("socket", function(socket) {
            done();
        });
        run({transport: this.args.transport});
    });
    factory.create("should close the socket", function(done) {
        server.on("socket", function(socket) {
            socket.on("close", function() {
                done();
            })
            .send("abort");
        });
        run({transport: this.args.transport});
    });
    factory.create("should detect the server's disconnection", function(done) {
        var test = this.test;
        server.on("socket", function(socket) {
            var name = crypto.randomBytes(3).toString("hex");
            socket.on("close", function check() {
                // This request checks if this socket in client is alive or not.
                http.get(origin + "/alive?name=" + name, function(res) {
                    var body = "";
                    res.on("data", function(chunk) {
                        body += chunk;
                    })
                    .on("end", function() {
                        // The 'false' body means the client has no such socket
                        // that is a successful case. If not, request again
                        // until the client notices it.
                        if (body === "false") {
                            done();
                        } else if (test.state !== "passed" && !test.timedOut) {
                            setTimeout(check, 1000);
                        }
                    });
                });
            })
            .send("name", name).close();
        });
        // A client who can't detect disconnection will notice it by heartbeat
        run({transport: this.args.transport, heartbeat: 10000, _heartbeat: 5000});
    });
    factory.create("should exchange an event", function(done) {
        server.on("socket", function(socket) {
            socket.on("echo", function(data) {
                data.should.be.equal("data");
                done();
            })
            .send("echo", "data");
        });
        run({transport: this.args.transport});
    });
    factory.create("should exchange an event containing of multi-byte characters", function(done) {
        server.on("socket", function(socket) {
            socket.on("echo", function(data) {
                data.should.be.equal("라면");
                done();
            })
            .send("echo", "라면");
        });
        run({transport: this.args.transport});
    });
    factory.create("should exchange an event of 2KB", function(done) {
        var text2KB = Array(2048).join("K");
        server.on("socket", function(socket) {
            socket.on("echo", function(data) {
                data.should.be.equal(text2KB);
                done();
            })
            .send("echo", text2KB);
        });
        run({transport: this.args.transport});
    });
    factory.create("should not lose any event in an exchange of one hundred of event", function(done) {
        var timer, sent = [], received = [];
        server.on("socket", function(socket) {
            socket.on("echo", function(i) {
                received.push(i);
                clearTimeout(timer);
                timer = setTimeout(function() {
                    sent.sort();
                    received.sort();
                    received.should.be.deep.equal(sent);
                    done();
                }, 1500);
            });
            for (var i = 0; i < 100; i++) {
                (function(i) {
                    setTimeout(function() {
                        sent.push(i);
                        socket.send("echo", i);
                    }, 10);
                })(i);
            }
        });
        run({transport: this.args.transport});
    });
    factory.create("should close the socket if heartbeat fails", function(done) {
        server.on("socket", function(socket) {
            // Breaks heartbeat functionality
            socket.send = function() {
                return this;
            };
            socket.on("error", function() {})
            .on("close", function() {
                done();
            });
        });
        run({transport: this.args.transport, heartbeat: 2500, _heartbeat: 2400});
    });
    if (factory.args.extension.indexOf("reply") !== -1) {
        describe("reply", function() {
            factory.create("should execute the resolve callback when receiving event", function(done) {
                server.on("socket", function(socket) {
                    socket.send("/reply/inbound", {type: "resolved", data: Math.PI}, function(value) {
                        value.should.be.equal(Math.PI);
                        done();
                    }, function() {
                        true.should.be.false;
                    });
                });
                run({transport: this.args.transport});
            });
            factory.create("should execute the reject callback when receiving event", function(done) {
                server.on("socket", function(socket) {
                    socket.send("/reply/inbound", {type: "rejected", data: Math.PI}, function() {
                        true.should.be.false;
                    }, function(value) {
                        value.should.be.equal(Math.PI);
                        done();
                    });
                });
                run({transport: this.args.transport});
            });
            factory.create("should execute the resolve callback when sending event", function(done) {
                server.on("socket", function(socket) {
                    socket.on("test", function(data, reply) {
                        reply.resolve(data);
                        this.on("done", function(value) {
                            value.should.be.equal(Math.E);
                            done();
                        });
                    })
                    .send("/reply/outbound", {type: "resolved", data: Math.E});
                });
                run({transport: this.args.transport});
            });
            factory.create("should execute the reject callback when sending event", function(done) {
                server.on("socket", function(socket) {
                    socket.on("test", function(data, reply) {
                        reply.reject(data);
                        this.on("done", function(value) {
                            value.should.be.equal(Math.E);
                            done();
                        });
                    })
                    .send("/reply/outbound", {type: "rejected", data: Math.E});
                });
                run({transport: this.args.transport});
            });
        });
    }
});