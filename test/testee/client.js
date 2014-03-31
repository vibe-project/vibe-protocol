var url = require("url"),
    http = require("http"),
    client = require("../../lib/client"),
    sockets = {};

http.globalAgent.maxSockets = Infinity;

http.createServer(function(req, res) {
    var urlObj = url.parse(req.url, true);
    var params = urlObj.query;
    
    switch (urlObj.pathname) {
    case "/open":
        client.open(params.uri, {transport: params.transport, heartbeat: +params.heartbeat || false, _heartbeat: +params._heartbeat || false})
        .on("open", function() {
            sockets[this.id] = this;
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
        break;
    case "/close":
        sockets[params.id].close();
        res.end();
        break;
    default:
        break;
    }
})
.listen(9000);