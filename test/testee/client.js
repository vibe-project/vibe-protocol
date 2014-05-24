var vibe = require("../../lib/index");
var url = require("url");
var http = require("http");

http.globalAgent.maxSockets = Infinity;

http.createServer(function(req, res) {
    var urlObj = url.parse(req.url, true);
    switch (urlObj.pathname) {
    case "/open":
        var query = urlObj.query;
        vibe.open(query.uri, {transport: query.transport, heartbeat: +query.heartbeat || false, _heartbeat: +query._heartbeat || false})
        .on("abort", function() {
            this.close();
        })
        .on("echo", function(data) {
            this.send("echo", data);
        })
        .on("replyable", function(bool, reply) {
            if (bool) {
                reply.resolve(bool);
            } else {
                reply.reject(bool);
            }
        });
        res.end();
        break;
    }
})
.listen(9000);