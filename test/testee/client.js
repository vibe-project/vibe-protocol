var url = require("url"),
    http = require("http"),
    react = require("../../lib/index");

http.globalAgent.maxSockets = Infinity;

http.createServer(function(req, res) {
    var urlObj = url.parse(req.url, true);
    if (urlObj.pathname === "/open") {
        react.open(urlObj.query.uri, {
            transport: urlObj.query.transport, 
            heartbeat: +urlObj.query.heartbeat || false, 
            _heartbeat: +urlObj.query._heartbeat || false
        })
        .on("abort", function() {
            this.close();
        })
        .on("echo", function(data) {
            this.send("echo", data);
        })
        .on("reaction", function(bool, reply) {
            if (bool) {
                reply.resolve(bool);
            } else {
                reply.reject(bool);
            }
        });
        res.end();
    }
})
.listen(9000);