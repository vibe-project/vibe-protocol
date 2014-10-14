var parseArgs = require("minimist");
var should = require("chai").should();
var url = require("url");
var http = require("http");
var querystring = require("querystring");
var _vibe = require("../lib/index");
var vibe = {};
for (var i in _vibe) {
    vibe[i] = _vibe[i];
}

http.globalAgent.maxSockets = Infinity;

// A factory to create a group of test
var factory = {
    args: parseArgs(process.argv, {
        default: {
            "vibe.transports": "",
            "vibe.extension": "",
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
    this.timeout(20 * 1000);
    
    var host = "http://localhost:8000";
    var uri = host + "/vibe";
    var client = vibe.client();
    
    beforeEach(function() {
        // Override to tell server testee to set up a new server and exclude
        // protocol related options
        var self = this;
        self.sockets = [];
        self._open = client.open;
        client.open = function(uri, options) {
            var params = {transports: [options.transport].join(",")};
            delete options.transport;
            if (options.heartbeat) {
                params.heartbeat = options.heartbeat;
                delete options.heartbeat;
            }
            if (options._heartbeat) {
                params._heartbeat = options._heartbeat;
                delete options._heartbeat;
            }
            http.get(host + "/setup?" + querystring.stringify(params));
            return self._open.apply(this, arguments)
            .on("open", function() {
                self.sockets.push(this);
                var query = url.parse(this.uri, true).query;
                query.transport.should.be.equal(options.transport);
            })
            .on("close", function() {
                self.sockets.splice(self.sockets.indexOf(this), 1);
            });
        };
    });
    afterEach(function() {
        var self = this;
        // To exit node process properly, clean sockets
        self.sockets.forEach(function(socket) {
            socket.close();
        });
        // Restore reference
        client.open = self._open;
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