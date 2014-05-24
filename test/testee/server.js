var vibe = require("../../lib/index");
var url = require("url");
var http = require("http");

var server = vibe.server();
server.on("socket", function(socket) {
    socket.on("echo", function(data) {
        socket.send("echo", data);
    })
    .on("replyable", function(bool, reply) {
        if (bool) {
            reply.resolve(bool);
        } else {
            reply.reject(bool);
        }
    });
});

http.createServer().on("request", function(req, res) {
    if (url.parse(req.url).pathname === "/vibe") {
        server.handleRequest(req, res);
    }
})
.on("upgrade", function(req, sock, head) {
    if (url.parse(req.url).pathname === "/vibe") {
        server.handleUpgrade(req, sock, head);
    }
})
.listen(8000);