var vibe = require("../../lib/index");
var client = vibe.client();
var url = require("url");
var http = require("http");

http.globalAgent.maxSockets = Infinity;

var sockets = {};
http.createServer(function(req, res) {
    var urlObj = url.parse(req.url, true);
    var query = urlObj.query;
    switch (urlObj.pathname) {
    case "/open":
        var socket = client.open(query.uri, {transport: query.transport, heartbeat: +query.heartbeat || false, _heartbeat: +query._heartbeat || false});
        // Test protocol
        socket.on("open", function() {
            sockets[this.id] = this;
        })
        .on("close", function() {
            delete sockets[this.id];
        })
        .on("abort", function() {
            this.close();
        })
        .on("echo", function(data) {
            this.send("echo", data);
        });
        
        // Test extension
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
        res.end("" + (query.id in sockets));
        break;
    }
})
.listen(9000);