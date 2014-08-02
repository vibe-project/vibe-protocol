var vibe = require("../../lib/index");
var client = vibe.client();
var url = require("url");
var http = require("http");

http.globalAgent.maxSockets = Infinity;

http.createServer(function(req, res) {
    var urlObj = url.parse(req.url, true);
    switch (urlObj.pathname) {
    case "/open":
        var query = urlObj.query;
        var socket = client.open(query.uri, {transport: query.transport, heartbeat: +query.heartbeat || false, _heartbeat: +query._heartbeat || false});
        // To test protocol
        socket.on("abort", function() {
            this.close();
        })
        .on("echo", function(data) {
            this.send("echo", data);
        });
        
        // To test extension
        // receiving replyable event
        socket.on("rre.resolve", function(data, reply) {
            reply.resolve(data);
        })
        .on("rre.reject", function(data, reply) {
            reply.reject(data);
        });
        // sending replyable event
        socket.on("sre.resolve", function(data) {
            this.send("sre.resolve", data, function(data) {
                this.send("sre.done", data);
            });
        })
        .on("sre.reject", function(data) {
            this.send("sre.reject", data, null, function(data) {
                this.send("sre.done", data);
            });
        });
        res.end();
        break;
    }
})
.listen(9000);