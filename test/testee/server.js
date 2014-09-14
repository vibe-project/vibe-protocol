var vibe = require("../../lib/index");
var url = require("url");
var http = require("http");

var server = vibe.server();
var sockets = {};
server.on("socket", function(socket) {
    // Test protocol
    sockets[socket.id] = socket;
    socket.on("close", function() {
        delete sockets[socket.id];
    })
    .on("echo", function(data) {
        socket.send("echo", data);
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
});

http.createServer().on("request", function(req, res) {
    var urlObj = url.parse(req.url, true);
    var query = urlObj.query;
    switch (urlObj.pathname) {
    case "/vibe":
        server.handleRequest(req, res);
        break;
    case "/alive":
        res.end("" + (query.id in sockets));
        break;
    }
})
.on("upgrade", function(req, sock, head) {
    if (url.parse(req.url).pathname === "/vibe") {
        server.handleUpgrade(req, sock, head);
    }
})
.listen(8000);