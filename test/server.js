var parseArgs = require("minimist");
var should = require("chai").should();
var http = require("http");
var vibe = require("../lib/index");
var client = vibe.client();

http.globalAgent.maxSockets = Infinity;

//A factory to create a group of test
var factory = {
    args: parseArgs(process.argv, {
        default: {
            vibe: {transports: "", extension: ""}
        }
    }).vibe,
    create: function(title, fn) {
        describe(title, function() {
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

describe("server", function() {
    // Endpoint of the vibe server to be tested
    var host = "http://localhost:8000";
    var uri = host + "/vibe";

    this.timeout(20 * 1000);
    
    before(function() {
        var self = this;
        // A container for active socket to close them after each test
        var sockets = [];
        // Override client.open to capture socket
        self.open = client.open;
        client.open = function open() {
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
        client.open = this.open;
    });
    
    factory.create("should accept a new socket", function(done) {
        client.open(uri, {transport: this.args.transport})
        .on("open", function() {
            done();
        });
    });
    factory.create("should close the socket", function(done) {
        var test = this.test;
        var socket = client.open(uri, {transport: this.args.transport})
        .on("open", function abort() {
            // This request aborts this socket in server
            http.get(uri + "?id=" + socket.id + "&when=abort", function() {
                // The server may not have fired open event
                // and the socket couldn't be aborted.
                // Therefore, request again until the test
                // is passed or timed out.
                if (test.state !== "passed" && !test.timedOut) {
                    setTimeout(abort, 1000);
                }
            });
        })
        .on("close", function() {
            done();
        });
    });
    factory.create("should detect the client's disconnection", function(done) {
        var test = this.test;
        // A server who can't detect disconnection will notice it by heartbeat
        var socket = client.open(uri, {transport: this.args.transport, heartbeat: 10000, _heartbeat: 5000})
        .on("open", function() {
            this.close();
        })
        .on("close", function check() {
            // This request checks if this socket in server
            // is alive or not.
            http.get(host + "/alive?id=" + socket.id, function(res) {
                var body = "";
                res.on("data", function(chunk) {
                    body += chunk;
                })
                .on("end", function() {
                    // The 'false' body means the server has
                    // no such socket that is a successful
                    // case. If not, request again until the
                    // server notices it.
                    if (body === "false") {
                        done();
                    } else if (test.state !== "passed" && !test.timedOut) {
                        setTimeout(check, 1000);
                    }
                });
            });
        });
    });
    factory.create("should exchange an event", function(done) {
        client.open(uri, {transport: this.args.transport})
        .on("open", function() {
            this.send("echo", "data");
        })
        .on("echo", function(data) {
            data.should.be.equal("data");
            done();
        });
    });
    factory.create("should exchange an event containing of multi-byte characters", function(done) {
        client.open(uri, {transport: this.args.transport})
        .on("open", function() {
            this.send("echo", "라면");
        })
        .on("echo", function(data) {
            data.should.be.equal("라면");
            done();
        });
    });
    factory.create("should exchange an event of 2KB", function(done) {
        var text2KB = Array(2048).join("K");
        client.open(uri, {transport: this.args.transport})
        .on("open", function() {
            this.send("echo", text2KB);
        })
        .on("echo", function(data) {
            data.should.be.equal(text2KB);
            done();
        });
    });
    factory.create("should not lose any event in an exchange of one hundred of event", function(done) {
        var timer, sent = [], received = [];
        client.open(uri, {transport: this.args.transport})
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
    factory.create("should support heartbeat", function(done) {
        client.open(uri, {transport: this.args.transport, heartbeat: 2500, _heartbeat: 2400})
        .once("heartbeat", function() {
            this.once("heartbeat", function() {
                this.once("heartbeat", function() {
                    done();
                }); 
            });
        });
    });
    factory.create("should close the socket if heartbeat fails", function(done) {
        client.open(uri, {transport: this.args.transport, heartbeat: 2500, _heartbeat: 2400})
        .on("open", function() {
            this.send = function() { return this; };
        })
        .on("close", function() {
            done();
        });
    });
    if (factory.args.extension.indexOf("reply") !== -1) {
        describe("reply", function() {
            factory.create("should execute the resolve callback in receiving event", function(done) {
                client.open(uri, {transport: this.args.transport})
                .on("open", function() {
                    this.send("/reply/inbound", {type: "resolved", data: Math.PI}, function(value) {
                        value.should.be.equal(Math.PI);
                        done();
                    }, function() {
                        true.should.be.false;
                    });
                });
            });
            factory.create("should execute the reject callback in receiving event", function(done) {
                client.open(uri, {transport: this.args.transport})
                .on("open", function() {
                    this.send("/reply/inbound", {type: "rejected", data: Math.PI}, function() {
                        true.should.be.false;
                    }, function(value) {
                        value.should.be.equal(Math.PI);
                        done();
                    });
                });
            });
            factory.create("should execute the resolve callback in sending event", function(done) {
                client.open(uri, {transport: this.args.transport})
                .on("open", function() {
                    this.send("/reply/outbound", {type: "resolved", data: Math.E});
                })
                .on("test", function(data, reply) {
                    reply.resolve(data);
                    this.on("done", function(value) {
                        value.should.be.equal(Math.E);
                        done();
                    });
                });
            });
            factory.create("should execute the reject callback in sending event", function(done) {
                client.open(uri, {transport: this.args.transport})
                .on("open", function() {
                    this.send("/reply/outbound", {type: "rejected", data: Math.E});
                })
                .on("test", function(data, reply) {
                    reply.reject(data);
                    this.on("done", function(value) {
                        value.should.be.equal(Math.E);
                        done();
                    });
                });
            });
        });
    }
});