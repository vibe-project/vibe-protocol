var vibe = require("../../lib/index");
var url = require("url");
var http = require("http");

http.globalAgent.maxSockets = Infinity;

var sockets = {};
http.createServer(function(req, res) {
    var urlObj = url.parse(req.url, true);
    var query = urlObj.query;
    switch (urlObj.pathname) {
    case "/open":
        var socket = vibe.open(query.uri, {transport: query.transport});
        socket.on("error", function() {})
        .on("abort", function() {
            this.close();
        })
        .on("name", function(name) {
            sockets[name] = this;
        })
        .on("echo", function(data) {
            this.send("echo", data);
        });
        // reply
        socket.on("/reply/inbound", function(data, reply) {
            switch (data.type) {
            case "resolved":
                reply.resolve(data.data);
                break;
            case "rejected":
                reply.reject(data.data);
                break;
            }
        })
        .on("/reply/outbound", function(data) {
            switch (data.type) {
            case "resolved":
                this.send("test", data.data, function(data) {
                    this.send("done", data);
                });
                break;
            case "rejected":
                this.send("test", data.data, null, function(data) {
                    this.send("done", data);
                });
                break;
            }
        });
        res.end();
        break;
    case "/alive":
        var alive = query.name in sockets;
        if (alive) {
            delete sockets[query.name];
        }
        res.end("" + alive);
        break;
    }
})
.listen(9000);