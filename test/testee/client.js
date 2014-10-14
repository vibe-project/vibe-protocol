var vibe = require("../../lib/index");
var url = require("url");
var http = require("http");

http.globalAgent.maxSockets = Infinity;

var client = vibe.client();
var sockets = [];
http.createServer(function(req, res) {
    var urlObj = url.parse(req.url, true);
    var query = urlObj.query;
    switch (urlObj.pathname) {
    case "/open":
        var socket = client.open(query.uri);
        socket.on("open", function() {
            sockets.push(this.id);
        })
        .on("close", function() {
            sockets.splice(sockets.indexOf(socket.id), 1);
        })
        .on("abort", function() {
            this.close();
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
        res.end("" + (sockets.indexOf(query.id) != -1));
        break;
    }
})
.listen(9000);