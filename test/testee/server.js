var vibe = require("../../lib/index");
var url = require("url");
var http = require("http");

var server;
var sockets = {};
http.createServer().on("request", function(req, res) {
    var urlObj = url.parse(req.url, true);
    var query = urlObj.query;
    switch (urlObj.pathname) {
    case "/setup":
        var options = {transports: query.transports.split(",")};
        if (query.heartbeat) {
            options.heartbeat = +query.heartbeat;
        }
        if (query._heartbeat) {
            options._heartbeat = +query._heartbeat;
        }
        server = vibe.server(options);
        server.on("socket", function(socket) {
            sockets[socket.id] = true;
            socket.on("close", function() {
                delete sockets[socket.id];
            })
            .on("echo", function(data) {
                socket.send("echo", data);
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
        });
        res.end();
        break;
    case "/alive":
        res.end("" + (query.id in sockets));
        break;
    case "/vibe":
        server.handleRequest(req, res);
        break;
    }
})
.on("upgrade", function(req, sock, head) {
    if (url.parse(req.url).pathname === "/vibe") {
        server.handleUpgrade(req, sock, head);
    }
})
.listen(8000);